// Neon 接続とスキーマ（共用DBのため必ず pf_portal_ 接頭辞・冪等CREATE）。
// DATABASE_URL 未設定でも落とさず、各APIが 503 を返せるように getSql() は null を返す。
const { neon } = require("@neondatabase/serverless");

// ポータルに表示できる全アプリキー（zumen はアカウント不要だが表示対象には含む）
const ALL_APP_KEYS = [
  "keikaku",
  "nippou",
  "sekisai",
  "zumen",
  "keisoku",
  "setsubi",
  "hinshitsu",
  "zaiko",
  "kanagata",
  "hoju",
  "tenchu",
];

// departments が 0 件のときに投入する初期データ（現行 index.html のハードコードと同一 + 仮職場コード）
const DEFAULT_DEPARTMENTS = [
  { code: "D001", kind: "dept", name: "生産管理部", description: "計画・日報・出荷・在庫・転注", apps: ["keikaku", "nippou", "sekisai", "zaiko", "tenchu"], sort: 1 },
  { code: "D002", kind: "dept", name: "調達部", description: "計画・補充・図面・在庫・型・転注", apps: ["keikaku", "hoju", "zumen", "zaiko", "kanagata", "tenchu"], sort: 2 },
  { code: "D003", kind: "dept", name: "品質保証部", description: "品質・計測", apps: ["hinshitsu", "keisoku"], sort: 3 },
  { code: "D999", kind: "dept", name: "すべてのアプリ", description: "管理者・その他の部署", apps: ALL_APP_KEYS, sort: 4 },
  { code: "F001", kind: "factory", name: "第一工場", description: "設備・計測・品質", apps: ["setsubi", "keisoku", "hinshitsu"], sort: 5 },
  { code: "F002", kind: "factory", name: "第二工場", description: "設備・計測・品質", apps: ["setsubi", "keisoku", "hinshitsu"], sort: 6 },
];

let _sql = null;
function getSql() {
  const url = (process.env.DATABASE_URL || "").trim();
  if (!url) return null;
  if (!_sql) _sql = neon(url);
  return _sql;
}

let _schemaReady = false;
async function ensureSchema(sql) {
  if (_schemaReady) return;
  await sql`
    CREATE TABLE IF NOT EXISTS pf_portal_departments (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      code        TEXT UNIQUE NOT NULL,
      kind        TEXT CHECK (kind IN ('dept','factory')),
      name        TEXT UNIQUE NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      apps        JSONB NOT NULL DEFAULT '[]',
      sort        INT NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ DEFAULT now()
    )`;
  // 既存テーブル向けの冪等マイグレーション（code 追加。NOT NULL はアプリ側で担保）
  await sql`ALTER TABLE pf_portal_departments ADD COLUMN IF NOT EXISTS code TEXT`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS pf_portal_departments_code_uq ON pf_portal_departments (code)`;
  await sql`
    CREATE TABLE IF NOT EXISTS pf_portal_users (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      login_id      TEXT UNIQUE NOT NULL,
      name          TEXT NOT NULL,
      email         TEXT,
      department_id UUID REFERENCES pf_portal_departments(id) ON DELETE SET NULL,
      created_at    TIMESTAMPTZ DEFAULT now()
    )`;
  // 職場（部署配下の単位）。admin_user_id はこの職場の管理者（pf_portal_users.id）。
  // ※ admin_user_id は循環参照回避と冪等マイグレーション簡素化のため FK なしの UUID 列（アプリ側で整合を担保）。
  await sql`
    CREATE TABLE IF NOT EXISTS pf_portal_workplaces (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      department_id UUID NOT NULL REFERENCES pf_portal_departments(id) ON DELETE CASCADE,
      code          TEXT UNIQUE NOT NULL,
      name          TEXT NOT NULL,
      admin_user_id UUID,
      sort          INT NOT NULL DEFAULT 0,
      created_at    TIMESTAMPTZ DEFAULT now()
    )`;
  // 既存 pf_portal_users への冪等マイグレーション（権限・職場・承認者）。
  // role は 'admin' | 'member'（アプリ側で担保）。workplace_id / approver_user_id は
  // サーバーレスでの段階的マイグレーションを単純にするため FK なしの UUID 列（削除時はアプリ側で NULL 化）。
  await sql`ALTER TABLE pf_portal_users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'member'`;
  await sql`ALTER TABLE pf_portal_users ADD COLUMN IF NOT EXISTS workplace_id UUID`;
  await sql`ALTER TABLE pf_portal_users ADD COLUMN IF NOT EXISTS approver_user_id UUID`;
  // ポータル管理権限（マスターが指名した設定担当者）。manage_password_hash は scrypt 形式
  // "scrypt$<hexsalt>$<hexhash>"（lib/portalAuth.js 参照）。can_manage=false でもハッシュは保持する。
  await sql`ALTER TABLE pf_portal_users ADD COLUMN IF NOT EXISTS can_manage BOOLEAN NOT NULL DEFAULT false`;
  await sql`ALTER TABLE pf_portal_users ADD COLUMN IF NOT EXISTS manage_password_hash TEXT`;
  await sql`
    CREATE TABLE IF NOT EXISTS pf_portal_provisions (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    UUID REFERENCES pf_portal_users(id) ON DELETE CASCADE,
      app_key    TEXT NOT NULL,
      status     TEXT NOT NULL,
      invite_url TEXT,
      updated_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE (user_id, app_key)
    )`;
  // パスワード設定状況（アプリ /api/provision v2.1 の passwordSet）。null = 不明（旧アプリ・未取得）。
  await sql`ALTER TABLE pf_portal_provisions ADD COLUMN IF NOT EXISTS password_set BOOLEAN`;
  const rows = await sql`SELECT count(*)::int AS n FROM pf_portal_departments`;
  if (rows[0] && rows[0].n === 0) {
    for (const d of DEFAULT_DEPARTMENTS) {
      await sql`
        INSERT INTO pf_portal_departments (code, kind, name, description, apps, sort)
        VALUES (${d.code}, ${d.kind}, ${d.name}, ${d.description}, ${JSON.stringify(d.apps)}::jsonb, ${d.sort})
        ON CONFLICT (name) DO NOTHING`;
    }
  }
  // 新アプリ hoju（補充計画）を標準部門へ冪等追加（既に投入済みのDBにも反映されるよう1回だけ補正）。
  // 「すべてのアプリ」(D999) には常に、調達部(D002) には既定として追加。既にあれば何もしない。
  await sql`
    UPDATE pf_portal_departments
    SET apps = apps || '["hoju"]'::jsonb
    WHERE code = 'D999' AND NOT (apps @> '["hoju"]')`;
  await sql`
    UPDATE pf_portal_departments
    SET apps = apps || '["hoju"]'::jsonb, description = '計画・補充・図面・在庫・型'
    WHERE code = 'D002' AND NOT (apps @> '["hoju"]')`;
  // 新アプリ tenchu（転注管理）を標準部門へ冪等追加（既存DBにも反映されるよう1回だけ補正）。
  // 「すべてのアプリ」(D999)・生産管理部(D001)・調達部(D002) に既定として追加。既にあれば何もしない。
  await sql`
    UPDATE pf_portal_departments
    SET apps = apps || '["tenchu"]'::jsonb
    WHERE code = 'D999' AND NOT (apps @> '["tenchu"]')`;
  await sql`
    UPDATE pf_portal_departments
    SET apps = apps || '["tenchu"]'::jsonb, description = '計画・日報・出荷・在庫・転注'
    WHERE code = 'D001' AND NOT (apps @> '["tenchu"]')`;
  await sql`
    UPDATE pf_portal_departments
    SET apps = apps || '["tenchu"]'::jsonb, description = '計画・補充・図面・在庫・型・転注'
    WHERE code = 'D002' AND NOT (apps @> '["tenchu"]')`;
  _schemaReady = true;
}

// リクエストボディ（Vercel は Content-Type: application/json なら自動パース済み）
function readBody(req) {
  const b = req.body;
  if (b === undefined || b === null) return {};
  if (typeof b === "string") {
    try { return JSON.parse(b); } catch { return {}; }
  }
  return typeof b === "object" ? b : {};
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
function isUuid(v) {
  return typeof v === "string" && UUID_RE.test(v);
}

// DATABASE_URL 未設定なら 503 を書き込んで null を返す
function requireSql(res) {
  const sql = getSql();
  if (!sql) {
    res.status(503).json({ message: "データベースが未設定です（DATABASE_URL）" });
    return null;
  }
  return sql;
}

module.exports = { getSql, requireSql, ensureSchema, readBody, isUuid, ALL_APP_KEYS, DEFAULT_DEPARTMENTS };
