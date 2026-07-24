// CSV 一括登録 API（管理者専用）。
// POST {rows:[{loginId,name,departmentCode?,departmentName?,workplaceCode?,role?,email?}]}（1リクエスト最大200行）
//  - 部署の解決は「部署コード優先」→ コード空欄なら部署名で照合。どちらも不一致なら error
//  - 職場は職場コードで照合（任意）。指定の部署配下でなければ error
//  - 権限は 管理者/admin・一般/member・作業者/worker。空欄なら一般(member)
//  - login_id 重複（DB既存 or 同一バッチ内）はスキップ status:'duplicate'
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
  ["worker", "worker"], ["作業者", "worker"],
]);
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
      const roleRaw = String((r && r.role) || "").trim();
      const email = String((r && r.email) || "").trim();
      const item = {
        loginId, name, departmentCode, departmentName, workplaceCode, email,
        role: "member", status: null, message: null, dept: null, workplace: null,
      };
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
        item.message = "権限は 管理者 / 一般 / 作業者 のいずれかを指定してください";
        return item;
      }
      item.role = role;
      // 職場は任意。指定する場合は上で解決した部署の配下でなければならない
      if (workplaceCode) {
        const wp = wpByCode.get(workplaceCode);
        if (!wp) {
          item.status = "error";
          item.message = "職場が見つかりません";
          return item;
        }
        if (wp.department_id !== dept.id) {
          item.status = "error";
          item.message = `職場「${wp.name}」は部署「${dept.name}」の配下ではありません`;
          return item;
        }
        item.workplace = wp;
      }
      return item;
    });

    // DB 既存の login_id
    const candidateIds = items.filter((it) => !it.status).map((it) => it.loginId);
    let existing = new Set();
    if (candidateIds.length > 0) {
      const found = await sql`SELECT login_id FROM pf_portal_users WHERE login_id = ANY(${candidateIds}::text[])`;
      existing = new Set(found.map((r) => r.login_id));
    }

    // 重複判定（DB既存 + バッチ内重複）
    const seenInBatch = new Set();
    const toInsert = [];
    for (const it of items) {
      if (it.status) continue;
      if (existing.has(it.loginId) || seenInBatch.has(it.loginId)) {
        it.status = "duplicate";
        it.message = "この社員番号（ID）は登録済みのためスキップしました";
        continue;
      }
      seenInBatch.add(it.loginId);
      toInsert.push(it);
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
      const inserted = await sql`
        INSERT INTO pf_portal_users (login_id, name, email, department_id, role, workplace_id)
        SELECT * FROM unnest(
          ${loginIds}::text[],
          ${names}::text[],
          ${emails}::text[],
          ${deptIds}::uuid[],
          ${roles}::text[],
          ${workplaceIds}::uuid[]
        )
        ON CONFLICT (login_id) DO NOTHING
        RETURNING id, login_id, name, email`;
      insertedByLogin = new Map(inserted.map((u) => [u.login_id, u]));
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
      it.userId = u.id;
      it.status = "created";
      // 承認者は職場の管理者を引き継ぐ（管理者本人には承認者を付けない・自分自身も承認者にしない）
      let approverLoginId = it.role === "admin" || !it.workplace ? null : it.workplace.admin_login_id || null;
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
    const provisionResults = await provisionUsers(sql, provisionTargets);

    res.status(200).json({
      rows: items.map((it) => ({
        loginId: it.loginId,
        name: it.name,
        status: it.status,
        message: it.message || undefined,
        apps: it.userId ? provisionResults.get(it.userId) || [] : [],
      })),
    });
  } catch (e) {
    console.error("[users-import]", e);
    res.status(500).json({ message: "サーバーエラーが発生しました" });
  }
};
