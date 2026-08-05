// LINE WORKS Bot 連携（Server API 2.0 / Service Account 認証）。
// 承認通知など「ポータル → 社員のLINE WORKS」への簡単なメッセージ送信に使う。
// 追加パッケージなし（JWT の RS256 署名は Node 標準 crypto で行う）。
//
// 必要な環境変数（未設定なら isConfigured() が false になり、呼び出し側は送信をスキップする）:
//   LINEWORKS_CLIENT_ID      Developer Console のアプリ Client ID
//   LINEWORKS_CLIENT_SECRET  同 Client Secret
//   LINEWORKS_SERVICE_ACCOUNT  Service Account ID（例 xxxxx.serviceaccount@会社ドメイン）
//   LINEWORKS_PRIVATE_KEY    Service Account の Private Key（PEM。改行は \n 表記でも可）
//   LINEWORKS_BOT_ID         メッセージ送信に使う Bot の ID
// セットアップ手順は docs/lineworks.md を参照。
const crypto = require("crypto");

const TOKEN_URL = "https://auth.worksmobile.com/oauth2/v2.0/token";
const API_BASE = "https://www.worksapis.com/v1.0";
// Bot のテキストメッセージ上限（超過分は送信側で切り詰める）
const MAX_TEXT_LEN = 2000;
const FETCH_TIMEOUT_MS = 10000;

function env(name) {
  return (process.env[name] || "").trim();
}

// Vercel の環境変数は改行をそのまま入れられるが、"\n" エスケープで貼られることも多いので両対応する
function privateKeyPem() {
  const raw = env("LINEWORKS_PRIVATE_KEY");
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

// 設定状況。ok=false のとき missing に足りない環境変数名が入る（管理画面の表示に使う）
function configStatus() {
  const required = [
    "LINEWORKS_CLIENT_ID",
    "LINEWORKS_CLIENT_SECRET",
    "LINEWORKS_SERVICE_ACCOUNT",
    "LINEWORKS_PRIVATE_KEY",
    "LINEWORKS_BOT_ID",
  ];
  const missing = required.filter((n) => !env(n));
  return { ok: missing.length === 0, missing };
}

function isConfigured() {
  return configStatus().ok;
}

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

// Service Account 認証用の JWT（RS256）。iss=Client ID / sub=Service Account / 有効 60 分。
function buildJwt() {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({
    iss: env("LINEWORKS_CLIENT_ID"),
    sub: env("LINEWORKS_SERVICE_ACCOUNT"),
    iat: now,
    exp: now + 60 * 60,
  }));
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(privateKeyPem()).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// アクセストークン（有効 24 時間）はモジュール変数にキャッシュし、期限 5 分前で取り直す。
// サーバーレスでもウォームなインスタンス間で再利用され、トークン発行の回数を抑えられる。
let _token = null; // { value, exp(epoch ms) }

async function getAccessToken() {
  if (_token && _token.exp - 5 * 60 * 1000 > Date.now()) return _token.value;
  const body = new URLSearchParams({
    assertion: buildJwt(),
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    client_id: env("LINEWORKS_CLIENT_ID"),
    client_secret: env("LINEWORKS_CLIENT_SECRET"),
    scope: "bot",
  });
  const r = await fetchWithTimeout(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = await r.json().catch(() => null);
  if (!r.ok || !data || !data.access_token) {
    const detail = data ? JSON.stringify(data).slice(0, 300) : `HTTP ${r.status}`;
    throw new Error(`LINE WORKS トークン取得に失敗しました: ${detail}`);
  }
  const expiresInSec = Number(data.expires_in) > 0 ? Number(data.expires_in) : 3600;
  _token = { value: data.access_token, exp: Date.now() + expiresInSec * 1000 };
  return _token.value;
}

/**
 * Bot からユーザーへテキストメッセージを 1 通送る。
 * userId は LINE WORKS のメンバー ID（管理画面のメンバー詳細で確認できる UUID）または
 * ログイン ID（メール形式 xxx@会社ドメイン）のどちらでもよい。
 * 成功で true。設定不足は送らず false（呼び出し元の業務は止めない）。API エラーは例外を投げる。
 */
async function sendTextToUser(userId, text) {
  if (!isConfigured()) return false;
  const to = String(userId || "").trim();
  const t = String(text || "").trim();
  if (!to || !t) return false;
  const message = t.length > MAX_TEXT_LEN ? t.slice(0, MAX_TEXT_LEN - 1) + "…" : t;

  const send = async (token) =>
    fetchWithTimeout(`${API_BASE}/bots/${encodeURIComponent(env("LINEWORKS_BOT_ID"))}/users/${encodeURIComponent(to)}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: { type: "text", text: message } }),
    });

  let r = await send(await getAccessToken());
  // キャッシュ中のトークンが失効・剥奪されていたら 1 回だけ取り直して再送する
  if (r.status === 401) {
    _token = null;
    r = await send(await getAccessToken());
  }
  if (!r.ok) {
    const bodyText = await r.text().catch(() => "");
    throw new Error(`LINE WORKS 送信に失敗しました (HTTP ${r.status}): ${bodyText.slice(0, 300)}`);
  }
  return true;
}

module.exports = { configStatus, isConfigured, sendTextToUser, MAX_TEXT_LEN };
