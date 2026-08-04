// 発行状況の更新 API（管理セッション専用）。
// POST {id} → 対象ユーザー1名を部署アプリへ再プロビジョニングし、最新の発行状況
// [{app,status,inviteUrl,passwordSet}] を返す（pf_portal_provisions も更新される）。
// ユーザー行の「状況更新」ボタンから使用。フィールドは何も変更しない。
const { requireSql, ensureSchema, readBody, isUuid } = require("../lib/db");
const { requireManage } = require("../lib/portalAuth");
const { provisionUsers } = require("../lib/provision");

// 承認者の解決: 本人の承認者指定 → 職場の管理者（指定） → 職場所属の管理者（社員番号順で最初）
// （api/users.js と同じ規則。管理者は明示指定のみ）。
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
    const fallback = await sql`
      SELECT login_id FROM pf_portal_users
      WHERE workplace_id = ${workplaceId} AND role = 'admin'
      ORDER BY login_id
      LIMIT 1`;
    if (fallback.length > 0) return fallback[0].login_id;
  }
  return null;
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
    const id = body.id;
    if (!isUuid(id)) {
      res.status(400).json({ message: "id が不正です" });
      return;
    }
    const rows = await sql`
      SELECT u.id, u.login_id, u.name, u.email, u.role, u.workplace_id, u.approver_user_id,
             d.name AS department_name, d.kind AS department_kind, d.apps AS department_apps
      FROM pf_portal_users u
      LEFT JOIN pf_portal_departments d ON d.id = u.department_id
      WHERE u.id = ${id} LIMIT 1`;
    if (rows.length === 0) {
      res.status(404).json({ message: "対象のユーザーが見つかりません" });
      return;
    }
    const u = rows[0];
    const apps = Array.isArray(u.department_apps) ? u.department_apps : [];
    const factory = u.department_kind === "factory" ? u.department_name : null;
    const role = u.role === "admin" ? "admin" : "member";
    let approverLoginId = await resolveApproverLoginId(sql, u.approver_user_id, u.workplace_id, role);
    if (approverLoginId === u.login_id) approverLoginId = null;

    const results = await provisionUsers(sql, [
      { id: u.id, loginId: u.login_id, name: u.name, email: u.email, apps, factory, role, approverLoginId },
    ]);

    res.status(200).json({ ok: true, apps: results.get(u.id) || [] });
  } catch (e) {
    console.error("[users-refresh]", e);
    res.status(500).json({ message: "サーバーエラーが発生しました" });
  }
};
