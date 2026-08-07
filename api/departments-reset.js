// 部署・職場の一括削除（設定のやり直し用・管理セッション専用）。
//
// 人事管理から取り込んだ部署・職場が積み上がった状態から、ポータルの部署設定を
// 作り直すための入口。1件ずつ削除ボタンを押していくと200件を超えるため用意した。
//
// POST { keepCodes?: string[], confirm?: "削除" }
//   confirm 無し … 下見だけ返す（何も消さない）
//   confirm あり … keepCodes に無い部署をすべて削除する
//
// 消えるもの:
//   - 対象の部署（pf_portal_departments）
//   - その配下の職場（pf_portal_workplaces … 部署への FK が ON DELETE CASCADE）
// 残るもの:
//   - ユーザー（pf_portal_users）。department_id / workplace_id が未設定に戻るだけで
//     名簿からは消えない。パスワード・権限・承認者もそのまま。
//   - 各アプリ側のアカウント（ポータルの部署を消してもアプリのアカウントは消えない）
//
// keepCodes の既定は D999（開発者・管理者用の「すべてのアプリ」）。
const { requireSql, ensureSchema, readBody } = require("../lib/db");
const { requireManageSession } = require("../lib/portalAuth");

/** 既定で残す部署コード。開発者・管理者が使う枠なので、消すと管理画面の運用が止まる。 */
const DEFAULT_KEEP = ["D999"];

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ message: "Method not allowed" });
    return;
  }
  const sql = requireSql(res);
  if (!sql) return;

  try {
    await ensureSchema(sql);
    if (!(await requireManageSession(req, res, sql))) return;

    const body = readBody(req);
    const keepCodes = Array.isArray(body.keepCodes)
      ? [...new Set(body.keepCodes.map((v) => String(v || "").trim()).filter(Boolean))]
      : DEFAULT_KEEP;

    const targets = await sql`
      SELECT d.id, d.code, d.name,
             (SELECT count(*)::int FROM pf_portal_workplaces w WHERE w.department_id = d.id) AS workplaces,
             (SELECT count(*)::int FROM pf_portal_users u WHERE u.department_id = d.id) AS users
      FROM pf_portal_departments d
      WHERE NOT (d.code = ANY(${keepCodes}::text[]))
      ORDER BY d.sort ASC, d.code ASC`;

    const preview = {
      keepCodes,
      departments: targets.length,
      workplaces: targets.reduce((n, t) => n + Number(t.workplaces), 0),
      users: targets.reduce((n, t) => n + Number(t.users), 0),
      list: targets.map((t) => ({
        code: t.code,
        name: t.name,
        workplaces: Number(t.workplaces),
        users: Number(t.users),
      })),
    };

    // 確認の言葉が無いうちは何も消さない（押し間違いで部署が消えないように）
    if (String(body.confirm || "").trim() !== "削除") {
      res.status(200).json({ ok: true, dryRun: true, ...preview });
      return;
    }
    if (targets.length === 0) {
      res.status(200).json({ ok: true, dryRun: false, deleted: 0, ...preview });
      return;
    }

    const ids = targets.map((t) => t.id);
    // ユーザーの職場だけは FK が無い列なので、先に手で外す
    // （部署を消すと職場は消えるが、users.workplace_id は宙に浮いたままになるため）
    await sql`
      UPDATE pf_portal_users SET workplace_id = NULL
      WHERE workplace_id IN (SELECT id FROM pf_portal_workplaces WHERE department_id = ANY(${ids}::uuid[]))`;
    const deleted = await sql`
      DELETE FROM pf_portal_departments WHERE id = ANY(${ids}::uuid[]) RETURNING id`;

    res.status(200).json({ ok: true, dryRun: false, deleted: deleted.length, ...preview });
  } catch (e) {
    console.error("[departments-reset]", e);
    res.status(500).json({ message: "サーバーエラーが発生しました" });
  }
};
