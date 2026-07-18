// 職場（部署配下の単位）マスタ API。
// GET    公開: [{id,departmentId,departmentName,code,name,adminUserId,adminName,sort}]（部署の並び順 → 職場の並び順）
// POST   管理者: 作成 {departmentId, code, name, adminUserId?, sort?}
// PUT    管理者: 更新 {id, departmentId?, code?, name?, adminUserId?, sort?}
// DELETE 管理者: 削除 {id}（所属ユーザーの workplace_id はアプリ側で NULL 化）
const { requireSql, ensureSchema, readBody, isUuid } = require("../lib/db");
const { requireAdmin } = require("../lib/portalAuth");

const CODE_RE = /^[A-Za-z0-9_-]+$/;

// adminUserId の検証: null なら OK、指定時は role='admin' の既存ユーザーであること。
// NG なら res に 400 を書いて false を返す。
async function validateAdminUserId(sql, res, adminUserId) {
  if (!adminUserId) return true;
  if (!isUuid(adminUserId)) {
    res.status(400).json({ message: "adminUserId が不正です" });
    return false;
  }
  const rows = await sql`SELECT role FROM pf_portal_users WHERE id = ${adminUserId} LIMIT 1`;
  if (rows.length === 0 || rows[0].role !== "admin") {
    res.status(400).json({ message: "管理者権限のユーザーを指定してください" });
    return false;
  }
  return true;
}

module.exports = async (req, res) => {
  const sql = requireSql(res);
  if (!sql) return;

  try {
    await ensureSchema(sql);

    if (req.method === "GET") {
      const rows = await sql`
        SELECT w.id, w.department_id, d.name AS department_name,
               w.code, w.name, w.admin_user_id, a.name AS admin_name, w.sort
        FROM pf_portal_workplaces w
        JOIN pf_portal_departments d ON d.id = w.department_id
        LEFT JOIN pf_portal_users a ON a.id = w.admin_user_id
        ORDER BY d.sort ASC, w.sort ASC, w.created_at ASC`;
      res.status(200).json(
        rows.map((w) => ({
          id: w.id,
          departmentId: w.department_id,
          departmentName: w.department_name,
          code: w.code,
          name: w.name,
          adminUserId: w.admin_user_id,
          adminName: w.admin_name,
          sort: w.sort,
        }))
      );
      return;
    }

    // 以降は管理者のみ
    if (!requireAdmin(req, res)) return;

    if (req.method === "POST") {
      const body = readBody(req);
      const departmentId = body.departmentId;
      const code = String(body.code || "").trim();
      const name = String(body.name || "").trim();
      const adminUserId = body.adminUserId || null;
      const sort = Number.isFinite(Number(body.sort)) ? Math.trunc(Number(body.sort)) : 0;
      if (!isUuid(departmentId)) { res.status(400).json({ message: "部署を選択してください" }); return; }
      if (!code || !CODE_RE.test(code) || code.length > 20) { res.status(400).json({ message: "職場コードは半角英数で入力してください（20文字以内）" }); return; }
      if (!name || name.length > 100) { res.status(400).json({ message: "職場名は必須です（100文字以内）" }); return; }
      const dept = await sql`SELECT 1 FROM pf_portal_departments WHERE id = ${departmentId} LIMIT 1`;
      if (dept.length === 0) { res.status(400).json({ message: "指定の部署が見つかりません" }); return; }
      const dupCode = await sql`SELECT 1 FROM pf_portal_workplaces WHERE code = ${code} LIMIT 1`;
      if (dupCode.length > 0) { res.status(409).json({ message: "同じ職場コードが既に存在します" }); return; }
      if (!(await validateAdminUserId(sql, res, adminUserId))) return;
      const rows = await sql`
        INSERT INTO pf_portal_workplaces (department_id, code, name, admin_user_id, sort)
        VALUES (${departmentId}, ${code}, ${name}, ${adminUserId}, ${sort})
        RETURNING id, department_id, code, name, admin_user_id, sort`;
      res.status(201).json({
        id: rows[0].id,
        departmentId: rows[0].department_id,
        code: rows[0].code,
        name: rows[0].name,
        adminUserId: rows[0].admin_user_id,
        sort: rows[0].sort,
      });
      return;
    }

    if (req.method === "PUT") {
      const body = readBody(req);
      const id = body.id;
      if (!isUuid(id)) { res.status(400).json({ message: "id が不正です" }); return; }
      const cur = await sql`SELECT id, department_id, code, name, admin_user_id, sort FROM pf_portal_workplaces WHERE id = ${id} LIMIT 1`;
      if (cur.length === 0) { res.status(404).json({ message: "対象が見つかりません" }); return; }
      const prev = cur[0];
      const departmentId = body.departmentId === undefined ? prev.department_id : body.departmentId;
      const code = body.code === undefined ? (prev.code || "") : String(body.code || "").trim();
      const name = body.name === undefined ? prev.name : String(body.name || "").trim();
      const adminUserId = body.adminUserId === undefined ? prev.admin_user_id : (body.adminUserId || null);
      const sort = body.sort === undefined ? prev.sort : Number.isFinite(Number(body.sort)) ? Math.trunc(Number(body.sort)) : prev.sort;
      if (!isUuid(departmentId)) { res.status(400).json({ message: "部署を選択してください" }); return; }
      if (!code || !CODE_RE.test(code) || code.length > 20) { res.status(400).json({ message: "職場コードは半角英数で入力してください（20文字以内）" }); return; }
      if (!name || name.length > 100) { res.status(400).json({ message: "職場名は必須です（100文字以内）" }); return; }
      const dept = await sql`SELECT 1 FROM pf_portal_departments WHERE id = ${departmentId} LIMIT 1`;
      if (dept.length === 0) { res.status(400).json({ message: "指定の部署が見つかりません" }); return; }
      const dupCode = await sql`SELECT 1 FROM pf_portal_workplaces WHERE code = ${code} AND id <> ${id} LIMIT 1`;
      if (dupCode.length > 0) { res.status(409).json({ message: "同じ職場コードが既に存在します" }); return; }
      if (!(await validateAdminUserId(sql, res, adminUserId))) return;
      const rows = await sql`
        UPDATE pf_portal_workplaces
        SET department_id = ${departmentId}, code = ${code}, name = ${name},
            admin_user_id = ${adminUserId}, sort = ${sort}
        WHERE id = ${id}
        RETURNING id, department_id, code, name, admin_user_id, sort`;
      res.status(200).json({
        id: rows[0].id,
        departmentId: rows[0].department_id,
        code: rows[0].code,
        name: rows[0].name,
        adminUserId: rows[0].admin_user_id,
        sort: rows[0].sort,
      });
      return;
    }

    if (req.method === "DELETE") {
      const body = readBody(req);
      const id = body.id || (req.query && req.query.id);
      if (!isUuid(id)) { res.status(400).json({ message: "id が不正です" }); return; }
      // workplace_id は FK なしのためアプリ側で NULL 化してから削除
      await sql`UPDATE pf_portal_users SET workplace_id = NULL WHERE workplace_id = ${id}`;
      await sql`DELETE FROM pf_portal_workplaces WHERE id = ${id}`;
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ message: "Method not allowed" });
  } catch (e) {
    console.error("[workplaces]", e);
    res.status(500).json({ message: "サーバーエラーが発生しました" });
  }
};
