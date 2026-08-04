// PF人事管理（pf-jinji）からの人事情報連携の受け口。
//
// 人事管理が「人」のマスターで、ここへ所属・役職・人事プロフィールが送られてくる。
// パスワード・アプリ権限（role / can_manage / apps 割当）・承認者は送られてこないし、
// このAPIでも一切変更しない（それらはポータルが持つ情報のため）。
//
// 所属が変わった在籍者だけ、既存の provisionUsers() で各業務アプリへ再連携する。
// これにより「人事管理で発令 → 各アプリの部署・権限が追従」が成立する。
const crypto = require("crypto");
const { requireSql, ensureSchema, readBody } = require("../lib/db");
const { provisionUsers } = require("../lib/provision");

const MAX_EMPLOYEES = 500;
const LOGIN_ID_RE = /^[A-Za-z0-9_@.-]{1,64}$/;
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

// 承認者の解決: 本人の承認者指定 → 職場の管理者（指定） → 職場所属の管理者（社員番号順で最初）
// （api/users.js・api/users-refresh.js と同じ規則。管理者は明示指定のみ）。
async function resolveApproverLoginId(sql, approverUserId, workplaceId, role) {
  if (approverUserId) {
    const rows = await sql`SELECT login_id FROM pf_portal_users WHERE id = ${approverUserId} LIMIT 1`;
    if (rows.length > 0) return rows[0].login_id;
  }
  if (role === "admin") return null;
  if (workplaceId) {
    const rows = await sql`
      SELECT a.login_id
      FROM pf_portal_workplaces w
      JOIN pf_portal_users a ON a.id = w.admin_user_id
      WHERE w.id = ${workplaceId}
      LIMIT 1`;
    if (rows.length > 0) return rows[0].login_id;
    const fallback = await sql`
      SELECT login_id FROM pf_portal_users
      WHERE workplace_id = ${workplaceId} AND role = 'admin'
      ORDER BY login_id
      LIMIT 1`;
    if (fallback.length > 0) return fallback[0].login_id;
  }
  return null;
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

  const employees = body.employees;
  if (!Array.isArray(employees) || employees.length === 0) {
    res.status(400).json({ message: "employees を指定してください" });
    return;
  }
  if (employees.length > MAX_EMPLOYEES) {
    res.status(400).json({ message: `一度に送れるのは最大${MAX_EMPLOYEES}件です` });
    return;
  }

  const sql = requireSql(res);
  if (!sql) return;

  try {
    await ensureSchema(sql);

    // 部署・職場コード → 行 の対応表
    const depts = await sql`SELECT id, code, name, kind, apps FROM pf_portal_departments`;
    const deptByCode = new Map(depts.map((d) => [d.code, d]));
    const deptById = new Map(depts.map((d) => [d.id, d]));
    const wps = await sql`SELECT id, code, department_id FROM pf_portal_workplaces`;
    const wpByCode = new Map(wps.map((w) => [w.code, w]));

    const results = [];
    // 所属が実際に変わった人だけ再連携する（provisionUsers は各アプリへHTTPを撒くため）
    const needsReprovision = [];

    for (const e of employees) {
      const loginId = (e?.loginId ?? "").toString().trim();
      try {
        if (!LOGIN_ID_RE.test(loginId)) {
          results.push({ loginId, status: "error", message: "社員番号の形式が不正です" });
          continue;
        }

        const cur = await sql`
          SELECT id, login_id, name, email, role, department_id, workplace_id, approver_user_id
          FROM pf_portal_users WHERE login_id = ${loginId} LIMIT 1`;
        if (cur.length === 0) {
          // ポータルに居ない社員番号。アカウント発行はポータル側の運用に任せる。
          results.push({ loginId, status: "skipped", message: "ポータルに未登録" });
          continue;
        }
        const u = cur[0];

        const status = ["active", "leave", "loaned", "retired"].includes(e.status) ? e.status : "active";
        const retired = status === "retired";

        // 部署・職場の解決。退職者は所属を外す。
        let deptId = u.department_id;
        let wpId = u.workplace_id;
        if (retired) {
          deptId = null;
          wpId = null;
        } else {
          const deptCode = nz(e.departmentCode);
          if (deptCode) {
            const d = deptByCode.get(deptCode);
            if (!d) {
              results.push({ loginId, status: "error", message: `部署コード ${deptCode} が見つかりません` });
              continue;
            }
            deptId = d.id;
          }
          const wpCode = nz(e.workplaceCode);
          if (wpCode) {
            const w = wpByCode.get(wpCode);
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

        const affiliationChanged = deptId !== u.department_id || wpId !== u.workplace_id;

        // 人事項目と所属だけを更新する。role・can_manage・password_hash・
        // approver_user_id には触れない（ポータルが持つ情報のため）。
        await sql`
          UPDATE pf_portal_users SET
            name            = COALESCE(${nz(e.name)}, name),
            department_id   = ${deptId},
            workplace_id    = ${wpId},
            position_name   = ${nz(e.positionName)},
            duty_name       = ${nz(e.dutyName)},
            birth_date      = ${nzDate(e.birthDate)},
            hire_date       = ${nzDate(e.hireDate)},
            employment_type = ${nz(e.employmentType)},
            email           = COALESCE(${nz(e.email)}, email)
          WHERE id = ${u.id}`;

        // 所属が変わった在籍者だけ、各アプリへ再連携する。
        // 役割・承認者・工場名はポータルの現在値から組み立てる（人事管理からは
        // 送られてこないため、ここで補わないとアプリ側の権限が既定値に戻ってしまう）。
        let reprovisioned = false;
        if (affiliationChanged && !retired && deptId) {
          const d = deptById.get(deptId);
          const role = u.role === "admin" ? "admin" : "member";
          let approverLoginId = await resolveApproverLoginId(sql, u.approver_user_id, wpId, role);
          if (approverLoginId === u.login_id) approverLoginId = null;
          needsReprovision.push({
            id: u.id,
            loginId,
            name: nz(e.name) || u.name,
            email: nz(e.email) || u.email,
            apps: Array.isArray(d?.apps) ? d.apps : [],
            factory: d && d.kind === "factory" ? d.name : null,
            role,
            approverLoginId,
          });
          reprovisioned = true;
        }

        // 行は必ず更新している。所属が変わったかは reprovisioned で別に伝える
        // （所属据え置きで役職だけ変わった場合を「変更なし」と呼ぶと実態と食い違う）
        results.push({ loginId, status: "updated", reprovisioned });
      } catch (err) {
        results.push({ loginId, status: "error", message: err.message });
      }
    }

    if (needsReprovision.length > 0) {
      // 失敗しても連携全体は成功として返す（アプリ側の一時障害で人事情報の更新まで
      // 巻き戻すと、次に送り直すまでポータルが古いままになるため）
      try {
        await provisionUsers(sql, needsReprovision);
      } catch (err) {
        console.warn("[hr-sync] reprovision failed:", err.message);
      }
    }

    res.status(200).json({ results });
  } catch (e) {
    console.error("[hr-sync]", e);
    res.status(500).json({ message: "サーバーエラーが発生しました" });
  }
};
