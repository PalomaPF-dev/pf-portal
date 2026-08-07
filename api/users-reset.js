// ユーザーの一括削除（名簿のやり直し用・管理セッション専用）。
//
// 1件ずつ削除ボタンを押していくと1,600名を超えるため用意した。
//
// POST { keepLoginIds?: string[], confirm?: "削除" }
//   confirm 無し … 下見だけ返す（何も消さない）
//   confirm あり … 残す条件に当てはまらないユーザーをすべて削除する
//
// 必ず残すもの（keepLoginIds を指定していなくても残る）:
//   - ログイン中のご自身（消すと管理画面に入れなくなる）
//   - ポータル管理者（can_manage = true。名簿を直せる人が居なくなるため）
//
// 消えないもの:
//   - 各アプリ側のアカウント（ポータルの名簿から消してもアプリには残る）
//   - 部署・職場そのもの
const { requireSql, ensureSchema, readBody } = require("../lib/db");
const { requireManageSession } = require("../lib/portalAuth");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ message: "Method not allowed" });
    return;
  }
  const sql = requireSql(res);
  if (!sql) return;

  try {
    await ensureSchema(sql);
    const session = await requireManageSession(req, res, sql);
    if (!session) return;

    const body = readBody(req);
    const keepLoginIds = Array.isArray(body.keepLoginIds)
      ? [...new Set(body.keepLoginIds.map((v) => String(v || "").trim()).filter(Boolean))]
      : [];
    // ログイン中の本人は指定が無くても残す
    if (session.loginId && !keepLoginIds.includes(session.loginId)) keepLoginIds.push(session.loginId);

    const targets = await sql`
      SELECT u.id, u.login_id, u.name, u.role, d.name AS department_name
      FROM pf_portal_users u
      LEFT JOIN pf_portal_departments d ON d.id = u.department_id
      WHERE u.can_manage IS NOT TRUE
        AND NOT (u.login_id = ANY(${keepLoginIds}::text[]))
      ORDER BY u.login_id ASC`;

    const kept = await sql`
      SELECT count(*)::int AS n FROM pf_portal_users
      WHERE can_manage IS TRUE OR login_id = ANY(${keepLoginIds}::text[])`;

    const preview = {
      keepLoginIds,
      users: targets.length,
      keptUsers: Number(kept[0] ? kept[0].n : 0),
      list: targets.slice(0, 200).map((t) => ({
        loginId: t.login_id,
        name: t.name,
        role: t.role,
        departmentName: t.department_name,
      })),
    };

    // 確認の言葉が無いうちは何も消さない（押し間違いで名簿が消えないように）
    if (String(body.confirm || "").trim() !== "削除") {
      res.status(200).json({ ok: true, dryRun: true, ...preview });
      return;
    }
    if (targets.length === 0) {
      res.status(200).json({ ok: true, dryRun: false, deleted: 0, ...preview });
      return;
    }

    const ids = targets.map((t) => t.id);
    // FK なしの参照列をアプリ側で NULL 化（承認者・職場管理者に指定されていた場合）
    await sql`UPDATE pf_portal_users SET approver_user_id = NULL WHERE approver_user_id = ANY(${ids}::uuid[])`;
    await sql`UPDATE pf_portal_workplaces SET admin_user_id = NULL WHERE admin_user_id = ANY(${ids}::uuid[])`;
    const deleted = await sql`DELETE FROM pf_portal_users WHERE id = ANY(${ids}::uuid[]) RETURNING id`;

    res.status(200).json({ ok: true, dryRun: false, deleted: deleted.length, ...preview });
  } catch (e) {
    console.error("[users-reset]", e);
    res.status(500).json({ message: "サーバーエラーが発生しました" });
  }
};
