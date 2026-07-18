// 管理セッション確認。GET → 有効なら {ok:true, kind:'master'|'manager', loginId?}。
const { getSecret, verifySession } = require("../lib/portalAuth");

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ message: "Method not allowed" });
    return;
  }
  if (!getSecret()) {
    res.status(503).json({ message: "サーバー設定が未完了です（PORTAL_SESSION_SECRET）" });
    return;
  }
  const session = verifySession(req);
  if (!session) {
    res.status(401).json({ message: "管理者ログインが必要です" });
    return;
  }
  res.status(200).json({
    ok: true,
    kind: session.isMaster ? "master" : "manager",
    loginId: session.loginId || undefined,
  });
};
