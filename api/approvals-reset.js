// アプリ横断の「滞留承認リセット」（管理者専用）。
// 各アプリの /api/approvals/reset を共有シークレット PF_PROVISION_KEY で呼び、
// 承認待ちのまま滞留している申請をまとめてリセットする。
// 返り値: { results: [{ app, name, ok, reset }] }（reset = リセット件数）。
const { requireAdmin } = require("../lib/portalAuth");
const { appBaseUrl } = require("../lib/appUrls");

// /api/approvals/reset を実装しているアプリだけを列挙する（導入拡大時に追記）。
const RESET_APPS = [
  { key: "hinshitsu", name: "品質管理" },
  { key: "setsubi", name: "設備管理" },
  { key: "tenchu", name: "転注管理" },
  { key: "kanagata", name: "型管理" },
];

const FETCH_TIMEOUT_MS = 8000;

async function resetApp(appKey, key) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(`${appBaseUrl(appKey)}/api/approvals/reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
      signal: controller.signal,
    });
    if (!r.ok) return { ok: false, reset: 0 };
    const d = await r.json().catch(() => null);
    const n = d && Number.isFinite(Number(d.reset)) ? Math.max(0, Math.trunc(Number(d.reset))) : 0;
    return { ok: true, reset: n };
  } catch {
    return { ok: false, reset: 0 };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ message: "Method not allowed" });
    return;
  }
  if (!requireAdmin(req, res)) return;
  const key = (process.env.PF_PROVISION_KEY || "").trim();
  if (!key) {
    res.status(503).json({ message: "サーバー設定が未完了です（PF_PROVISION_KEY）" });
    return;
  }
  const results = await Promise.all(
    RESET_APPS.map(async (a) => {
      const r = await resetApp(a.key, key);
      return { app: a.key, name: a.name, ok: r.ok, reset: r.reset };
    }),
  );
  res.status(200).json({ results });
};
