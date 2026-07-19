// 利用者セッション確認。GET → pf_user cookie を検証し、DBを再照会して
// {ok, loginId, name, departmentId, departmentName, workplaceName, apps} を返す。無効なら 401。
const { requireSql, ensureSchema } = require("../lib/db");
const { getSecret, verifyUserSession, clearUserSessionCookie } = require("../lib/portalAuth");
const { fetchUserProfile, profileResponse } = require("../lib/userProfile");

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ message: "Method not allowed" });
    return;
  }
  if (!getSecret()) {
    res.status(503).json({ message: "サーバー設定が未完了です（PORTAL_SESSION_SECRET）" });
    return;
  }
  const session = verifyUserSession(req);
  if (!session) {
    res.status(401).json({ message: "ログインが必要です" });
    return;
  }
  const sql = requireSql(res);
  if (!sql) return;
  try {
    await ensureSchema(sql);
    const profile = await fetchUserProfile(sql, session.loginId);
    if (!profile) {
      // 名簿から削除済みなど。cookie を破棄して再ログインへ。
      clearUserSessionCookie(res);
      res.status(401).json({ message: "ログインが必要です" });
      return;
    }
    res.status(200).json(profileResponse(profile));
  } catch (e) {
    console.error("[user-session]", e);
    res.status(500).json({ message: "サーバーエラーが発生しました" });
  }
};
