// CSV 一括登録 API（管理者専用）。
// POST {rows:[{loginId,name,departmentCode?,departmentName?,workplaceCode?,workplaceName?,role?,email?,
//              approverLoginId?,positionName?,dutyName?,birthDate?,hireDate?,employmentType?}]}
//      （1リクエスト最大200行）
//  - 部署の解決は「部署コード優先」→ コード空欄なら部署名で照合。どちらも不一致なら error
//  - 職場は職場コードで照合（任意）。未登録のコードでも職場名があれば部署配下に自動作成する
//    （名簿CSVからの一括展開用）。登録済みコードが別部署配下なら error
//  - 権限は 管理者/admin・一般/member。空欄なら一般(member)。旧「作業者/worker」は一般として取り込む
//  - login_id が DB 既存の場合は、人事プロフィール項目（役職・職務・生年月日・入社年月日・雇用体系）
//    だけを更新して status:'updated'（部署・職場・権限・アカウントは変更しない）。あわせて DB の
//    現在値でアプリへ再連携する（承認者＝職場の管理者の変更を行き渡らせるため）。
//    同一バッチ内の重複は status:'duplicate'
//  - 承認者は 名簿の承認者社員番号（approverLoginId）→ 職場の管理者（指定）→ 職場に所属する管理者
//    （社員番号順で最初）の順で解決。管理者本人の承認者は名簿での明示指定のみ。
//    承認者は同じリクエスト内で登録した人も対象（INSERT 後に解決する）。前のチャンクにいない
//    承認者は解決できないため、クライアントは取り込み後に /api/users-approvers で再設定する
//  - 生年月日・入社年月日・雇用体系は個人情報。管理者専用APIの外には出さないこと（年齢は保存しない）
//  - 新規は INSERT → プロビジョニング（アプリごとにまとめて1リクエスト）
// レスポンス: { rows: [{loginId,name,status,message?,apps:[{app,status,inviteUrl}]}] }
const { requireSql, ensureSchema, readBody } = require("../lib/db");
const { requireManage } = require("../lib/portalAuth");
const { provisionUsers } = require("../lib/provision");

const MAX_ROWS = 200;
const LOGIN_ID_RE = /^[A-Za-z0-9_@.-]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// CSV の権限表記をDB上の role に正規化。日本語表記・英語表記の両方を受け付ける。
// 空欄は一般(member)。未知の値は null を返し、呼び出し側で error にする。
const ROLE_ALIASES = new Map([
  ["", "member"],
  ["admin", "admin"], ["管理者", "admin"], ["管理", "admin"],
  ["member", "member"], ["一般", "member"], ["一般ユーザー", "member"], ["利用者", "member"],
  ["worker", "member"], ["作業者", "member"],
]);
// 日付の正規化: YYYY-MM-DD / YYYY/M/D を受け付けて ISO (YYYY-MM-DD) へ。空は null。不正は undefined。
function normalizeDate(raw) {
  const v = String(raw || "").trim();
  if (!v) return null;
  const m = v.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
  if (!m) return undefined;
  const iso = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  return Number.isNaN(Date.parse(iso)) ? undefined : iso;
}

function normalizeRole(raw) {
  return ROLE_ALIASES.get(String(raw || "").trim().toLowerCase()) ||
    ROLE_ALIASES.get(String(raw || "").trim()) || null;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ message: "Method not allowed" });
    return;
  }
  if (!requireManage(req, res)) return;
  const sql = requireSql(res);
  if (!sql) return;

  try {
    await ensureSchema(sql);

    const body = readBody(req);
    const rows = Array.isArray(body.rows) ? body.rows : null;
    if (!rows || rows.length === 0) {
      res.status(400).json({ message: "rows が空です" });
      return;
    }
    if (rows.length > MAX_ROWS) {
      res.status(400).json({ message: `1リクエストの最大行数は${MAX_ROWS}行です` });
      return;
    }

    // kind は工場所属の判定に使う（工場ならアプリ側へ工場名を引き継ぎ、表示を自工場に制限する）
    const departments = await sql`SELECT id, code, name, kind, apps FROM pf_portal_departments`;
    const deptByCode = new Map(departments.filter((d) => d.code).map((d) => [String(d.code), d]));
    const deptByName = new Map(departments.map((d) => [d.name, d]));
    // 職場（コードは全体で一意）。承認者が未指定のときは職場の管理者を引き継ぐため login_id も取る。
    const workplaces = await sql`
      SELECT w.id, w.code, w.name, w.department_id, w.admin_user_id, a.login_id AS admin_login_id
      FROM pf_portal_workplaces w
      LEFT JOIN pf_portal_users a ON a.id = w.admin_user_id`;
    const wpByCode = new Map(workplaces.map((w) => [String(w.code), w]));

    // 入力の正規化と行単位バリデーション
    const items = rows.map((r) => {
      const loginId = String((r && r.loginId) || "").trim();
      const name = String((r && r.name) || "").trim();
      const departmentCode = String((r && r.departmentCode) || "").trim();
      const departmentName = String((r && r.departmentName) || "").trim();
      const workplaceCode = String((r && r.workplaceCode) || "").trim();
      const workplaceName = String((r && r.workplaceName) || "").trim();
      const roleRaw = String((r && r.role) || "").trim();
      const email = String((r && r.email) || "").trim();
      // 承認者（名簿の「管理者」列）。自分自身の指定は「指定なし」として扱う
      let approverLoginId = String((r && r.approverLoginId) || "").trim();
      if (approverLoginId === loginId || !LOGIN_ID_RE.test(approverLoginId)) approverLoginId = "";
      const positionName = String((r && r.positionName) || "").trim().slice(0, 100) || null;
      const dutyName = String((r && r.dutyName) || "").trim().slice(0, 100) || null;
      const employmentType = String((r && r.employmentType) || "").trim().slice(0, 100) || null;
      const birthDate = normalizeDate(r && r.birthDate);
      const hireDate = normalizeDate(r && r.hireDate);
      const item = {
        loginId, name, departmentCode, departmentName, workplaceCode, workplaceName, email, approverLoginId,
        positionName, dutyName, employmentType, birthDate, hireDate,
        role: "member", status: null, message: null, dept: null, workplace: null,
      };
      if (birthDate === undefined || hireDate === undefined) {
        item.status = "error";
        item.message = "生年月日・入社年月日は YYYY-MM-DD（または YYYY/M/D）形式で入力してください";
        return item;
      }
      if (!loginId || !LOGIN_ID_RE.test(loginId) || loginId.length > 64) {
        item.status = "error";
        item.message = "社員番号（ID）が不正です（半角英数字と - _ @ . ）";
        return item;
      }
      if (!name || name.length > 100) {
        item.status = "error";
        item.message = "ユーザー名が未入力です";
        return item;
      }
      if (email && (!EMAIL_RE.test(email) || email.length > 254)) {
        item.status = "error";
        item.message = "メールアドレスの形式が正しくありません";
        return item;
      }
      // 部署コード優先で照合、コード空欄なら部署名で照合
      const dept = departmentCode ? deptByCode.get(departmentCode) : departmentName ? deptByName.get(departmentName) : null;
      if (!dept) {
        item.status = "error";
        item.message = "部署が見つかりません";
        return item;
      }
      item.dept = dept;
      const role = normalizeRole(roleRaw);
      if (!role) {
        item.status = "error";
        item.message = "権限は 管理者 / 一般 のいずれかを指定してください";
        return item;
      }
      item.role = role;
      // 職場は任意。指定する場合は上で解決した部署の配下でなければならない
      if (workplaceCode) {
        const wp = wpByCode.get(workplaceCode);
        if (!wp) {
          // 未登録の職場コード: 職場名があれば部署配下に自動作成（後段でまとめて INSERT）
          if (!workplaceName) {
            item.status = "error";
            item.message = "職場が見つかりません（職場名の列があれば自動作成します）";
            return item;
          }
          item.createWorkplace = true;
        } else {
          if (wp.department_id !== dept.id) {
            item.status = "error";
            item.message = `職場「${wp.name}」は部署「${dept.name}」の配下ではありません`;
            return item;
          }
          item.workplace = wp;
        }
      }
      return item;
    });

    // 未登録の職場をまとめて自動作成（コードはグローバル一意。バッチ内の同一コードは1件に集約）
    const wpToCreate = new Map();
    for (const it of items) {
      if (it.status || !it.createWorkplace) continue;
      const cur = wpToCreate.get(it.workplaceCode);
      if (cur && cur.departmentId !== it.dept.id) {
        it.status = "error";
        it.message = `職場コード「${it.workplaceCode}」がバッチ内で複数の部署に割り当てられています`;
        continue;
      }
      if (!cur) wpToCreate.set(it.workplaceCode, { code: it.workplaceCode, name: it.workplaceName, departmentId: it.dept.id });
    }
    if (wpToCreate.size > 0) {
      const defs = Array.from(wpToCreate.values());
      const createdWps = await sql`
        INSERT INTO pf_portal_workplaces (code, name, department_id)
        SELECT * FROM unnest(
          ${defs.map((w) => w.code)}::text[],
          ${defs.map((w) => w.name)}::text[],
          ${defs.map((w) => w.departmentId)}::uuid[]
        )
        ON CONFLICT (code) DO NOTHING
        RETURNING id, code, name, department_id`;
      for (const w of createdWps) {
        wpByCode.set(String(w.code), { ...w, admin_user_id: null, admin_login_id: null });
      }
      for (const it of items) {
        if (it.status || !it.createWorkplace) continue;
        const wp = wpByCode.get(it.workplaceCode);
        if (!wp || wp.department_id !== it.dept.id) {
          it.status = "error";
          it.message = "職場の自動作成に失敗しました（同じ職場コードが別部署で登録済みの可能性）";
          continue;
        }
        it.workplace = wp;
      }
    }

    // DB 既存の login_id
    const candidateIds = items.filter((it) => !it.status).map((it) => it.loginId);
    let existing = new Set();
    if (candidateIds.length > 0) {
      const found = await sql`SELECT login_id FROM pf_portal_users WHERE login_id = ANY(${candidateIds}::text[])`;
      existing = new Set(found.map((r) => r.login_id));
    }

    // 振り分け: DB既存 → 人事プロフィール項目のみ更新 / バッチ内重複 → スキップ
    const seenInBatch = new Set();
    const toInsert = [];
    const toUpdate = [];
    for (const it of items) {
      if (it.status) continue;
      if (seenInBatch.has(it.loginId)) {
        it.status = "duplicate";
        it.message = "この社員番号（ID）はこのCSV内で重複しているためスキップしました";
        continue;
      }
      seenInBatch.add(it.loginId);
      if (existing.has(it.loginId)) {
        toUpdate.push(it);
        continue;
      }
      toInsert.push(it);
    }

    // 既存ユーザー: 人事プロフィール項目だけを更新（空欄は既存値を保持。部署・権限・アカウントは変更しない）
    for (const it of toUpdate) {
      await sql`
        UPDATE pf_portal_users
        SET position_name   = COALESCE(${it.positionName}, position_name),
            duty_name       = COALESCE(${it.dutyName}, duty_name),
            birth_date      = COALESCE(${it.birthDate}, birth_date),
            hire_date       = COALESCE(${it.hireDate}, hire_date),
            employment_type = COALESCE(${it.employmentType}, employment_type)
        WHERE login_id = ${it.loginId}`;
      it.status = "updated";
      it.message = "登録済みのため人事項目を更新し、アプリへ再連携しました（部署・権限・アカウントは変更していません）";
    }

    // 新規をまとめて INSERT
    let insertedByLogin = new Map();
    if (toInsert.length > 0) {
      const loginIds = toInsert.map((it) => it.loginId);
      const names = toInsert.map((it) => it.name);
      const emails = toInsert.map((it) => it.email || null);
      const deptIds = toInsert.map((it) => it.dept.id);
      const roles = toInsert.map((it) => it.role);
      const workplaceIds = toInsert.map((it) => (it.workplace ? it.workplace.id : null));
      const positions = toInsert.map((it) => it.positionName);
      const duties = toInsert.map((it) => it.dutyName);
      const births = toInsert.map((it) => it.birthDate);
      const hires = toInsert.map((it) => it.hireDate);
      const employments = toInsert.map((it) => it.employmentType);
      const inserted = await sql`
        INSERT INTO pf_portal_users
          (login_id, name, email, department_id, role, workplace_id,
           position_name, duty_name, birth_date, hire_date, employment_type)
        SELECT * FROM unnest(
          ${loginIds}::text[],
          ${names}::text[],
          ${emails}::text[],
          ${deptIds}::uuid[],
          ${roles}::text[],
          ${workplaceIds}::uuid[],
          ${positions}::text[],
          ${duties}::text[],
          ${births}::date[],
          ${hires}::date[],
          ${employments}::text[]
        )
        ON CONFLICT (login_id) DO NOTHING
        RETURNING id, login_id, name, email`;
      insertedByLogin = new Map(inserted.map((u) => [u.login_id, u]));
    }

    // 職場の管理者が未指定の職場は、その職場に所属する管理者権限ユーザー（社員番号順で最初）が
    // 既定の承認者になる。INSERT 後に引くことで、同じCSVで登録した管理者も対象に含める。
    const wpAdmins = await sql`
      SELECT DISTINCT ON (workplace_id) workplace_id, login_id
      FROM pf_portal_users
      WHERE role = 'admin' AND workplace_id IS NOT NULL
      ORDER BY workplace_id, login_id`;
    const wpAdminByWpId = new Map(wpAdmins.map((r) => [r.workplace_id, r.login_id]));

    // ===== 名簿の承認者（「管理者」列）を解決して保存する =====
    // INSERT 後に引くため、同じリクエストで登録した管理者も承認者にできる。
    // 承認者が見つからない／一般権限の行は、その行だけ承認者未設定とし理由をメッセージに載せる。
    for (const it of toInsert) {
      const u = insertedByLogin.get(it.loginId);
      if (u) { it.userId = u.id; it.status = "created"; }
    }
    const needApprover = items.filter((it) => it.approverLoginId && (it.status === "created" || it.status === "updated"));
    const approverByLogin = new Map();
    if (needApprover.length > 0) {
      const logins = Array.from(new Set(needApprover.map((it) => it.approverLoginId)));
      const found = await sql`SELECT id, login_id, role FROM pf_portal_users WHERE login_id = ANY(${logins}::text[])`;
      for (const a of found) approverByLogin.set(a.login_id, a);
    }
    const apvTargets = [], apvValues = [];
    for (const it of needApprover) {
      const a = approverByLogin.get(it.approverLoginId);
      if (!a) {
        it.approverNote = `承認者（社員番号 ${it.approverLoginId}）が名簿にないため未設定です`;
        continue;
      }
      if (a.role !== "admin") {
        it.approverNote = `承認者（社員番号 ${it.approverLoginId}）が一般権限のため未設定です`;
        continue;
      }
      it.approverUserId = a.id;
      it.approverResolved = a.login_id;
      apvTargets.push(it.loginId);
      apvValues.push(a.id);
    }
    if (apvTargets.length > 0) {
      await sql`
        UPDATE pf_portal_users u
        SET approver_user_id = v.approver_id
        FROM unnest(${apvTargets}::text[], ${apvValues}::uuid[]) AS v(login_id, approver_id)
        WHERE u.login_id = v.login_id`;
    }

    // プロビジョニング（アプリごとにまとめて実行）
    const provisionTargets = [];
    for (const it of toInsert) {
      const u = insertedByLogin.get(it.loginId);
      if (!u) {
        it.status = "duplicate";
        it.message = "この社員番号（ID）は登録済みのためスキップしました";
        continue;
      }
      // 承認者は 名簿の指定 → 職場の管理者 → 職場所属の管理者 の順
      // （管理者は名簿の指定のみ・自分自身は承認者にしない）
      let approverLoginId = it.approverResolved
        || (it.role === "admin" || !it.workplace
          ? null
          : it.workplace.admin_login_id || wpAdminByWpId.get(it.workplace.id) || null);
      if (approverLoginId === u.login_id) approverLoginId = null;
      provisionTargets.push({
        id: u.id,
        loginId: u.login_id,
        name: u.name,
        email: u.email,
        apps: Array.isArray(it.dept.apps) ? it.dept.apps : [],
        // 工場所属なら工場名を各アプリへ引き継ぐ（アプリ側でデータ表示を自工場に制限）
        factory: it.dept.kind === "factory" ? it.dept.name : null,
        role: it.role,
        approverLoginId,
      });
    }

    // 既存ユーザーも DB 上の現在値（部署・職場・権限・承認者）でアプリへ再連携する。
    // 後から管理者を含むCSVを取り込み直したときに、一般ユーザーの承認者が各アプリへ行き渡るようにするため。
    if (toUpdate.length > 0) {
      const updateLoginIds = toUpdate.filter((it) => it.status === "updated").map((it) => it.loginId);
      const cur = updateLoginIds.length > 0 ? await sql`
        SELECT u.id, u.login_id, u.name, u.email, u.role, u.workplace_id,
               ap.login_id AS approver_login_id,
               w.admin_user_id, wa.login_id AS wp_admin_login_id,
               d.name AS department_name, d.kind AS department_kind, d.apps AS department_apps
        FROM pf_portal_users u
        LEFT JOIN pf_portal_users ap ON ap.id = u.approver_user_id
        LEFT JOIN pf_portal_workplaces w ON w.id = u.workplace_id
        LEFT JOIN pf_portal_users wa ON wa.id = w.admin_user_id
        LEFT JOIN pf_portal_departments d ON d.id = u.department_id
        WHERE u.login_id = ANY(${updateLoginIds}::text[])` : [];
      const itByLogin = new Map(toUpdate.map((it) => [it.loginId, it]));
      for (const u of cur) {
        const it = itByLogin.get(u.login_id);
        if (!it) continue;
        it.userId = u.id;
        const role = u.role === "admin" ? "admin" : "member";
        let approverLoginId = it.approverResolved || (role === "admin"
          ? u.approver_login_id || null
          : u.approver_login_id || u.wp_admin_login_id || wpAdminByWpId.get(u.workplace_id) || null);
        if (approverLoginId === u.login_id) approverLoginId = null;
        provisionTargets.push({
          id: u.id,
          loginId: u.login_id,
          name: u.name,
          email: u.email,
          apps: Array.isArray(u.department_apps) ? u.department_apps : [],
          factory: u.department_kind === "factory" ? u.department_name : null,
          role,
          approverLoginId,
        });
      }
    }
    const provisionResults = await provisionUsers(sql, provisionTargets);

    res.status(200).json({
      rows: items.map((it) => ({
        loginId: it.loginId,
        name: it.name,
        status: it.status,
        message: [it.message, it.approverNote].filter(Boolean).join(" / ") || undefined,
        // 承認者が解決できたかをクライアントへ返す（後段の /api/users-approvers の対象判定に使う）
        approverSet: it.approverResolved ? true : undefined,
        apps: it.userId ? provisionResults.get(it.userId) || [] : [],
      })),
    });
  } catch (e) {
    console.error("[users-import]", e);
    res.status(500).json({ message: "サーバーエラーが発生しました" });
  }
};
