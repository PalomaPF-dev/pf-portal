// ユーザー名簿 API（すべて管理者専用）。
// GET    一覧（職場コード・職場名 join + 発行状況）
// POST   {loginId,name,email?,departmentId} 1名追加 → 職場アプリへプロビジョニング実行 → 結果返却
// DELETE {id} 名簿から削除（※各アプリ側のアカウントは削除しない）
const { requireSql, ensureSchema, readBody, isUuid } = require("../lib/db");
const { requireAdmin } = require("../lib/portalAuth");
const { provisionUsers } = require("../lib/provision");

const LOGIN_ID_RE = /^[A-Za-z0-9_@.-]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const sql = requireSql(res);
  if (!sql) return;

  try {
    await ensureSchema(sql);

    if (req.method === "GET") {
      const users = await sql`
        SELECT u.id, u.login_id, u.name, u.email, u.department_id, u.created_at,
               d.code AS department_code, d.name AS department_name
        FROM pf_portal_users u
        LEFT JOIN pf_portal_departments d ON d.id = u.department_id
        ORDER BY u.created_at DESC`;
      const provisions = await sql`
        SELECT user_id, app_key, status, invite_url, updated_at
        FROM pf_portal_provisions`;
      const byUser = new Map();
      for (const p of provisions) {
        if (!byUser.has(p.user_id)) byUser.set(p.user_id, []);
        byUser.get(p.user_id).push({ app: p.app_key, status: p.status, inviteUrl: p.invite_url, updatedAt: p.updated_at });
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
          createdAt: u.created_at,
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
        res.status(400).json({ message: "職場を選択してください" });
        return;
      }
      const dept = await sql`SELECT id, code, name, apps FROM pf_portal_departments WHERE id = ${departmentId} LIMIT 1`;
      if (dept.length === 0) {
        res.status(400).json({ message: "指定の職場が見つかりません" });
        return;
      }
      const dup = await sql`SELECT 1 FROM pf_portal_users WHERE login_id = ${loginId} LIMIT 1`;
      if (dup.length > 0) {
        res.status(409).json({ message: "この社員番号（ID）は登録済みです" });
        return;
      }
      const inserted = await sql`
        INSERT INTO pf_portal_users (login_id, name, email, department_id)
        VALUES (${loginId}, ${name}, ${email || null}, ${departmentId})
        RETURNING id, login_id, name, email, department_id`;
      const user = inserted[0];

      const apps = Array.isArray(dept[0].apps) ? dept[0].apps : [];
      // 工場所属なら工場名を各アプリへ引き継ぐ（アプリ側でデータ表示を自工場に制限）
      const factory = dept[0].kind === "factory" ? dept[0].name : null;
      const results = await provisionUsers(sql, [
        { id: user.id, loginId: user.login_id, name: user.name, email: user.email, apps, factory },
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
