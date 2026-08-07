// PF人事管理（pf-jinji）からのユーザー同期の受け口。
//
// ■ 何を受け取るか（2026-08 に方針を絞り込み）
//   人事管理が持っているのは「人」の情報だけ。ポータルへ送るのは
//     社員番号 / 氏名 / 在籍状態（退職日） / 管理者（承認者）の社員番号
//   の4つに限る。**部署・職場そのものはポータル側で設定する**ので、
//   このAPIは部署・職場を作ったり名前を変えたり付け替えたりしない。
//   （以前は organizations を受けて組織まで作っていた。人事の組織はポータルの
//     アプリ割当の単位と一致しないため、二重管理になっていた）
//
// ■ 触らないもの
//   role / can_manage / password_hash / 部署の apps 割当 / 部署・職場の構成。
//   これらはポータルが持つ情報。人事の連携で書き換えない。
//   在職者の department_id・workplace_id も**変えない**（ポータルで設定するため）。
//
// ■ 触るもの
//   1. 氏名          … 人事の氏名で更新する
//   2. 在籍状態      … 休職・出向・退職を記録する。退職者は所属を外して
//                      アプリの利用を止める（アカウント自体は消さない）
//   3. 承認者        … managerLoginId を approver_user_id に反映する
//   4. アカウント発行 … createMissing:true のとき、未登録の社員を
//                      パスワード未設定・部署未設定で作る。部署はポータルで割り当てる
//                      （割り当てた時点で、ユーザー編集の保存が各アプリへ連携する）
const crypto = require("crypto");
const { requireSql, ensureSchema, readBody } = require("../lib/db");

const MAX_EMPLOYEES = 2000;
const LOGIN_ID_RE = /^[A-Za-z0-9_@.-]{1,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = ["active", "leave", "loaned", "retired"];

/** タイミング安全な鍵比較（長さ違いは即 false）。 */
function safeKeyEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

const nz = (v) => {
  const s = (v ?? "").toString().trim();
  return s === "" ? null : s;
};
const nzDate = (v) => {
  const s = nz(v);
  return s && DATE_RE.test(s) ? s : null;
};

/**
 * 人事管理の社員台帳に居ない人を、ポータルの名簿から消す。
 *
 * prune = { keepLoginIds: [...全員ぶんの社員番号], confirm?: true }
 * confirm が無ければ**下見だけ**返す（何も消さない）。
 *
 * 必ず残すもの:
 *   - ポータル管理者（can_manage = true）。人事の台帳に載らない管理用の
 *     アカウント（統一管理者など）がここに含まれるため、消すと管理画面が
 *     操作できなくなる。
 *
 * keepLoginIds が空のときは何もしない（送信の失敗で名簿が全部消えるのを防ぐ）。
 */
async function prunePortalUsers(sql, prune) {
  const keepLoginIds = Array.isArray(prune.keepLoginIds)
    ? [...new Set(prune.keepLoginIds.map((v) => String(v || "").trim()).filter((v) => LOGIN_ID_RE.test(v)))]
    : [];
  if (keepLoginIds.length === 0) {
    return { ok: false, message: "社員番号が1件も届かなかったため、何もしませんでした。", deleted: 0, users: 0, list: [] };
  }

  const targets = await sql`
    SELECT u.id, u.login_id, u.name, u.role, d.name AS department_name
    FROM pf_portal_users u
    LEFT JOIN pf_portal_departments d ON d.id = u.department_id
    WHERE u.can_manage IS NOT TRUE
      AND NOT (u.login_id = ANY(${keepLoginIds}::text[]))
    ORDER BY u.login_id ASC`;

  const preview = {
    ok: true,
    users: targets.length,
    list: targets.slice(0, 200).map((t) => ({
      loginId: t.login_id,
      name: t.name,
      role: t.role,
      departmentName: t.department_name,
    })),
  };
  if (prune.confirm !== true) return { ...preview, dryRun: true, deleted: 0 };
  if (targets.length === 0) return { ...preview, dryRun: false, deleted: 0 };

  const ids = targets.map((t) => t.id);
  // FK なしの参照列をアプリ側で NULL 化（承認者・職場管理者に指定されていた場合）
  await sql`UPDATE pf_portal_users SET approver_user_id = NULL WHERE approver_user_id = ANY(${ids}::uuid[])`;
  await sql`UPDATE pf_portal_workplaces SET admin_user_id = NULL WHERE admin_user_id = ANY(${ids}::uuid[])`;
  const deleted = await sql`DELETE FROM pf_portal_users WHERE id = ANY(${ids}::uuid[]) RETURNING id`;
  return { ...preview, dryRun: false, deleted: deleted.length };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ message: "Method not allowed" });
    return;
  }
  const provisionKey = (process.env.PF_PROVISION_KEY || "").trim();
  if (!provisionKey) {
    res.status(503).json({ message: "サーバー設定が未完了です（PF_PROVISION_KEY）" });
    return;
  }

  const body = readBody(req);
  if (!safeKeyEqual(String(body.key || ""), provisionKey)) {
    res.status(401).json({ message: "認証に失敗しました" });
    return;
  }

  const employees = Array.isArray(body.employees) ? body.employees : [];
  // 古い人事管理は organizations も送ってくる。エラーにはせず、受け取らなかったと返す。
  const ignoredOrganizations = Array.isArray(body.organizations) ? body.organizations.length : 0;
  const createMissing = body.createMissing === true;
  const prune = body.prune && typeof body.prune === "object" ? body.prune : null;
  if (employees.length === 0 && !prune) {
    res.status(400).json({ message: "employees を指定してください" });
    return;
  }
  if (employees.length > MAX_EMPLOYEES) {
    res.status(400).json({ message: `一度に送れる社員は最大${MAX_EMPLOYEES}件です` });
    return;
  }

  const sql = requireSql(res);
  if (!sql) return;

  try {
    await ensureSchema(sql);

    // ===== 人事管理に居ない人を消す（一斉更新の仕上げ）=====
    // 社員は分けて送られてくるので、削除は「全員ぶんの社員番号」を持った
    // 最後の1回でだけ行う。ここで消さないと、ポータルだけに残った人が
    // いつまでもアプリを使えてしまう。
    if (prune) {
      const r = await prunePortalUsers(sql, prune);
      res.status(200).json({ results: [], prune: r });
      return;
    }

    const results = [];

    // ===== 読み込み =====
    // まとめて読み、まとめて書く。1人ずつ SELECT + UPDATE を撃つと1,700名で
    // 3,400往復になり、Neon（HTTP接続）では1往復が数十msあるため数分かかって
    // タイムアウトする。往復の数を人数に依存させない。
    const loginIds = employees
      .map((e) => (e?.loginId ?? "").toString().trim())
      .filter((v) => LOGIN_ID_RE.test(v));
    const existingRows = loginIds.length
      ? await sql`
          SELECT id, login_id, name, department_id, workplace_id
          FROM pf_portal_users WHERE login_id = ANY(${loginIds})`
      : [];
    const existingByLogin = new Map(existingRows.map((u) => [u.login_id, u]));

    // ===== 書き込む行を組み立てる（ここまではDBに触らない） =====
    const upserts = [];
    for (const e of employees) {
      const loginId = (e?.loginId ?? "").toString().trim();
      if (!LOGIN_ID_RE.test(loginId)) {
        results.push({ loginId, status: "error", message: "社員番号の形式が不正です" });
        continue;
      }
      const u = existingByLogin.get(loginId) ?? null;
      const status = STATUSES.includes(e.status) ? e.status : "active";
      const retired = status === "retired";

      if (!u) {
        if (!createMissing) {
          results.push({ loginId, status: "skipped", message: "ポータルに未登録" });
          continue;
        }
        if (retired) {
          // 退職者のアカウントは作らない（作った瞬間に使えない行が増えるだけ）
          results.push({ loginId, status: "skipped", message: "退職者のため作成しません" });
          continue;
        }
      }

      const manager = nz(e.managerLoginId);
      upserts.push({
        loginId,
        name: nz(e.name) || (u ? u.name : loginId),
        hrStatus: status,
        retireDate: retired ? nzDate(e.retireDate) : null,
        // 退職したら所属を外す＝各アプリの利用条件（部署のapps）から外れる。
        // 在職者の所属はポータルの設定なので、この連携では触らない。
        clearAffiliation: retired && u != null && (u.department_id != null || u.workplace_id != null),
        managerLoginId: manager && manager !== loginId ? manager : null,
        isNew: !u,
        retired,
      });
    }

    // ===== ユーザーの upsert =====
    // 既存行では role・can_manage・password_hash・approver_user_id・
    // department_id・workplace_id に触れない（ポータルが持つ情報のため）。
    const CHUNK = 500;
    const idByLoginId = new Map();
    for (let at = 0; at < upserts.length; at += CHUNK) {
      const part = upserts.slice(at, at + CHUNK);
      const col = (f) => part.map((x) => x[f]);
      const written = await sql`
        INSERT INTO pf_portal_users (login_id, name, role, hr_status, retire_date)
        SELECT login_id, name, 'member', hr_status, retire_date
        FROM unnest(
          ${col("loginId")}::text[], ${col("name")}::text[],
          ${col("hrStatus")}::text[], ${col("retireDate")}::date[]
        ) AS v(login_id, name, hr_status, retire_date)
        ON CONFLICT (login_id) DO UPDATE SET
          name        = COALESCE(EXCLUDED.name, pf_portal_users.name),
          hr_status   = EXCLUDED.hr_status,
          retire_date = EXCLUDED.retire_date
        RETURNING id, login_id, (xmax = 0) AS created`;
      for (const w of written) idByLoginId.set(w.login_id, w.id);
    }

    // ===== 退職者の所属を外す =====
    let affiliationCleared = 0;
    const toClear = upserts.filter((x) => x.clearAffiliation).map((x) => idByLoginId.get(x.loginId)).filter(Boolean);
    for (let at = 0; at < toClear.length; at += CHUNK) {
      const part = toClear.slice(at, at + CHUNK);
      const done = await sql`
        UPDATE pf_portal_users
        SET department_id = NULL, workplace_id = NULL
        WHERE id = ANY(${part}::uuid[])
        RETURNING id`;
      affiliationCleared += done.length;
    }

    // ===== 承認者の反映 =====
    // 全員の行が揃ってから引く（承認者本人が同じ連携で作られていることがあるため）。
    let approverSet = 0;
    const approverWanted = upserts
      .filter((x) => x.managerLoginId && idByLoginId.has(x.loginId))
      .map((x) => ({ userId: idByLoginId.get(x.loginId), loginId: x.loginId, managerLoginId: x.managerLoginId }));
    if (approverWanted.length > 0) {
      const wantIds = [...new Set(approverWanted.map((a) => a.managerLoginId))];
      const mgrRows = await sql`
        SELECT id, login_id FROM pf_portal_users WHERE login_id = ANY(${wantIds})`;
      const mgrIdByLogin = new Map(mgrRows.map((m) => [m.login_id, m.id]));
      const pairs = approverWanted
        .map((a) => ({ ...a, mgrId: mgrIdByLogin.get(a.managerLoginId) }))
        .filter((a) => a.mgrId && a.mgrId !== a.userId);
      const doneIds = new Set();
      for (let at = 0; at < pairs.length; at += CHUNK) {
        const part = pairs.slice(at, at + CHUNK);
        const done = await sql`
          UPDATE pf_portal_users u SET approver_user_id = v.mgr
          FROM unnest(${part.map((x) => x.userId)}::uuid[], ${part.map((x) => x.mgrId)}::uuid[]) AS v(id, mgr)
          WHERE u.id = v.id AND u.approver_user_id IS DISTINCT FROM v.mgr
          RETURNING u.id`;
        for (const d of done) doneIds.add(d.id);
      }
      for (const a of pairs) {
        if (!doneIds.has(a.userId)) continue;
        approverSet++;
        const r = results.find((x) => x.loginId === a.loginId);
        if (r) r.approverSet = true;
      }
    }

    for (const x of upserts) {
      const id = idByLoginId.get(x.loginId);
      if (!id) {
        results.push({ loginId: x.loginId, status: "error", message: "登録できませんでした" });
        continue;
      }
      const r = results.find((y) => y.loginId === x.loginId);
      const row = { loginId: x.loginId, status: x.isNew ? "created" : "updated", reprovisioned: false };
      if (r) Object.assign(r, row);
      else results.push(row);
    }

    // 各アプリへの連携（provisionUsers）はここでは行わない。
    // アプリの利用可否は部署の apps 割当で決まり、その部署はポータルで設定するため、
    // 割り当てた時点（ユーザー編集の保存・一括再連携）に連携される。
    res.status(200).json({
      results,
      organizations: {
        created: 0,
        linked: 0,
        updated: 0,
        adminSet: 0,
        ignored: ignoredOrganizations,
        errors: ignoredOrganizations
          ? ["組織は受け取りません（部署・職場はポータルで設定します）"]
          : [],
      },
      affiliationCleared,
      approverSet,
    });
  } catch (e) {
    console.error("[hr-sync]", e);
    res.status(500).json({ message: "サーバーエラーが発生しました" });
  }
};
