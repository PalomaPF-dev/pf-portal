// ユーザー名簿 API（すべて管理セッション専用）。
// GET    一覧（部署・職場・承認者 join + 発行状況 passwordSet 含む）
// POST   {loginId,name,email?,departmentId,role?,workplaceId?,approverUserId?} 1名追加 → 部署アプリへプロビジョニング実行 → 結果返却
// PUT    {id,name?,email?,departmentId?,workplaceId?,role?,approverUserId?,canManage?,managePassword?} 更新 → 再プロビジョニング
//        ※ canManage / managePassword の変更はマスターセッションのみ（設定担当者は不可）
// DELETE {id} 名簿から削除（※各アプリ側のアカウントは削除しない）
const { requireSql, ensureSchema, readBody, isUuid } = require("../lib/db");
const { requireManage, hashManagePassword } = require("../lib/portalAuth");
const { provisionUsers } = require("../lib/provision");

const LOGIN_ID_RE = /^[A-Za-z0-9_@.-]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// 役割は 管理者(admin) / 一般(member) の2種。旧「作業者(worker)」は一般に統一した
// （呼称も一般。旧データ・旧クライアントからの worker は member として扱う）。
const ROLES = ["admin", "member", "worker"];

// DB上のroleを表示用に正規化（未知の値は member 扱い）
function normalizeRole(role) {
  return role === "admin" ? "admin" : "member";
}

// 承認者の解決: 本人の承認者指定 → 職場の管理者（指定） → その職場に所属する管理者権限ユーザー
// （社員番号順で最初）→ null。「職場ごとに管理者が一般ユーザーの承認者になる」規則。
// 管理者本人の承認者は名簿での明示指定のみ（上位者を指すため、職場からの自動割り当てはしない）。
async function resolveApproverLoginId(sql, approverUserId, workplaceId, role) {
  if (approverUserId) {
    const rows = await sql`SELECT login_id FROM pf_portal_users WHERE id = ${approverUserId} LIMIT 1`;
    if (rows.length > 0) return rows[0].login_id;
  }
  if (role === "admin") return null;
  if (workplaceId) {
    const rows = await sql`
      SELECT a.login_id
      FROM pf_portal_workplaces w
      JOIN pf_portal_users a ON a.id = w.admin_user_id
      WHERE w.id = ${workplaceId}
      LIMIT 1`;
    if (rows.length > 0) return rows[0].login_id;
    // 職場の管理者が未指定でも、その職場に所属する管理者を既定の承認者にする
    const fallback = await sql`
      SELECT login_id FROM pf_portal_users
      WHERE workplace_id = ${workplaceId} AND role = 'admin'
      ORDER BY login_id
      LIMIT 1`;
    if (fallback.length > 0) return fallback[0].login_id;
  }
  return null;
}

// role / workplaceId / approverUserId の共通バリデーション。
// OK なら正規化済みの { role, workplaceId, approverUserId } を返し、NG なら res に 400 を書いて null を返す。
async function validateRoleWorkplaceApprover(sql, res, { role, workplaceId, approverUserId, departmentId, selfId }) {
  if (!ROLES.includes(role)) {
    res.status(400).json({ message: "権限は 管理者(admin) / 一般(member) のいずれかを指定してください" });
    return null;
  }
  if (workplaceId) {
    if (!isUuid(workplaceId)) { res.status(400).json({ message: "workplaceId が不正です" }); return null; }
    const rows = await sql`SELECT id, department_id FROM pf_portal_workplaces WHERE id = ${workplaceId} LIMIT 1`;
    if (rows.length === 0) { res.status(400).json({ message: "指定の職場が見つかりません" }); return null; }
    if (departmentId && rows[0].department_id !== departmentId) {
      res.status(400).json({ message: "指定の職場は選択した部署に属していません" });
      return null;
    }
  }
  // 承認者は管理者にも指定できる（管理者本人の申請は上位者へ回すため）。
  // 未指定のときの職場からの自動割り当ては一般ユーザーのみ（resolveApproverLoginId 参照）。
  if (approverUserId) {
    if (!isUuid(approverUserId)) { res.status(400).json({ message: "approverUserId が不正です" }); return null; }
    if (selfId && approverUserId === selfId) {
      res.status(400).json({ message: "自分自身を承認者に設定することはできません" });
      return null;
    }
    const rows = await sql`SELECT role FROM pf_portal_users WHERE id = ${approverUserId} LIMIT 1`;
    if (rows.length === 0 || rows[0].role !== "admin") {
      res.status(400).json({ message: "承認者には管理者権限のユーザーを指定してください" });
      return null;
    }
  }
  return { role, workplaceId: workplaceId || null, approverUserId: approverUserId || null };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 人事プロフィール項目（役職・職務・生年月日・入社年月日・雇用体系）を body から取り出して検証。
 * 生年月日・入社年月日・雇用体系は個人情報のため、この管理者専用APIの外
 * （/api/user・users-refresh・アプリ連携）には出さないこと。年齢は保存せず表示時に計算する。
 * 不正時はレスポンスを書いて null を返す。
 */
function parseProfileFields(body, res) {
  const positionName = String(body.positionName || "").trim();
  const dutyName = String(body.dutyName || "").trim();
  const employmentType = String(body.employmentType || "").trim();
  const birthDate = String(body.birthDate || "").trim();
  const hireDate = String(body.hireDate || "").trim();
  for (const [label, v] of [["役職名称", positionName], ["職務名称", dutyName], ["雇用体系名称", employmentType]]) {
    if (v.length > 100) {
      res.status(400).json({ message: `${label}は100文字以内で入力してください` });
      return null;
    }
  }
  for (const [label, v] of [["生年月日", birthDate], ["入社年月日", hireDate]]) {
    if (v && (!DATE_RE.test(v) || Number.isNaN(Date.parse(v)))) {
      res.status(400).json({ message: `${label}は YYYY-MM-DD 形式で入力してください` });
      return null;
    }
  }
  return {
    positionName: positionName || null,
    dutyName: dutyName || null,
    employmentType: employmentType || null,
    birthDate: birthDate || null,
    hireDate: hireDate || null,
  };
}

module.exports = async (req, res) => {
  const session = requireManage(req, res);
  if (!session) return;
  const sql = requireSql(res);
  if (!sql) return;

  try {
    await ensureSchema(sql);

    if (req.method === "GET") {
      const users = await sql`
        SELECT u.id, u.login_id, u.name, u.email, u.department_id, u.role,
               u.workplace_id, u.approver_user_id, u.can_manage, u.created_at,
               u.position_name, u.duty_name, u.employment_type,
               to_char(u.birth_date, 'YYYY-MM-DD') AS birth_date,
               to_char(u.hire_date, 'YYYY-MM-DD') AS hire_date,
               d.code AS department_code, d.name AS department_name,
               w.code AS workplace_code, w.name AS workplace_name,
               a.name AS approver_name
        FROM pf_portal_users u
        LEFT JOIN pf_portal_departments d ON d.id = u.department_id
        LEFT JOIN pf_portal_workplaces w ON w.id = u.workplace_id
        LEFT JOIN pf_portal_users a ON a.id = u.approver_user_id
        ORDER BY u.created_at DESC`;
      const provisions = await sql`
        SELECT user_id, app_key, status, password_set, updated_at
        FROM pf_portal_provisions`;
      const byUser = new Map();
      for (const p of provisions) {
        if (!byUser.has(p.user_id)) byUser.set(p.user_id, []);
        byUser.get(p.user_id).push({
          app: p.app_key,
          status: p.status,
          // パスワード設定状況（null = 不明）
          passwordSet: typeof p.password_set === "boolean" ? p.password_set : null,
          updatedAt: p.updated_at,
        });
      }
      res.status(200).json(
        users.map((u) => ({
          id: u.id,
          loginId: u.login_id,
          name: u.name,
          email: u.email,
          departmentId: u.department_id,
          departmentCode: u.department_code,
          departmentName: u.department_name,
          role: normalizeRole(u.role),
          workplaceId: u.workplace_id,
          workplaceCode: u.workplace_code,
          workplaceName: u.workplace_name,
          approverUserId: u.approver_user_id,
          approverName: u.approver_name,
          canManage: u.can_manage === true,
          createdAt: u.created_at,
          // 人事プロフィール（この一覧は requireManage 済み＝ポータル管理者のみが受け取る）
          positionName: u.position_name,
          dutyName: u.duty_name,
          birthDate: u.birth_date,
          hireDate: u.hire_date,
          employmentType: u.employment_type,
          provisions: byUser.get(u.id) || [],
        }))
      );
      return;
    }

    if (req.method === "POST") {
      const body = readBody(req);
      const loginId = String(body.loginId || "").trim();
      const name = String(body.name || "").trim();
      const email = String(body.email || "").trim();
      const departmentId = body.departmentId;
      const role = body.role ? String(body.role) : "member";
      const workplaceId = body.workplaceId || null;
      const approverUserId = body.approverUserId || null;

      if (!loginId || !LOGIN_ID_RE.test(loginId) || loginId.length > 64) {
        res.status(400).json({ message: "社員番号（ID）は半角英数字と - _ @ . で入力してください" });
        return;
      }
      if (!name || name.length > 100) {
        res.status(400).json({ message: "ユーザー名は必須です（100文字以内）" });
        return;
      }
      if (email && (!EMAIL_RE.test(email) || email.length > 254)) {
        res.status(400).json({ message: "メールアドレスの形式が正しくありません" });
        return;
      }
      if (!isUuid(departmentId)) {
        res.status(400).json({ message: "部署を選択してください" });
        return;
      }
      const dept = await sql`SELECT id, code, name, kind, apps FROM pf_portal_departments WHERE id = ${departmentId} LIMIT 1`;
      if (dept.length === 0) {
        res.status(400).json({ message: "指定の部署が見つかりません" });
        return;
      }
      const v = await validateRoleWorkplaceApprover(sql, res, { role, workplaceId, approverUserId, departmentId, selfId: null });
      if (!v) return;
      const prof = parseProfileFields(body, res);
      if (!prof) return;
      const dup = await sql`SELECT 1 FROM pf_portal_users WHERE login_id = ${loginId} LIMIT 1`;
      if (dup.length > 0) {
        res.status(409).json({ message: "この社員番号（ID）は登録済みです" });
        return;
      }
      const inserted = await sql`
        INSERT INTO pf_portal_users
          (login_id, name, email, department_id, role, workplace_id, approver_user_id,
           position_name, duty_name, birth_date, hire_date, employment_type)
        VALUES (${loginId}, ${name}, ${email || null}, ${departmentId}, ${v.role}, ${v.workplaceId}, ${v.approverUserId},
                ${prof.positionName}, ${prof.dutyName}, ${prof.birthDate}, ${prof.hireDate}, ${prof.employmentType})
        RETURNING id, login_id, name, email, department_id, role, workplace_id, approver_user_id`;
      const user = inserted[0];

      const apps = Array.isArray(dept[0].apps) ? dept[0].apps : [];
      // 工場所属なら工場名を各アプリへ引き継ぐ（アプリ側でデータ表示を自工場に制限）
      const factory = dept[0].kind === "factory" ? dept[0].name : null;
      // 承認者を login_id に解決（本人指定 → 職場の管理者 → 職場所属の管理者 → なし）。
      let approverLoginId = await resolveApproverLoginId(sql, v.approverUserId, v.workplaceId, v.role);
      if (approverLoginId === user.login_id) approverLoginId = null;
      const results = await provisionUsers(sql, [
        { id: user.id, loginId: user.login_id, name: user.name, email: user.email, apps, factory, role: v.role, approverLoginId },
      ]);

      res.status(201).json({
        ok: true,
        user: {
          id: user.id,
          loginId: user.login_id,
          name: user.name,
          email: user.email,
          departmentId: user.department_id,
          departmentCode: dept[0].code,
          departmentName: dept[0].name,
          role: user.role,
          workplaceId: user.workplace_id,
          approverUserId: user.approver_user_id,
        },
        apps: results.get(user.id) || [],
      });
      return;
    }

    if (req.method === "PUT") {
      const body = readBody(req);
      const id = body.id;
      if (!isUuid(id)) {
        res.status(400).json({ message: "id が不正です" });
        return;
      }
      const cur = await sql`
        SELECT id, login_id, name, email, department_id, role, workplace_id, approver_user_id,
               can_manage, manage_password_hash
        FROM pf_portal_users WHERE id = ${id} LIMIT 1`;
      if (cur.length === 0) {
        res.status(404).json({ message: "対象のユーザーが見つかりません" });
        return;
      }
      const prev = cur[0];
      const name = body.name === undefined ? prev.name : String(body.name || "").trim();
      const email = body.email === undefined ? (prev.email || "") : String(body.email || "").trim();
      const departmentId = body.departmentId === undefined ? prev.department_id : body.departmentId;
      const workplaceId = body.workplaceId === undefined ? prev.workplace_id : (body.workplaceId || null);
      const role = body.role === undefined ? normalizeRole(prev.role) : String(body.role || "");
      const approverUserId = body.approverUserId === undefined ? prev.approver_user_id : (body.approverUserId || null);

      if (!name || name.length > 100) {
        res.status(400).json({ message: "ユーザー名は必須です（100文字以内）" });
        return;
      }
      if (email && (!EMAIL_RE.test(email) || email.length > 254)) {
        res.status(400).json({ message: "メールアドレスの形式が正しくありません" });
        return;
      }
      if (!isUuid(departmentId)) {
        res.status(400).json({ message: "部署を選択してください" });
        return;
      }
      const dept = await sql`SELECT id, code, name, kind, apps FROM pf_portal_departments WHERE id = ${departmentId} LIMIT 1`;
      if (dept.length === 0) {
        res.status(400).json({ message: "指定の部署が見つかりません" });
        return;
      }
      const v = await validateRoleWorkplaceApprover(sql, res, { role, workplaceId, approverUserId, departmentId, selfId: id });
      if (!v) return;

      // ポータル管理権限の付与・管理用パスワードの変更はマスターセッションのみ（サーバー側で強制）
      const wantsManageChange = body.canManage !== undefined || body.managePassword !== undefined;
      if (wantsManageChange && !session.isMaster) {
        res.status(403).json({ message: "ポータル管理権限の変更はマスターログインでのみ可能です" });
        return;
      }
      const canManage = body.canManage === undefined ? prev.can_manage === true : body.canManage === true;
      // 管理用パスワード: 入力があった時のみ scrypt でハッシュ化して更新（can_manage=false でもハッシュは保持）
      let managePasswordHash = null; // null = 変更なし（COALESCE で既存値を保持）
      if (body.managePassword !== undefined && body.managePassword !== null && String(body.managePassword) !== "") {
        const pw = String(body.managePassword);
        if (pw.length < 8) {
          res.status(400).json({ message: "管理用パスワードは8文字以上で入力してください" });
          return;
        }
        managePasswordHash = hashManagePassword(pw);
      }
      if (canManage && !prev.manage_password_hash && !managePasswordHash) {
        res.status(400).json({ message: "ポータル管理権限を付与するには管理用パスワード（8文字以上）を設定してください" });
        return;
      }

      const prof = parseProfileFields(body, res);
      if (!prof) return;
      const updated = await sql`
        UPDATE pf_portal_users
        SET name = ${name}, email = ${email || null}, department_id = ${departmentId},
            role = ${v.role}, workplace_id = ${v.workplaceId}, approver_user_id = ${v.approverUserId},
            can_manage = ${canManage},
            manage_password_hash = COALESCE(${managePasswordHash}, manage_password_hash),
            position_name = ${prof.positionName}, duty_name = ${prof.dutyName},
            birth_date = ${prof.birthDate}, hire_date = ${prof.hireDate},
            employment_type = ${prof.employmentType}
        WHERE id = ${id}
        RETURNING id, login_id, name, email, department_id, role, workplace_id, approver_user_id, can_manage`;
      const user = updated[0];

      // 更新後の内容で再プロビジョニング（POST と同じフロー。権限・承認者の変更を各アプリへ反映）
      const apps = Array.isArray(dept[0].apps) ? dept[0].apps : [];
      const factory = dept[0].kind === "factory" ? dept[0].name : null;
      let approverLoginId = await resolveApproverLoginId(sql, v.approverUserId, v.workplaceId, v.role);
      if (approverLoginId === user.login_id) approverLoginId = null;
      const results = await provisionUsers(sql, [
        { id: user.id, loginId: user.login_id, name: user.name, email: user.email, apps, factory, role: v.role, approverLoginId },
      ]);

      res.status(200).json({
        ok: true,
        user: {
          id: user.id,
          loginId: user.login_id,
          name: user.name,
          email: user.email,
          departmentId: user.department_id,
          departmentCode: dept[0].code,
          departmentName: dept[0].name,
          role: user.role,
          workplaceId: user.workplace_id,
          approverUserId: user.approver_user_id,
          canManage: user.can_manage === true,
        },
        apps: results.get(user.id) || [],
      });
      return;
    }

    if (req.method === "DELETE") {
      const body = readBody(req);
      const id = body.id || (req.query && req.query.id);
      if (!isUuid(id)) {
        res.status(400).json({ message: "id が不正です" });
        return;
      }
      // FK なしの参照列をアプリ側で NULL 化（承認者・職場管理者に指定されていた場合）
      await sql`UPDATE pf_portal_users SET approver_user_id = NULL WHERE approver_user_id = ${id}`;
      await sql`UPDATE pf_portal_workplaces SET admin_user_id = NULL WHERE admin_user_id = ${id}`;
      await sql`DELETE FROM pf_portal_users WHERE id = ${id}`;
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ message: "Method not allowed" });
  } catch (e) {
    console.error("[users]", e);
    res.status(500).json({ message: "サーバーエラーが発生しました" });
  }
};
