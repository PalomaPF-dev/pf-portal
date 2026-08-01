// 利用者プロフィール取得（api/user-login・api/user-session・api/launch 共用）。
// login_id からユーザー + 所属部署（apps）+ 職場名を1クエリで引く。
const { ALL_APP_KEYS } = require("./db");

// 見つかれば内部表現（passwordHash 含む）を返し、なければ null。
async function fetchUserProfile(sql, loginId) {
  const rows = await sql`
    SELECT u.id, u.login_id, u.name, u.password_hash, u.department_id, u.role,
           d.name AS department_name, d.apps AS department_apps,
           w.name AS workplace_name
    FROM pf_portal_users u
    LEFT JOIN pf_portal_departments d ON d.id = u.department_id
    LEFT JOIN pf_portal_workplaces w ON w.id = u.workplace_id
    WHERE u.login_id = ${loginId}
    LIMIT 1`;
  if (rows.length === 0) return null;
  const u = rows[0];
  const raw = Array.isArray(u.department_apps) ? u.department_apps : [];
  const apps = u.department_id ? raw.filter((k) => ALL_APP_KEYS.includes(k)) : [];
  return {
    id: u.id,
    loginId: u.login_id,
    name: u.name,
    passwordHash: u.password_hash || null,
    // ポータル上の権限（'admin' | 'member'）。SSOトークンで各アプリへ引き継ぐ。
    role: u.role === "admin" ? "admin" : "member",
    departmentId: u.department_id || null,
    departmentName: u.department_id ? u.department_name || null : null,
    workplaceName: u.workplace_name || null,
    apps,
    noDepartment: !u.department_id,
  };
}

// API レスポンス形（passwordHash 等の内部情報は含めない）。
function profileResponse(profile) {
  const out = {
    ok: true,
    loginId: profile.loginId,
    name: profile.name,
    departmentId: profile.departmentId,
    departmentName: profile.departmentName,
    workplaceName: profile.workplaceName,
    apps: profile.apps,
  };
  if (profile.noDepartment) out.noDepartment = true;
  return out;
}

module.exports = { fetchUserProfile, profileResponse };
