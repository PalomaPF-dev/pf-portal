// 管理セッション確認。GET → 有効なら {ok:true, kind:'master'|'manager', loginId?}。
// cookie の署名だけでなく DB の can_manage（ポータル管理権限）も毎回確認する。
// 承認フロー上の管理者権限（role='admin'）では管理画面に入れない。
const { requireSql, ensureSchema } = require("../lib/db");
const { requireManageSession } = require("../lib/portalAuth");

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ message: "Method not allowed" });
    return;
  }
  const sql = requireSql(res);
  if (!sql) return;
  try {
    await ensureSchema(sql);
  } catch (e) {
    console.error("[admin-session] ensureSchema", e);
    res.status(503).json({ message: "サーバーエラーが発生しました（データベース）" });
    return;
  }
  const session = await requireManageSession(req, res, sql);
  if (!session) return;
  res.status(200).json({
    ok: true,
    kind: session.isMaster ? "master" : "manager",
    loginId: session.loginId || undefined,
  });
};
