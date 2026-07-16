// 職場（部署・工場）マスタ API。
// GET    公開（所属選択画面用）: [{id,code,kind,name,description,apps,sort}]
// POST   管理者: 作成 {code,kind,name,description?,apps?,sort?}
// PUT    管理者: 更新 {id, code?,kind?,name?,description?,apps?,sort?}
// DELETE 管理者: 削除 {id}（所属ユーザーの department_id は SET NULL）
const { requireSql, ensureSchema, readBody, isUuid, ALL_APP_KEYS } = require("../lib/db");
const { requireAdmin } = require("../lib/portalAuth");

const CODE_RE = /^[A-Za-z0-9_-]+$/;

function normalizeApps(input) {
  if (!Array.isArray(input)) return [];
  // 既知キーのみ・重複除去・正順に正規化
  const set = new Set(input.filter((k) => typeof k === "string"));
  return ALL_APP_KEYS.filter((k) => set.has(k));
}

module.exports = async (req, res) => {
  const sql = requireSql(res);
  if (!sql) return;

  try {
    await ensureSchema(sql);

    if (req.method === "GET") {
      const rows = await sql`
        SELECT id, code, kind, name, description, apps, sort
        FROM pf_portal_departments
        ORDER BY sort ASC, created_at ASC`;
      res.status(200).json(rows);
      return;
    }

    // 以降は管理者のみ
    if (!requireAdmin(req, res)) return;

    if (req.method === "POST") {
      const body = readBody(req);
      const code = String(body.code || "").trim();
      const kind = body.kind === "factory" ? "factory" : body.kind === "dept" ? "dept" : null;
      const name = String(body.name || "").trim();
      const description = String(body.description || "").trim();
      const apps = normalizeApps(body.apps);
      const sort = Number.isFinite(Number(body.sort)) ? Math.trunc(Number(body.sort)) : 0;
      if (!code || !CODE_RE.test(code) || code.length > 20) { res.status(400).json({ message: "職場コードは半角英数で入力してください（20文字以内）" }); return; }
      if (!kind) { res.status(400).json({ message: "種別（dept/factory）を指定してください" }); return; }
      if (!name) { res.status(400).json({ message: "職場名は必須です" }); return; }
      if (name.length > 100 || description.length > 300) { res.status(400).json({ message: "入力が長すぎます" }); return; }
      const dupCode = await sql`SELECT 1 FROM pf_portal_departments WHERE code = ${code} LIMIT 1`;
      if (dupCode.length > 0) { res.status(409).json({ message: "同じ職場コードが既に存在します" }); return; }
      const dup = await sql`SELECT 1 FROM pf_portal_departments WHERE name = ${name} LIMIT 1`;
      if (dup.length > 0) { res.status(409).json({ message: "同じ職場名が既に存在します" }); return; }
      const rows = await sql`
        INSERT INTO pf_portal_departments (code, kind, name, description, apps, sort)
        VALUES (${code}, ${kind}, ${name}, ${description}, ${JSON.stringify(apps)}::jsonb, ${sort})
        RETURNING id, code, kind, name, description, apps, sort`;
      res.status(201).json(rows[0]);
      return;
    }

    if (req.method === "PUT") {
      const body = readBody(req);
      const id = body.id;
      if (!isUuid(id)) { res.status(400).json({ message: "id が不正です" }); return; }
      const cur = await sql`SELECT id, code, kind, name, description, apps, sort FROM pf_portal_departments WHERE id = ${id} LIMIT 1`;
      if (cur.length === 0) { res.status(404).json({ message: "対象が見つかりません" }); return; }
      const prev = cur[0];
      const code = body.code === undefined ? (prev.code || "") : String(body.code || "").trim();
      const kind = body.kind === undefined ? prev.kind : body.kind === "factory" ? "factory" : body.kind === "dept" ? "dept" : null;
      const name = body.name === undefined ? prev.name : String(body.name || "").trim();
      const description = body.description === undefined ? (prev.description || "") : String(body.description || "").trim();
      const apps = body.apps === undefined ? (Array.isArray(prev.apps) ? prev.apps : []) : normalizeApps(body.apps);
      const sort = body.sort === undefined ? prev.sort : Number.isFinite(Number(body.sort)) ? Math.trunc(Number(body.sort)) : prev.sort;
      if (!code || !CODE_RE.test(code) || code.length > 20) { res.status(400).json({ message: "職場コードは半角英数で入力してください（20文字以内）" }); return; }
      if (!kind) { res.status(400).json({ message: "種別（dept/factory）が不正です" }); return; }
      if (!name) { res.status(400).json({ message: "職場名は必須です" }); return; }
      if (name.length > 100 || description.length > 300) { res.status(400).json({ message: "入力が長すぎます" }); return; }
      const dupCode = await sql`SELECT 1 FROM pf_portal_departments WHERE code = ${code} AND id <> ${id} LIMIT 1`;
      if (dupCode.length > 0) { res.status(409).json({ message: "同じ職場コードが既に存在します" }); return; }
      const dup = await sql`SELECT 1 FROM pf_portal_departments WHERE name = ${name} AND id <> ${id} LIMIT 1`;
      if (dup.length > 0) { res.status(409).json({ message: "同じ職場名が既に存在します" }); return; }
      const rows = await sql`
        UPDATE pf_portal_departments
        SET code = ${code}, kind = ${kind}, name = ${name}, description = ${description},
            apps = ${JSON.stringify(apps)}::jsonb, sort = ${sort}
        WHERE id = ${id}
        RETURNING id, code, kind, name, description, apps, sort`;
      res.status(200).json(rows[0]);
      return;
    }

    if (req.method === "DELETE") {
      const body = readBody(req);
      const id = body.id || (req.query && req.query.id);
      if (!isUuid(id)) { res.status(400).json({ message: "id が不正です" }); return; }
      await sql`DELETE FROM pf_portal_departments WHERE id = ${id}`;
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ message: "Method not allowed" });
  } catch (e) {
    console.error("[departments]", e);
    res.status(500).json({ message: "サーバーエラーが発生しました" });
  }
};
