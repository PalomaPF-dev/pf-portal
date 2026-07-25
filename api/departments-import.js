// 部署の CSV 一括登録・更新 API（管理者専用）。
// POST {rows:[{code,kind,name,description?,apps?,sort?}]}（1リクエスト最大200行）
//  - 部署コードで照合し、既存なら更新・無ければ新規作成（upsert）
//  - apps は既知のアプリキーのみ採用。指定が無い（undefined）ときは既存の割当を維持する
//  - 部署名の重複、同一バッチ内のコード重複は error にして他の行は処理を続ける
// レスポンス: { rows: [{code,name,status:'created'|'updated'|'error',message?}] }
const { requireSql, ensureSchema, readBody, ALL_APP_KEYS } = require("../lib/db");
const { requireManage } = require("../lib/portalAuth");

const MAX_ROWS = 200;
const CODE_RE = /^[A-Za-z0-9_-]+$/;

// 既知キーのみ・重複除去・正順に正規化（api/departments.js と同じ規則）
function normalizeApps(input) {
  if (!Array.isArray(input)) return [];
  const set = new Set(input.filter((k) => typeof k === "string"));
  return ALL_APP_KEYS.filter((k) => set.has(k));
}

// 種別の表記ゆれを吸収（工場/factory → factory、部署/dept → dept、空欄は部署）
function normalizeKind(v) {
  const s = String(v == null ? "" : v).trim().toLowerCase();
  if (s === "" || s === "dept" || s === "部署" || s === "部門") return "dept";
  if (s === "factory" || s === "工場") return "factory";
  return null;
}

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

    const existing = await sql`SELECT id, code, kind, name, description, apps, sort FROM pf_portal_departments`;
    const byCode = new Map(existing.filter((d) => d.code).map((d) => [String(d.code), d]));
    // 部署名は UNIQUE 制約があるため、他の部署が使っている名前は弾く
    const idByName = new Map(existing.map((d) => [d.name, d.id]));

    const seenCodes = new Set();
    const out = [];

    for (const r of rows) {
      const code = String((r && r.code) || "").trim();
      const name = String((r && r.name) || "").trim();
      const item = { code, name, status: null, message: null };

      if (!code || !CODE_RE.test(code) || code.length > 20) {
        item.status = "error";
        item.message = "部署コードは半角英数字と - _ で入力してください（20文字以内）";
        out.push(item); continue;
      }
      if (seenCodes.has(code)) {
        item.status = "error";
        item.message = "ファイル内で部署コードが重複しています";
        out.push(item); continue;
      }
      if (!name || name.length > 100) {
        item.status = "error";
        item.message = "部署名が未入力です（100文字以内）";
        out.push(item); continue;
      }
      const kind = normalizeKind(r && r.kind);
      if (!kind) {
        item.status = "error";
        item.message = "種別は 部署 / 工場 のいずれかで入力してください";
        out.push(item); continue;
      }
      const description = String((r && r.description) || "").trim();
      if (description.length > 300) {
        item.status = "error";
        item.message = "説明が長すぎます（300文字以内）";
        out.push(item); continue;
      }

      const prev = byCode.get(code);
      // 同名の別部署があれば UNIQUE 制約違反になるので事前に弾く
      const nameOwner = idByName.get(name);
      if (nameOwner && (!prev || nameOwner !== prev.id)) {
        item.status = "error";
        item.message = "同じ部署名の別の部署が既に存在します";
        out.push(item); continue;
      }

      // アプリ列が未指定（undefined）なら既存の割当を維持。空文字なら「割当なし」として扱う。
      const appsGiven = r && r.apps !== undefined && r.apps !== null;
      const apps = appsGiven
        ? normalizeApps(r.apps)
        : prev && Array.isArray(prev.apps) ? prev.apps : [];
      const sortGiven = r && r.sort !== undefined && r.sort !== null && String(r.sort).trim() !== "";
      const sort = sortGiven
        ? (Number.isFinite(Number(r.sort)) ? Math.trunc(Number(r.sort)) : 0)
        : prev ? prev.sort : 0;

      seenCodes.add(code);
      try {
        if (prev) {
          await sql`
            UPDATE pf_portal_departments
            SET kind = ${kind}, name = ${name}, description = ${description},
                apps = ${JSON.stringify(apps)}::jsonb, sort = ${sort}
            WHERE id = ${prev.id}`;
          item.status = "updated";
          // 名前を変えた場合に後続行の重複判定が狂わないよう索引を更新する
          idByName.delete(prev.name);
          idByName.set(name, prev.id);
          byCode.set(code, { ...prev, kind, name, description, apps, sort });
        } else {
          const ins = await sql`
            INSERT INTO pf_portal_departments (code, kind, name, description, apps, sort)
            VALUES (${code}, ${kind}, ${name}, ${description}, ${JSON.stringify(apps)}::jsonb, ${sort})
            RETURNING id`;
          item.status = "created";
          idByName.set(name, ins[0].id);
          byCode.set(code, { id: ins[0].id, code, kind, name, description, apps, sort });
        }
      } catch (e) {
        console.warn("[departments-import] row failed:", code, e && e.message);
        item.status = "error";
        item.message = "保存に失敗しました";
      }
      out.push(item);
    }

    res.status(200).json({ rows: out });
  } catch (e) {
    console.error("[departments-import]", e);
    res.status(500).json({ message: "サーバーエラーが発生しました" });
  }
};
