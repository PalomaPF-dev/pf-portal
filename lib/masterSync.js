// 工場・職場マスタの配信（ポータル → 各アプリ）。
//
// ■ 方針（2026-08）
//   工場（部署 kind='factory'）と職場（pf_portal_workplaces）は**ポータルが唯一の正**。
//   ユーザー連携（lib/provision.js）と同じ共有シークレット PF_PROVISION_KEY で、
//   各アプリの POST /api/portal-masters へ工場・職場の一覧を送り、アプリ側の
//   工場・職場マスタを upsert させる。アプリ側での追加・編集は無効化する。
//
// ■ 突合キー
//   工場 = 部署の code（例 F001）、職場 = 職場の code。名称変更に追従できるよう、
//   アプリ側は名前ではなくこの安定コード（portal_code）で突合する。
//
// ■ 職場の親
//   ポータルの職場は「部署」の配下だが、アプリの職場は「工場」の配下。よって
//   **親部署が工場（kind='factory'）の職場だけ**を配信対象にする（factoryCode に親工場の code）。
//   親が一般部署の職場は、アプリ側に対応する工場が無いため送らない。
//
// ■ 削除の扱い（v1）
//   配信は upsert のみ。ポータルから消えた工場・職場のアプリ側自動削除は、
//   在庫・実績ごと CASCADE 消去する破壊的操作になるため v1 では行わない
//   （必要時に手動で対応）。名称変更・並び順・新規追加は追従する。
const { appBaseUrl } = require("./appUrls");

// 工場・職場マスタを受け取れるアプリ（受信 API /api/portal-masters を実装済みのもの）。
// パイロットは zaiko。setsubi / hoju など横展開時にここへ追記する。
const MASTER_SYNC_APP_KEYS = ["zaiko"];

const FETCH_TIMEOUT_MS = 15000;

/**
 * 現在の工場・職場マスタを組み立てる。
 * @returns {Promise<{factories: {code,name,sort}[], workplaces: {code,name,factoryCode,sort}[]}>}
 */
async function buildMasterPayload(sql) {
  const factoryRows = await sql`
    SELECT code, name, sort
    FROM pf_portal_departments
    WHERE kind = 'factory' AND code IS NOT NULL
    ORDER BY sort ASC, name ASC`;
  const workplaceRows = await sql`
    SELECT w.code AS code, w.name AS name, d.code AS factory_code, w.sort AS sort
    FROM pf_portal_workplaces w
    JOIN pf_portal_departments d ON d.id = w.department_id
    WHERE d.kind = 'factory' AND d.code IS NOT NULL
    ORDER BY d.sort ASC, w.sort ASC, w.name ASC`;
  return {
    factories: factoryRows.map((f) => ({
      code: String(f.code),
      name: String(f.name),
      sort: Number(f.sort) || 0,
    })),
    workplaces: workplaceRows.map((w) => ({
      code: String(w.code),
      name: String(w.name),
      factoryCode: String(w.factory_code),
      sort: Number(w.sort) || 0,
    })),
  };
}

/** 1アプリへ配信する。失敗しても例外は投げず結果を返す（他アプリ・呼び出し元を止めない）。 */
async function pushToApp(appKey, payload, key) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(`${appBaseUrl(appKey)}/api/portal-masters`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, ...payload }),
      signal: controller.signal,
    });
    if (!r.ok) return { app: appKey, ok: false, status: r.status };
    const data = await r.json().catch(() => ({}));
    return { app: appKey, ok: true, ...data };
  } catch (e) {
    return { app: appKey, ok: false, error: (e && e.message) || "fetch failed" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 工場・職場マスタを対象アプリへ配信する。best-effort（呼び出し元の処理は止めない）。
 * @param {object} sql
 * @param {{appKeys?: string[]}} [opts] 既定は MASTER_SYNC_APP_KEYS 全部
 * @returns {Promise<{app:string, ok:boolean}[]>}
 */
async function syncMastersToApps(sql, opts = {}) {
  const key = (process.env.PF_PROVISION_KEY || "").trim();
  if (!key) return []; // 鍵未設定なら何もしない（アプリ側も 503 で弾く）
  const appKeys = (opts.appKeys && opts.appKeys.length ? opts.appKeys : MASTER_SYNC_APP_KEYS)
    .filter((k) => MASTER_SYNC_APP_KEYS.includes(k));
  if (appKeys.length === 0) return [];
  const payload = await buildMasterPayload(sql);
  return Promise.all(appKeys.map((app) => pushToApp(app, payload, key)));
}

module.exports = { MASTER_SYNC_APP_KEYS, buildMasterPayload, syncMastersToApps };
