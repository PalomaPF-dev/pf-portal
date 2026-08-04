// 職場の CSV 一括登録・更新 API（管理者専用）。
// POST {rows:[{departmentCode?,departmentName?,code,name,sort?}]}（1リクエスト最大200行）
//  - 部署は「部署コード優先」→ コード空欄なら部署名で照合（users-import と同じ規則）
//  - 職場コード（全体で一意）で照合し、既存なら名称・所属部署・並び順を更新、無ければ新規作成（upsert）
//  - 同一バッチ内の職場コード重複は error にして他の行は処理を続ける
// レスポンス: { rows: [{code,name,status:'created'|'updated'|'error',message?}] }
const { requireSql, ensureSchema, readBody } = require("../lib/db");
const { requireManage } = require("../lib/portalAuth");

const MAX_ROWS = 200;
const CODE_RE = /^[A-Za-z0-9_-]+$/;

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

    const departments = await sql`SELECT id, code, name FROM pf_portal_departments`;
    const deptByCode = new Map(departments.filter((d) => d.code).map((d) => [String(d.code), d]));
    const deptByName = new Map(departments.map((d) => [d.name, d]));
    const existing = await sql`SELECT id, code, name, department_id, sort FROM pf_portal_workplaces`;
    const byCode = new Map(existing.map((w) => [String(w.code), w]));

    const seenCodes = new Set();
    const out = [];

    for (const r of rows) {
      const departmentCode = String((r && r.departmentCode) || "").trim();
      const departmentName = String((r && r.departmentName) || "").trim();
      const code = String((r && r.code) || "").trim();
      const name = String((r && r.name) || "").trim();
      const item = { code, name, status: null, message: null };

      if (!code || !CODE_RE.test(code) || code.length > 20) {
        item.status = "error";
        item.message = "職場コードは半角英数字と - _ で入力してください（20文字以内）";
        out.push(item); continue;
      }
      if (seenCodes.has(code)) {
        item.status = "error";
        item.message = "ファイル内で職場コードが重複しています";
        out.push(item); continue;
      }
      if (!name || name.length > 100) {
        item.status = "error";
        item.message = "職場名が未入力です（100文字以内）";
        out.push(item); continue;
      }
      const dept = departmentCode
        ? deptByCode.get(departmentCode)
        : departmentName
          ? deptByName.get(departmentName)
          : null;
      if (!dept) {
        item.status = "error";
        item.message = "部署が見つかりません（先に部署を登録してください）";
        out.push(item); continue;
      }
      const sortGiven = r && r.sort !== undefined && r.sort !== null && String(r.sort).trim() !== "";
      const prev = byCode.get(code);
      const sort = sortGiven
        ? (Number.isFinite(Number(r.sort)) ? Math.trunc(Number(r.sort)) : 0)
        : prev ? prev.sort : 0;

      seenCodes.add(code);
      try {
        if (prev) {
          await sql`
            UPDATE pf_portal_workplaces
            SET name = ${name}, department_id = ${dept.id}, sort = ${sort}
            WHERE id = ${prev.id}`;
          item.status = "updated";
          byCode.set(code, { ...prev, name, department_id: dept.id, sort });
        } else {
          const ins = await sql`
            INSERT INTO pf_portal_workplaces (code, name, department_id, sort)
            VALUES (${code}, ${name}, ${dept.id}, ${sort})
            RETURNING id`;
          item.status = "created";
          byCode.set(code, { id: ins[0].id, code, name, department_id: dept.id, sort });
        }
      } catch (e) {
        console.error("[workplaces-import] row error:", code, e && e.message);
        item.status = "error";
        item.message = "保存に失敗しました";
      }
      out.push(item);
    }

    res.status(200).json({ rows: out });
  } catch (e) {
    console.error("[workplaces-import]", e);
    res.status(500).json({ message: "サーバーエラーが発生しました" });
  }
};
