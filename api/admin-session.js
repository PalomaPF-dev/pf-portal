// 管理者セッション確認。GET → 有効なら {ok:true}。
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
  if (!verifySession(req)) {
    res.status(401).json({ message: "管理者ログインが必要です" });
    return;
  }
  res.status(200).json({ ok: true });
};
