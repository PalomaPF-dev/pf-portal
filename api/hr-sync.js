// PF人事管理（pf-jinji）からの人事情報連携の受け口。
//
// 人事管理が「人」と「組織」のマスターで、ここへ組織・所属・役職・人事プロフィール・
// 管理者（承認者）が送られてくる。パスワードとアプリ権限（role / can_manage /
// 部署の apps 割当）はポータルが持つ情報なので、このAPIでは一切変更しない。
//
// ※ 生年月日は受け取っても保存しない（ポータルでは保持しない方針。原本は人事管理アプリ側）。
//
// できること:
//   1. 組織の同期      … organizations を送ると部署・職場を作る/紐づける
//                        （同名の既存があればそれを使い、無いものだけ新規作成）
//   2. 人事情報の更新   … 所属・役職・職務・生年月日・入社日・雇用体系・在籍状態
//   3. 承認者の設定    … managerLoginId をポータルの approver_user_id に反映
//   4. 職場の長の設定   … 職場の adminLoginId をポータルの admin_user_id に反映
//                        （兼任＝別の職場に所属する管理者もそのまま設定する）
//   5. アカウント発行   … createMissing:true のとき、未登録の社員をパスワード未設定で作る
//
// 所属が変わった在籍者だけ、既存の provisionUsers() で各業務アプリへ再連携する。
const crypto = require("crypto");
const { requireSql, ensureSchema, readBody } = require("../lib/db");
const { provisionUsers } = require("../lib/provision");

const MAX_EMPLOYEES = 2000;
const MAX_ORGS = 1000;
const LOGIN_ID_RE = /^[A-Za-z0-9_@.-]{1,64}$/;
const CODE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
/** 組織名の表記ゆれ（半角カナ・空白・小さいッ）を吸収して突き合わせる。 */
const normName = (s) =>
  (s ?? "").normalize("NFKC").replace(/[\s　]+/g, "").replace(/[ッｯ]/g, "");

/**
 * 承認者を**まとめて**解決する。
 *
 * 規則は api/users.js・api/users-refresh.js と同じ:
 *   本人の承認者指定 → 職場の管理者（指定） → 職場所属の管理者（社員番号順で最初）
 * 1人ずつ引くと人数ぶんの往復になるので、必要なIDを集めて2回の問い合わせで済ませる。
 * 管理者(role='admin')には承認者を付けない。
 */
async function resolveApproversBulk(sql, wants) {
  const out = new Map(); // key: 呼び出し側が渡した key → 承認者の login_id
  if (wants.length === 0) return out;

  const userIds = [...new Set(wants.map((w) => w.approverUserId).filter(Boolean))];
  const wpIds = [...new Set(wants.map((w) => w.workplaceId).filter(Boolean))];

  const [byId, byWp] = await Promise.all([
    userIds.length
      ? sql`SELECT id, login_id FROM pf_portal_users WHERE id = ANY(${userIds}::uuid[])`
      : Promise.resolve([]),
    wpIds.length
      ? sql`
          SELECT w.id AS wp_id,
                 COALESCE(adm.login_id, fb.login_id) AS login_id
          FROM pf_portal_workplaces w
          LEFT JOIN pf_portal_users adm ON adm.id = w.admin_user_id
          LEFT JOIN LATERAL (
            SELECT login_id FROM pf_portal_users
            WHERE workplace_id = w.id AND role = 'admin'
            ORDER BY login_id LIMIT 1
          ) fb ON true
          WHERE w.id = ANY(${wpIds}::uuid[])`
      : Promise.resolve([]),
  ]);
  const loginById = new Map(byId.map((r) => [r.id, r.login_id]));
  const loginByWp = new Map(byWp.filter((r) => r.login_id).map((r) => [r.wp_id, r.login_id]));

  for (const w of wants) {
    let login = w.approverUserId ? (loginById.get(w.approverUserId) ?? null) : null;
    if (!login && w.role !== "admin" && w.workplaceId) login = loginByWp.get(w.workplaceId) ?? null;
    if (login) out.set(w.key, login);
  }
  return out;
}

/**
 * 組織（部署・職場）を人事管理の内容に合わせる。
 *
 * 突合の順は hr_code → 名称 → 無ければ新規作成。名称で見つけたときは
 * ポータル側の code・apps は**変えず**、hr_code だけを結び付ける
 * （既存部署のアプリ割当を壊さないため）。
 *
 * 戻り値は「人事側コード → ポータルの行」の対応表。社員の所属解決に使う。
 */
async function syncOrganizations(sql, organizations) {
  const stats = { created: 0, linked: 0, updated: 0, errors: [] };
  const deptByHrCode = new Map();
  const wpByHrCode = new Map();

  /**
   * 1種類ぶん（部署 or 職場）をまとめて処理する。
   * 突合は hr_code → 名称 → コード の順。名称で見つけたときは
   * ポータル側の code・apps は変えず hr_code だけを結ぶ（既存のアプリ割当を守る）。
   */
  const load = async () => ({
    depts: await sql`SELECT id, code, hr_code, name, kind, apps FROM pf_portal_departments`,
    wps: await sql`SELECT id, code, hr_code, name, department_id FROM pf_portal_workplaces`,
  });

  let { depts, wps } = await load();

  // ===== 部署 =====
  const deptRows = organizations.filter((x) => x.kind === "dept");
  {
    const byHr = new Map(depts.filter((d) => d.hr_code).map((d) => [d.hr_code, d]));
    const byName = new Map(depts.map((d) => [normName(d.name), d]));
    const byCode = new Map(depts.map((d) => [d.code, d]));

    const toCreate = [];
    const toLink = [];
    const toRename = [];
    const seenName = new Set();
    for (const o of deptRows) {
      const code = nz(o.code);
      const name = nz(o.name);
      if (!code || !CODE_RE.test(code) || !name) {
        stats.errors.push(`部署 ${o.code ?? ""} ${o.name ?? ""}: コードまたは名称が不正です`);
        continue;
      }
      // ポータルの部署名は一意。同名が2件来たら先勝ちにして、残りは理由を返す
      const key = normName(name);
      if (seenName.has(key) && !byHr.has(code)) {
        stats.errors.push(`部署 ${name}: 同じ名称が複数あるため1件だけ登録しました`);
        continue;
      }
      seenName.add(key);

      const row = byHr.get(code) || byName.get(key) || byCode.get(code);
      if (row) {
        if (row.hr_code !== code) toLink.push({ id: row.id, code });
        if (row.name !== name) toRename.push({ id: row.id, name });
      } else {
        toCreate.push({ code, name, kind: o.isFactory ? "factory" : "dept", sort: Number(o.sort) || 0 });
      }
    }

    if (toCreate.length > 0) {
      await sql`
        INSERT INTO pf_portal_departments (code, hr_code, kind, name, description, apps, sort)
        SELECT code, code, kind, name, ${"人事管理から作成"}, '[]'::jsonb, sort
        FROM unnest(
          ${toCreate.map((x) => x.code)}::text[], ${toCreate.map((x) => x.kind)}::text[],
          ${toCreate.map((x) => x.name)}::text[], ${toCreate.map((x) => x.sort)}::int[]
        ) AS v(code, kind, name, sort)
        ON CONFLICT (code) DO NOTHING`;
      stats.created += toCreate.length;
    }
    if (toLink.length > 0) {
      await sql`
        UPDATE pf_portal_departments d SET hr_code = v.hr
        FROM unnest(${toLink.map((x) => x.id)}::uuid[], ${toLink.map((x) => x.code)}::text[]) AS v(id, hr)
        WHERE d.id = v.id`;
      stats.linked += toLink.length;
    }
    if (toRename.length > 0) {
      await sql`
        UPDATE pf_portal_departments d SET name = v.name
        FROM unnest(${toRename.map((x) => x.id)}::uuid[], ${toRename.map((x) => x.name)}::text[]) AS v(id, name)
        WHERE d.id = v.id`;
      stats.updated += toRename.length;
    }
    if (toCreate.length + toLink.length + toRename.length > 0) {
      depts = (await load()).depts;
    }
  }
  for (const d of depts) if (d.hr_code) deptByHrCode.set(d.hr_code, d);
  const deptByAny = new Map();
  for (const d of depts) {
    deptByAny.set(d.code, d);
    if (d.hr_code) deptByAny.set(d.hr_code, d);
  }

  // ===== 職場 =====
  {
    const byHr = new Map(wps.filter((w) => w.hr_code).map((w) => [w.hr_code, w]));
    const byCode = new Map(wps.map((w) => [w.code, w]));
    const byDeptName = new Map(wps.map((w) => [`${w.department_id}|${normName(w.name)}`, w]));

    const toCreate = [];
    const toUpdate = [];
    let linked = 0;
    for (const o of organizations.filter((x) => x.kind === "workplace")) {
      const code = nz(o.code);
      const name = nz(o.name);
      const deptCode = nz(o.departmentCode);
      if (!code || !CODE_RE.test(code) || !name || !deptCode) {
        stats.errors.push(`職場 ${o.code ?? ""} ${o.name ?? ""}: コード・名称・部署のいずれかが不正です`);
        continue;
      }
      const dept = deptByAny.get(deptCode);
      if (!dept) {
        stats.errors.push(`職場 ${name}: 部署コード ${deptCode} が見つかりません`);
        continue;
      }
      const row = byHr.get(code) || byDeptName.get(`${dept.id}|${normName(name)}`) || byCode.get(code);
      if (row) {
        if (row.hr_code !== code || row.name !== name || row.department_id !== dept.id) {
          toUpdate.push({ id: row.id, code, name, deptId: dept.id });
          if (row.hr_code !== code) linked++;
        }
      } else {
        toCreate.push({ code, name, deptId: dept.id, sort: Number(o.sort) || 0 });
      }
    }

    if (toCreate.length > 0) {
      await sql`
        INSERT INTO pf_portal_workplaces (department_id, code, hr_code, name, sort)
        SELECT dept_id, code, code, name, sort
        FROM unnest(
          ${toCreate.map((x) => x.deptId)}::uuid[], ${toCreate.map((x) => x.code)}::text[],
          ${toCreate.map((x) => x.name)}::text[], ${toCreate.map((x) => x.sort)}::int[]
        ) AS v(dept_id, code, name, sort)
        ON CONFLICT (code) DO NOTHING`;
      stats.created += toCreate.length;
    }
    if (toUpdate.length > 0) {
      await sql`
        UPDATE pf_portal_workplaces w
        SET hr_code = v.hr, name = v.name, department_id = v.dept_id
        FROM unnest(
          ${toUpdate.map((x) => x.id)}::uuid[], ${toUpdate.map((x) => x.code)}::text[],
          ${toUpdate.map((x) => x.name)}::text[], ${toUpdate.map((x) => x.deptId)}::uuid[]
        ) AS v(id, hr, name, dept_id)
        WHERE w.id = v.id`;
      stats.linked += linked;
      stats.updated += toUpdate.length - linked;
    }
    if (toCreate.length + toUpdate.length > 0) {
      wps = (await load()).wps;
    }
  }
  for (const w of wps) if (w.hr_code) wpByHrCode.set(w.hr_code, w);

  return { stats, deptByHrCode, wpByHrCode };
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
  const organizations = Array.isArray(body.organizations) ? body.organizations : [];
  const createMissing = body.createMissing === true;
  if (employees.length === 0 && organizations.length === 0) {
    res.status(400).json({ message: "employees または organizations を指定してください" });
    return;
  }
  if (employees.length > MAX_EMPLOYEES) {
    res.status(400).json({ message: `一度に送れる社員は最大${MAX_EMPLOYEES}件です` });
    return;
  }
  if (organizations.length > MAX_ORGS) {
    res.status(400).json({ message: `一度に送れる組織は最大${MAX_ORGS}件です` });
    return;
  }

  const sql = requireSql(res);
  if (!sql) return;

  try {
    await ensureSchema(sql);

    // ===== 1. 組織 =====
    let orgStats = { created: 0, linked: 0, updated: 0, errors: [] };
    let deptByHrCode = new Map();
    let wpByHrCode = new Map();
    if (organizations.length > 0) {
      const r = await syncOrganizations(sql, organizations);
      orgStats = r.stats;
      deptByHrCode = r.deptByHrCode;
      wpByHrCode = r.wpByHrCode;
    }

    // 人事側コード・ポータルのコード どちらでも引けるようにする
    // （組織を送らない連携＝発令直後の1人だけ、でも解決できるように）
    const depts = await sql`SELECT id, code, hr_code, name, kind, apps FROM pf_portal_departments`;
    const deptByAnyCode = new Map();
    for (const d of depts) {
      deptByAnyCode.set(d.code, d);
      if (d.hr_code) deptByAnyCode.set(d.hr_code, d);
    }
    const deptById = new Map(depts.map((d) => [d.id, d]));
    const wps = await sql`SELECT id, code, hr_code, department_id FROM pf_portal_workplaces`;
    const wpByAnyCode = new Map();
    for (const w of wps) {
      wpByAnyCode.set(w.code, w);
      if (w.hr_code) wpByAnyCode.set(w.hr_code, w);
    }
    for (const [k, v] of deptByHrCode) deptByAnyCode.set(k, deptById.get(v.id) || v);
    for (const [k, v] of wpByHrCode) wpByAnyCode.set(k, v);

    const results = [];
    // 所属が実際に変わった人だけ再連携する（provisionUsers は各アプリへHTTPを撒くため）
    const needsReprovision = [];
    // 承認者は「全員の行が揃ってから」設定する（承認者本人が同じ連携で作られることがある）
    const approverWanted = [];

    // ===== 2. 社員 =====
    // まとめて読み、まとめて書く。1人ずつ SELECT + UPDATE を撃つと1,700名で
    // 3,400往復になり、Neon（HTTP接続）では1往復が数十msあるため数分かかって
    // タイムアウトする。往復の数を人数に依存させない。
    const loginIds = employees
      .map((e) => (e?.loginId ?? "").toString().trim())
      .filter((v) => LOGIN_ID_RE.test(v));
    const existingRows = loginIds.length
      ? await sql`
          SELECT id, login_id, name, email, role, department_id, workplace_id, approver_user_id
          FROM pf_portal_users WHERE login_id = ANY(${loginIds})`
      : [];
    const existingByLogin = new Map(existingRows.map((u) => [u.login_id, u]));

    // 書き込む行を組み立てる（ここまではDBに触らない）
    const upserts = [];
    for (const e of employees) {
      const loginId = (e?.loginId ?? "").toString().trim();
      if (!LOGIN_ID_RE.test(loginId)) {
        results.push({ loginId, status: "error", message: "社員番号の形式が不正です" });
        continue;
      }
      const u = existingByLogin.get(loginId) ?? null;

      const status = ["active", "leave", "loaned", "retired"].includes(e.status) ? e.status : "active";
      const retired = status === "retired";

      // 部署・職場の解決。退職者は所属を外す。
      let deptId = u ? u.department_id : null;
      let wpId = u ? u.workplace_id : null;
      if (retired) {
        deptId = null;
        wpId = null;
      } else {
        const deptCode = nz(e.departmentCode);
        if (deptCode) {
          const d = deptByAnyCode.get(deptCode);
          if (!d) {
            results.push({ loginId, status: "error", message: `部署コード ${deptCode} が見つかりません` });
            continue;
          }
          deptId = d.id;
        }
        const wpCode = nz(e.workplaceCode);
        if (wpCode) {
          const w = wpByAnyCode.get(wpCode);
          if (!w) {
            results.push({ loginId, status: "error", message: `職場コード ${wpCode} が見つかりません` });
            continue;
          }
          if (deptId && w.department_id !== deptId) {
            results.push({
              loginId,
              status: "error",
              message: `職場 ${wpCode} は指定の部署の配下ではありません`,
            });
            continue;
          }
          wpId = w.id;
        } else if (deptCode) {
          // 部署だけ指定された＝職場は未所属にする
          wpId = null;
        }
      }

      if (!u) {
        // ===== 未登録の社員 =====
        if (!createMissing) {
          results.push({ loginId, status: "skipped", message: "ポータルに未登録" });
          continue;
        }
        if (retired) {
          // 退職者のアカウントは作らない（作った瞬間に使えない行が増えるだけ）
          results.push({ loginId, status: "skipped", message: "退職者のため作成しません" });
          continue;
        }
        if (!deptId) {
          results.push({ loginId, status: "skipped", message: "所属が決まらないため作成しません" });
          continue;
        }
      }

      upserts.push({
        loginId,
        name: nz(e.name) || (u ? u.name : loginId),
        email: nz(e.email) || (u ? u.email : null),
        deptId,
        wpId,
        positionName: nz(e.positionName),
        dutyName: nz(e.dutyName),
        hireDate: nzDate(e.hireDate),
        employmentType: nz(e.employmentType),
        managerLoginId: nz(e.managerLoginId) && nz(e.managerLoginId) !== loginId ? nz(e.managerLoginId) : null,
        isNew: !u,
        retired,
        affiliationChanged: !u || deptId !== u.department_id || wpId !== u.workplace_id,
        prev: u,
      });
    }

    // まとめて upsert する。既存行では role・can_manage・password_hash・
    // approver_user_id に触れない（ポータルが持つ情報のため）。
    const CHUNK = 500;
    const idByLoginId = new Map();
    for (let at = 0; at < upserts.length; at += CHUNK) {
      const part = upserts.slice(at, at + CHUNK);
      const col = (f) => part.map((x) => x[f]);
      const written = await sql`
        INSERT INTO pf_portal_users
          (login_id, name, email, department_id, workplace_id, role,
           position_name, duty_name, hire_date, employment_type)
        SELECT login_id, name, email, dept_id, wp_id, 'member',
               position_name, duty_name, hire_date, employment_type
        FROM unnest(
          ${col("loginId")}::text[], ${col("name")}::text[], ${col("email")}::text[],
          ${col("deptId")}::uuid[], ${col("wpId")}::uuid[],
          ${col("positionName")}::text[], ${col("dutyName")}::text[],
          ${col("hireDate")}::date[], ${col("employmentType")}::text[]
        ) AS v(login_id, name, email, dept_id, wp_id,
               position_name, duty_name, hire_date, employment_type)
        ON CONFLICT (login_id) DO UPDATE SET
          name            = COALESCE(EXCLUDED.name, pf_portal_users.name),
          email           = COALESCE(EXCLUDED.email, pf_portal_users.email),
          department_id   = EXCLUDED.department_id,
          workplace_id    = EXCLUDED.workplace_id,
          position_name   = EXCLUDED.position_name,
          duty_name       = EXCLUDED.duty_name,
          hire_date       = EXCLUDED.hire_date,
          employment_type = EXCLUDED.employment_type
        RETURNING id, login_id, (xmax = 0) AS created`;
      for (const w of written) idByLoginId.set(w.login_id, w.id);
    }

    // 再連携に載せる承認者を用意する。人事管理の指定が最優先で、
    // 指定が無い人だけポータルの規則（本人指定 → 職場の管理者）で補う。
    const fallbackWants = upserts
      .filter((x) => !x.managerLoginId && x.affiliationChanged && !x.retired && x.deptId)
      .map((x) => ({
        key: x.loginId,
        approverUserId: x.prev ? x.prev.approver_user_id : null,
        workplaceId: x.wpId,
        role: x.prev && x.prev.role === "admin" ? "admin" : "member",
      }));
    const fallbackApprover = await resolveApproversBulk(sql, fallbackWants);

    for (const x of upserts) {
      const id = idByLoginId.get(x.loginId);
      if (!id) {
        results.push({ loginId: x.loginId, status: "error", message: "登録できませんでした" });
        continue;
      }
      if (x.managerLoginId) {
        approverWanted.push({ userId: id, loginId: x.loginId, managerLoginId: x.managerLoginId });
      }
      // 所属が変わった在籍者だけ、各アプリへ再連携する。
      // 役割・工場名はポータルの現在値から組み立てる（人事管理からは送られてこない）。
      let reprovisioned = false;
      if (x.affiliationChanged && !x.retired && x.deptId) {
        const d = deptById.get(x.deptId);
        const role = x.prev && x.prev.role === "admin" ? "admin" : "member";
        let approverLoginId = x.managerLoginId ?? fallbackApprover.get(x.loginId) ?? null;
        if (approverLoginId === x.loginId) approverLoginId = null;
        needsReprovision.push({
          id,
          loginId: x.loginId,
          name: x.name,
          email: x.email,
          apps: Array.isArray(d?.apps) ? d.apps : [],
          factory: d && d.kind === "factory" ? d.name : null,
          role,
          approverLoginId,
        });
        reprovisioned = true;
      }
      results.push({ loginId: x.loginId, status: x.isNew ? "created" : "updated", reprovisioned });
    }

    // ===== 承認者の反映 =====
    // 全員の行が揃ってから引く（承認者本人が同じ連携で作られていることがあるため）。
    let approverSet = 0;
    if (approverWanted.length > 0) {
      const wantIds = [...new Set(approverWanted.map((a) => a.managerLoginId))];
      const mgrRows = await sql`
        SELECT id, login_id FROM pf_portal_users WHERE login_id = ANY(${wantIds})`;
      const mgrIdByLogin = new Map(mgrRows.map((m) => [m.login_id, m.id]));
      // まとめて更新する。1人ずつ撃つと人数ぶんの往復になる。
      const pairs = approverWanted
        .map((a) => ({ ...a, mgrId: mgrIdByLogin.get(a.managerLoginId) }))
        .filter((a) => a.mgrId && a.mgrId !== a.userId);
      const CHUNK_A = 500;
      const doneIds = new Set();
      for (let at = 0; at < pairs.length; at += CHUNK_A) {
        const part = pairs.slice(at, at + CHUNK_A);
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

    // ===== 職場の長（承認者となる管理者）の反映 =====
    // 職場の adminLoginId を pf_portal_workplaces.admin_user_id に入れる。
    // 人事マスタでは管理者が別の職場に所属していること（兼任）があるため、
    // 「その職場に所属していること」は条件にしない。role / can_manage には触れない。
    let workplaceAdminSet = 0;
    {
      const wanted = [];
      for (const o of organizations) {
        if (o?.kind !== "workplace") continue;
        const code = nz(o.code);
        const admin = nz(o.adminLoginId);
        if (!code || !admin || !LOGIN_ID_RE.test(admin)) continue;
        const w = wpByAnyCode.get(code);
        if (w) wanted.push({ wpId: w.id, loginId: admin });
      }
      if (wanted.length > 0) {
        const ids = [...new Set(wanted.map((x) => x.loginId))];
        const rows = await sql`
          SELECT id, login_id FROM pf_portal_users WHERE login_id = ANY(${ids})`;
        const idByLogin = new Map(rows.map((r) => [r.login_id, r.id]));
        const pairs = wanted
          .map((x) => ({ wpId: x.wpId, userId: idByLogin.get(x.loginId) }))
          .filter((x) => x.userId);
        const CHUNK_W = 500;
        for (let at = 0; at < pairs.length; at += CHUNK_W) {
          const part = pairs.slice(at, at + CHUNK_W);
          const done = await sql`
            UPDATE pf_portal_workplaces w SET admin_user_id = v.uid
            FROM unnest(${part.map((x) => x.wpId)}::uuid[], ${part.map((x) => x.userId)}::uuid[]) AS v(wid, uid)
            WHERE w.id = v.wid AND w.admin_user_id IS DISTINCT FROM v.uid
            RETURNING w.id`;
          workplaceAdminSet += done.length;
        }
      }
    }
    orgStats.adminSet = workplaceAdminSet;

    if (needsReprovision.length > 0) {
      // 失敗しても連携全体は成功として返す（アプリ側の一時障害で人事情報の更新まで
      // 巻き戻すと、次に送り直すまでポータルが古いままになるため）
      try {
        await provisionUsers(sql, needsReprovision);
      } catch (err) {
        console.warn("[hr-sync] reprovision failed:", err.message);
      }
    }

    res.status(200).json({ results, organizations: orgStats });
  } catch (e) {
    console.error("[hr-sync]", e);
    res.status(500).json({ message: "サーバーエラーが発生しました" });
  }
};
