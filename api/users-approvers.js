// 承認者の一括設定 API（管理者専用）。
// POST {rows:[{loginId, approverLoginId}]}（1リクエスト最大500行）
//  - CSV一括登録は1リクエスト200行ずつに分割するため、承認者が後のチャンクにいると解決できない。
//    取り込み後にこのAPIをもう一度通すことで、名簿全体を見て承認者を確定させる。
//  - approverLoginId が空なら承認者の指定を解除する（職場の管理者による既定へ戻る）
//  - 自分自身の指定は「指定なし」として扱う。承認者は管理者権限のユーザーのみ
//  - 実際に承認者が変わったユーザーだけをアプリへ再連携する（何度実行しても安全）
// レスポンス: { rows:[{loginId,status:'updated'|'unchanged'|'error',message?}] }
const { requireSql, ensureSchema, readBody } = require("../lib/db");
const { requireManage } = require("../lib/portalAuth");
const { provisionUsers } = require("../lib/provision");

const MAX_ROWS = 500;
const LOGIN_ID_RE = /^[A-Za-z0-9_@.-]+$/;

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

    const items = rows.map((r) => {
      const loginId = String((r && r.loginId) || "").trim();
      let approverLoginId = String((r && r.approverLoginId) || "").trim();
      if (approverLoginId && (approverLoginId === loginId || !LOGIN_ID_RE.test(approverLoginId))) approverLoginId = "";
      return { loginId, approverLoginId, status: null, message: null };
    });

    // 対象ユーザーと承認者候補をまとめて引く
    const logins = Array.from(new Set(
      items.flatMap((it) => [it.loginId, it.approverLoginId]).filter(Boolean)
    ));
    const found = logins.length > 0
      ? await sql`
        SELECT u.id, u.login_id, u.name, u.email, u.role, u.approver_user_id,
               ap.login_id AS approver_login_id,
               d.name AS department_name, d.kind AS department_kind, d.apps AS department_apps
        FROM pf_portal_users u
        LEFT JOIN pf_portal_users ap ON ap.id = u.approver_user_id
        LEFT JOIN pf_portal_departments d ON d.id = u.department_id
        WHERE u.login_id = ANY(${logins}::text[])`
      : [];
    const byLogin = new Map(found.map((u) => [u.login_id, u]));

    const changed = [];
    for (const it of items) {
      const u = it.loginId ? byLogin.get(it.loginId) : null;
      if (!u) {
        it.status = "error";
        it.message = "ユーザーが見つかりません";
        continue;
      }
      let approverUserId = null;
      if (it.approverLoginId) {
        const a = byLogin.get(it.approverLoginId);
        if (!a) {
          it.status = "error";
          it.message = `承認者（社員番号 ${it.approverLoginId}）が名簿にありません`;
          continue;
        }
        if (a.role !== "admin") {
          it.status = "error";
          it.message = `承認者（社員番号 ${it.approverLoginId}）は一般権限のため指定できません`;
          continue;
        }
        approverUserId = a.id;
      }
      if ((u.approver_user_id || null) === approverUserId) {
        it.status = "unchanged";
        continue;
      }
      it.status = "updated";
      changed.push({ item: it, user: u, approverUserId });
    }

    if (changed.length > 0) {
      await sql`
        UPDATE pf_portal_users u
        SET approver_user_id = v.approver_id
        FROM unnest(
          ${changed.map((c) => c.user.login_id)}::text[],
          ${changed.map((c) => c.approverUserId)}::uuid[]
        ) AS v(login_id, approver_id)
        WHERE u.login_id = v.login_id`;

      // 承認者が変わった人だけアプリへ再連携する
      await provisionUsers(sql, changed.map((c) => ({
        id: c.user.id,
        loginId: c.user.login_id,
        name: c.user.name,
        email: c.user.email,
        apps: Array.isArray(c.user.department_apps) ? c.user.department_apps : [],
        factory: c.user.department_kind === "factory" ? c.user.department_name : null,
        role: c.user.role === "admin" ? "admin" : "member",
        approverLoginId: c.item.approverLoginId || null,
      })));
    }

    res.status(200).json({
      rows: items.map((it) => ({
        loginId: it.loginId,
        status: it.status,
        message: it.message || undefined,
      })),
    });
  } catch (e) {
    console.error("[users-approvers]", e);
    res.status(500).json({ message: "サーバーエラーが発生しました" });
  }
};
