// アプリ横断の「承認待ち」集計。各アプリの /api/approvals/summary を
// 共有シークレット PF_PROVISION_KEY で呼び、pending 件数を集めて返す。
// ログイン中ユーザーの社員番号（loginId）を渡し、各アプリは
// 「その人がいま承認の番」の件数だけを返す（W/F上にいるだけでは数えない）。
// 返り値: [{ app, name, url, pending }]（pending>0 のみ）。
// ※承認申請機能を持つアプリだけを APPROVAL_APPS に列挙する（導入拡大時に追記）。
const { appBaseUrl } = require("../lib/appUrls");
const { verifyUserSession } = require("../lib/portalAuth");

const APPROVAL_APPS = [
  { key: "hinshitsu", name: "品質管理" },
  { key: "setsubi", name: "設備管理" },
  { key: "tenchu", name: "転注管理" },
  { key: "kanagata", name: "型管理" },
  { key: "purchasing", name: "購買単価" },
];

const FETCH_TIMEOUT_MS = 8000;

async function fetchPending(appKey, key, loginId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(`${appBaseUrl(appKey)}/api/approvals/summary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, loginId }),
      signal: controller.signal,
    });
    if (!r.ok) return null;
    const d = await r.json().catch(() => null);
    const n = d && Number.isFinite(Number(d.pending)) ? Math.max(0, Math.trunc(Number(d.pending))) : 0;
    return n;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async (req, res) => {
  const key = (process.env.PF_PROVISION_KEY || "").trim();
  if (!key) {
    res.status(200).json({ apps: [] });
    return;
  }
  // 誰の承認待ちかを特定するため、ログイン中ユーザーの社員番号を各アプリへ渡す。
  // 未ログインなら何も出さない（個人の承認状況を出す表示のため）。
  const session = verifyUserSession(req);
  if (!session) {
    res.status(200).json({ apps: [] });
    return;
  }
  const results = await Promise.all(
    APPROVAL_APPS.map(async (a) => {
      const pending = await fetchPending(a.key, key, session.loginId);
      return { app: a.key, name: a.name, url: appBaseUrl(a.key), pending: pending || 0 };
    }),
  );
  res.status(200).json({ apps: results.filter((a) => a.pending > 0) });
};
