// アプリSSOランチャー。GET ?app=<key>
// 有効な pf_user セッション必須。キーが本人の所属部署のアプリに含まれ、かつ
// SSO対応アプリ（zumen 以外）であることを確認し、署名トークン付きで
// `${appBaseUrl(key)}/api/sso?token=...` へ 302 リダイレクトする。
// トークン契約（アプリ側 /api/sso と共通・変更禁止）:
//   payload = base64url(JSON.stringify({loginId, app, exp: Date.now()+60000}))
//   sig     = hex HMAC-SHA256(PF_PROVISION_KEY, payload)
//   token   = `${payload}.${sig}`
const crypto = require("crypto");
const { requireSql, ensureSchema } = require("../lib/db");
const { verifyUserSession } = require("../lib/portalAuth");
const { fetchUserProfile } = require("../lib/userProfile");
const { appBaseUrl } = require("../lib/appUrls");

// SSOで起動できるアプリ（zumen は端末内アプリのためアカウント・SSOなし）
const SSO_APP_KEYS = [
  "keikaku",
  "nippou",
  "sekisai",
  "keisoku",
  "setsubi",
  "hinshitsu",
  "zaiko",
  "kanagata",
  "hoju",
  "tenchu",
];

const TOKEN_TTL_MS = 60 * 1000;

function getAppKey(req) {
  const q = req.query || {};
  let app = typeof q.app === "string" ? q.app : "";
  if (!app && req.url) {
    try {
      app = new URL(req.url, "http://localhost").searchParams.get("app") || "";
    } catch {
      app = "";
    }
  }
  return app.trim();
}

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ message: "Method not allowed" });
    return;
  }

  // 未ログイン（cookie 無し・期限切れ）はトップへ戻してログインさせる（ブラウザ遷移前提のため）
  const session = verifyUserSession(req);
  if (!session) {
    res.statusCode = 302;
    res.setHeader("Location", "/");
    res.end();
    return;
  }

  const app = getAppKey(req);
  if (!app || !SSO_APP_KEYS.includes(app)) {
    res.status(400).json({ message: "このアプリはシングルサインオンに対応していません" });
    return;
  }

  const provisionKey = (process.env.PF_PROVISION_KEY || "").trim();
  if (!provisionKey) {
    res.status(503).json({ message: "サーバー設定が未完了です（PF_PROVISION_KEY）" });
    return;
  }

  const sql = requireSql(res);
  if (!sql) return;
  try {
    await ensureSchema(sql);
    const profile = await fetchUserProfile(sql, session.loginId);
    if (!profile) {
      // 名簿から削除済みなど。トップへ戻して再ログインさせる。
      res.statusCode = 302;
      res.setHeader("Location", "/");
      res.end();
      return;
    }
    if (!profile.apps.includes(app)) {
      res.status(403).json({ message: "このアプリを利用する権限がありません" });
      return;
    }

    const payload = Buffer.from(
      JSON.stringify({ loginId: profile.loginId, app, exp: Date.now() + TOKEN_TTL_MS })
    ).toString("base64url");
    const sig = crypto.createHmac("sha256", provisionKey).update(payload).digest("hex");
    const token = `${payload}.${sig}`;

    res.statusCode = 302;
    res.setHeader("Location", `${appBaseUrl(app)}/api/sso?token=${encodeURIComponent(token)}`);
    res.end();
  } catch (e) {
    console.error("[launch]", e);
    res.status(500).json({ message: "サーバーエラーが発生しました" });
  }
};
