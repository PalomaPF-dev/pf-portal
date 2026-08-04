// 利用者向けAPI（統合版）。Vercel Hobby の「1デプロイ12関数まで」制限に収めるため、
// user-login / user-first-login / user-session / launch の4関数を1つに統合した。
//   GET  ?launch=<appKey> → アプリSSOランチャー（署名トークン付きで各アプリ /api/sso へ 302）
//   GET  （launch なし）   → セッション確認（pf_user cookie 検証 + プロフィール返却）
//   POST {action:"setup", loginId, password} → 初回パスワード設定（password_hash 未設定のユーザーのみ）
//   POST {loginId, password}（action省略/"login"）→ ログイン（未設定なら 409 needsSetup）
//   DELETE → ログアウト（cookie 破棄）
// レート制限: POST のみ同一IP 10分10回（admin-login と同様）。
const crypto = require("crypto");
const { requireSql, ensureSchema, readBody } = require("../lib/db");
const {
  getSecret,
  createUserSessionValue,
  setUserSessionCookie,
  clearUserSessionCookie,
  verifyUserSession,
  verifyManagePassword,
  hashManagePassword,
} = require("../lib/portalAuth");
const { fetchUserProfile, profileResponse } = require("../lib/userProfile");
const { appBaseUrl } = require("../lib/appUrls");

const LOGIN_ID_RE = /^[A-Za-z0-9_@.-]+$/;

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
  "purchasing",
  "jinji",
];

const TOKEN_TTL_MS = 60 * 1000;

const RL = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const WIN = 10 * 60 * 1000;
  const MAX = 10;
  const arr = (RL.get(ip) || []).filter((t) => now - t < WIN);
  if (arr.length >= MAX) {
    RL.set(ip, arr);
    return true;
  }
  arr.push(now);
  RL.set(ip, arr);
  return false;
}

function queryParam(req, name) {
  const q = req.query || {};
  let v = typeof q[name] === "string" ? q[name] : "";
  if (!v && req.url) {
    try {
      v = new URL(req.url, "http://localhost").searchParams.get(name) || "";
    } catch {
      v = "";
    }
  }
  return v.trim();
}

// ===== GET ?launch=<key>: SSOランチャー =====
async function handleLaunch(req, res, app) {
  const session = verifyUserSession(req);
  if (!session) {
    // 未ログインはトップへ戻してログインさせる（ブラウザ遷移前提）
    res.statusCode = 302;
    res.setHeader("Location", "/");
    res.end();
    return;
  }
  if (!SSO_APP_KEYS.includes(app)) {
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
      res.statusCode = 302;
      res.setHeader("Location", "/");
      res.end();
      return;
    }
    if (!profile.apps.includes(app)) {
      res.status(403).json({ message: "このアプリを利用する権限がありません" });
      return;
    }
    // role / name も渡し、アプリ側でアカウント未発行でも正しい権限・氏名でログインできるようにする。
    // 旧アプリは loginId / app / exp のみを参照するため、追加フィールドがあっても影響しない。
    const payload = Buffer.from(
      JSON.stringify({
        loginId: profile.loginId,
        name: profile.name,
        role: profile.role,
        app,
        exp: Date.now() + TOKEN_TTL_MS,
      })
    ).toString("base64url");
    const sig = crypto.createHmac("sha256", provisionKey).update(payload).digest("hex");
    res.statusCode = 302;
    res.setHeader(
      "Location",
      `${appBaseUrl(app)}/api/sso?token=${encodeURIComponent(`${payload}.${sig}`)}`
    );
    res.end();
  } catch (e) {
    console.error("[user:launch]", e);
    res.status(500).json({ message: "サーバーエラーが発生しました" });
  }
}

// ===== GET: セッション確認 =====
async function handleSession(req, res) {
  if (!getSecret()) {
    res.status(503).json({ message: "サーバー設定が未完了です（PORTAL_SESSION_SECRET）" });
    return;
  }
  const session = verifyUserSession(req);
  if (!session) {
    res.status(401).json({ message: "ログインが必要です" });
    return;
  }
  const sql = requireSql(res);
  if (!sql) return;
  try {
    await ensureSchema(sql);
    const profile = await fetchUserProfile(sql, session.loginId);
    if (!profile) {
      // 名簿から削除済みなど。cookie を破棄して再ログインへ。
      clearUserSessionCookie(res);
      res.status(401).json({ message: "ログインが必要です" });
      return;
    }
    res.status(200).json(profileResponse(profile));
  } catch (e) {
    console.error("[user:session]", e);
    res.status(500).json({ message: "サーバーエラーが発生しました" });
  }
}

// ===== POST action:"setup": 初回パスワード設定 =====
async function handleSetup(req, res, loginId, password) {
  if (!loginId || !LOGIN_ID_RE.test(loginId) || loginId.length > 64) {
    res.status(400).json({ message: "社員番号（ID）の形式が正しくありません" });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ message: "パスワードは8文字以上で設定してください" });
    return;
  }
  const sql = requireSql(res);
  if (!sql) return;
  try {
    await ensureSchema(sql);
    const rows = await sql`
      SELECT id, password_hash FROM pf_portal_users WHERE login_id = ${loginId} LIMIT 1`;
    const u = rows[0];
    if (!u) {
      res.status(404).json({ message: "社員番号が見つかりません。管理者にお問い合わせください" });
      return;
    }
    if (u.password_hash) {
      res.status(409).json({ message: "既に設定済みです。通常のログインをお使いください" });
      return;
    }
    // 競合時も未設定の場合だけ更新（WHERE で再チェック）
    const updated = await sql`
      UPDATE pf_portal_users
      SET password_hash = ${hashManagePassword(password)}
      WHERE id = ${u.id} AND password_hash IS NULL
      RETURNING id`;
    if (updated.length === 0) {
      res.status(409).json({ message: "既に設定済みです。通常のログインをお使いください" });
      return;
    }
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error("[user:setup]", e);
    res.status(500).json({ message: "サーバーエラーが発生しました" });
  }
}

// ===== POST（既定）: ログイン =====
async function handleLogin(req, res, loginId, password) {
  const secret = getSecret();
  if (!secret) {
    res.status(503).json({ message: "サーバー設定が未完了です（セッション秘密鍵）" });
    return;
  }
  if (!loginId || !password) {
    res.status(400).json({ message: "社員番号とパスワードを入力してください" });
    return;
  }
  if (!LOGIN_ID_RE.test(loginId) || loginId.length > 64) {
    res.status(400).json({ message: "社員番号（ID）の形式が正しくありません" });
    return;
  }
  const sql = requireSql(res);
  if (!sql) return;
  try {
    await ensureSchema(sql);
    const profile = await fetchUserProfile(sql, loginId);
    if (!profile) {
      res.status(401).json({ message: "社員番号またはパスワードが違います" });
      return;
    }
    if (!profile.passwordHash) {
      res.status(409).json({ needsSetup: true, message: "初回ログインのため、パスワードの設定が必要です" });
      return;
    }
    if (!verifyManagePassword(password, profile.passwordHash)) {
      res.status(401).json({ message: "社員番号またはパスワードが違います" });
      return;
    }
    setUserSessionCookie(res, createUserSessionValue(secret, profile.loginId));
    res.status(200).json(profileResponse(profile));
  } catch (e) {
    console.error("[user:login]", e);
    res.status(500).json({ message: "サーバーエラーが発生しました" });
  }
}

module.exports = async (req, res) => {
  if (req.method === "DELETE") {
    clearUserSessionCookie(res);
    res.status(200).json({ ok: true });
    return;
  }

  if (req.method === "GET") {
    const app = queryParam(req, "launch");
    if (app) return handleLaunch(req, res, app);
    return handleSession(req, res);
  }

  if (req.method !== "POST") {
    res.status(405).json({ message: "Method not allowed" });
    return;
  }

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) {
    res.status(429).json({ message: "試行回数が多すぎます。時間をおいて再度お試しください。" });
    return;
  }

  const body = readBody(req);
  const action = String(body.action || "login");
  const loginId = String(body.loginId || "").trim();
  const password = String(body.password || "");
  if (action === "setup") return handleSetup(req, res, loginId, password);
  return handleLogin(req, res, loginId, password);
};
