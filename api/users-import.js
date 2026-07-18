// CSV 一括登録 API（管理者専用）。
// POST {rows:[{loginId,name,departmentCode?,departmentName?,email?}]}（1リクエスト最大200行）
//  - 職場の解決は「職場コード優先」→ コード空欄なら職場名で照合。どちらも不一致なら error
//  - login_id 重複（DB既存 or 同一バッチ内）はスキップ status:'duplicate'
//  - 新規は INSERT → プロビジョニング（アプリごとにまとめて1リクエスト）
// レスポンス: { rows: [{loginId,name,status,message?,apps:[{app,status,inviteUrl}]}] }
const { requireSql, ensureSchema, readBody } = require("../lib/db");
const { requireManage } = require("../lib/portalAuth");
const { provisionUsers } = require("../lib/provision");

const MAX_ROWS = 200;
const LOGIN_ID_RE = /^[A-Za-z0-9_@.-]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

    const departments = await sql`SELECT id, code, name, apps FROM pf_portal_departments`;
    const deptByCode = new Map(departments.filter((d) => d.code).map((d) => [String(d.code), d]));
    const deptByName = new Map(departments.map((d) => [d.name, d]));

    // 入力の正規化と行単位バリデーション
    const items = rows.map((r) => {
      const loginId = String((r && r.loginId) || "").trim();
      const name = String((r && r.name) || "").trim();
      const departmentCode = String((r && r.departmentCode) || "").trim();
      const departmentName = String((r && r.departmentName) || "").trim();
      const email = String((r && r.email) || "").trim();
      const item = { loginId, name, departmentCode, departmentName, email, status: null, message: null, dept: null };
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
      // 職場コード優先で照合、コード空欄なら職場名で照合
      const dept = departmentCode ? deptByCode.get(departmentCode) : departmentName ? deptByName.get(departmentName) : null;
      if (!dept) {
        item.status = "error";
        item.message = "職場が見つかりません";
        return item;
      }
      item.dept = dept;
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
      const inserted = await sql`
        INSERT INTO pf_portal_users (login_id, name, email, department_id)
        SELECT * FROM unnest(
          ${loginIds}::text[],
          ${names}::text[],
          ${emails}::text[],
          ${deptIds}::uuid[]
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
      provisionTargets.push({
        id: u.id,
        loginId: u.login_id,
        name: u.name,
        email: u.email,
        apps: Array.isArray(it.dept.apps) ? it.dept.apps : [],
        factory: it.dept.kind === "factory" ? it.dept.name : null,
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
