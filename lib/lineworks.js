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

// 環境変数に貼られた Private Key を、OpenSSL が読める PEM に正規化する。
// 貼り付け方が揺れても通るように、次のいずれも受け付ける:
//   1. 正しい改行入りの PEM（そのまま）
//   2. "\n" エスケープ表記（実際の改行に戻す）
//   3. 改行が失われた／スペースに化けた PEM（本体を64文字で折り返し直す）
// 3 を直さないと Node は "error:1E08010C:DECODER routines::unsupported" で
// 署名に失敗する。環境変数への貼り付けで最も起きやすい壊れ方なので復元する。
function privateKeyPem() {
  const raw = env("LINEWORKS_PRIVATE_KEY");
  if (!raw) return "";
  const unescaped = raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
  const m = unescaped.match(/-----BEGIN ([A-Z0-9 ]+?)-----([\s\S]*?)-----END [A-Z0-9 ]+?-----/);
  if (!m) return unescaped; // PEM に見えないものは触らず、そのまま失敗させる
  const label = m[1].trim();
  const body = m[2].replace(/[^A-Za-z0-9+/=]/g, ""); // 改行・空白・引用符などを除去
  const lines = body.match(/.{1,64}/g);
  if (!lines) return unescaped;
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/**
 * LINEWORKS_PRIVATE_KEY の「形」だけを報告する診断（管理者専用APIからのみ呼ぶこと）。
 * 貼り付け崩れの切り分け用。鍵本体（Base64の中身）は一切返さない。
 * 先頭・末尾の文字コードを返すのは、ダッシュが全角や en dash に化けている・
 * BOM や引用符が混ざっているといった、目視では気付けない壊れ方を見分けるため。
 */
function diagnosePrivateKey() {
  const raw = env("LINEWORKS_PRIVATE_KEY");
  const out = {
    present: !!raw,
    rawLength: raw.length,
    expectedLengthAround: 1704,
    lineCount: raw ? raw.trim().split(/\r?\n/).length : 0,
    expectedLineCount: 28,
    hasEscapedNewline: raw.includes("\\n"),
    beginMarkerFound: /-----BEGIN [A-Z0-9 ]+-----/.test(raw),
    endMarkerFound: /-----END [A-Z0-9 ]+-----/.test(raw),
    // マーカーが壊れている場合に備え、ASCII外の文字が混ざっていないかも見る
    hasNonAscii: /[^\x00-\x7F]/.test(raw),
    headCharCodes: Array.from(raw.slice(0, 12)).map((c) => c.charCodeAt(0)),
    tailCharCodes: Array.from(raw.slice(-12)).map((c) => c.charCodeAt(0)),
    base64BodyLength: null,
    expectedBase64BodyLength: 1624,
    derBytes: null,
    expectedDerBytes: 1217,
    canSign: false,
    signError: null,
  };
  const m = raw.replace(/\\n/g, "\n").match(/-----BEGIN [A-Z0-9 ]+?-----([\s\S]*?)-----END [A-Z0-9 ]+?-----/);
  if (m) {
    const b64 = m[1].replace(/[^A-Za-z0-9+/=]/g, "");
    out.base64BodyLength = b64.length;
    try {
      out.derBytes = Buffer.from(b64, "base64").length;
    } catch {
      out.derBytes = null;
    }
  }
  // 正規化後に実際に署名できるかまで確かめる（これが最終的な合否）
  try {
    const s = crypto.createSign("RSA-SHA256");
    s.update("diag");
    s.sign(privateKeyPem());
    out.canSign = true;
  } catch (e) {
    out.signError = e && e.message ? e.message : String(e);
  }
  return out;
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
  let signature;
  try {
    signature = signer.sign(privateKeyPem()).toString("base64url");
  } catch (e) {
    // OpenSSL の生メッセージ（DECODER routines::unsupported 等）だけでは
    // 原因が分からないため、どこを直せばよいかを添えて投げ直す。
    throw new Error(
      "LINEWORKS_PRIVATE_KEY を読み込めません。Developer Console で発行した" +
      "Private Key の中身（-----BEGIN PRIVATE KEY----- から -----END PRIVATE KEY----- まで）を" +
      "そのまま貼り付けてください: " + (e && e.message ? e.message : e)
    );
  }
  return `${header}.${payload}.${signature}`;
}

// トークン発行時に要求するスコープ。Bot送信は "bot"（既定）。
// Developer Console 側のスコープ名が異なる場合に備え、LINEWORKS_SCOPE で上書きできる
// （スペース区切りで複数指定も可）。
function requestedScope() {
  return env("LINEWORKS_SCOPE") || "bot";
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
    scope: requestedScope(),
  });
  const r = await fetchWithTimeout(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = await r.json().catch(() => null);
  if (!r.ok || !data || !data.access_token) {
    // invalid_scope は「アプリにそのスコープが付いていない」ときに返る。
    // 生のJSONだけでは Console のどこを直せばよいか分からないので補足する。
    if (data && data.error === "invalid_scope") {
      throw new Error(
        `LINE WORKS がスコープ「${requestedScope()}」を受け付けませんでした。` +
        "Developer Console のアプリ設定で OAuth Scope に bot を追加し、保存してから数分待って再試行してください。" +
        "Console のスコープ名が bot 以外の場合は、環境変数 LINEWORKS_SCOPE にその名前を設定してください。"
      );
    }
    const detail = data ? JSON.stringify(data).slice(0, 300) : `HTTP ${r.status}`;
    throw new Error(`LINE WORKS トークン取得に失敗しました: ${detail}`);
  }
  const expiresInSec = Number(data.expires_in) > 0 ? Number(data.expires_in) : 3600;
  _token = { value: data.access_token, exp: Date.now() + expiresInSec * 1000 };
  return _token.value;
}

/**
 * Bot 側の設定を切り分ける診断（管理者専用APIからのみ呼ぶこと）。
 * トークンが取れるか → このアプリが操作できる Bot 一覧に LINEWORKS_BOT_ID があるか、を確かめる。
 * 一覧に無ければ「Bot ID 違い、または別アプリで作った Bot」。
 * 一覧にあるのに送信が 403 なら「管理者画面で Bot が未公開、または公開範囲に宛先が入っていない」。
 * アクセストークンは返さない。失敗しても例外は投げず、理由を文字列で返す。
 */
async function diagnoseBot() {
  const out = {
    configuredBotId: env("LINEWORKS_BOT_ID"),
    scope: requestedScope(),
    tokenOk: false,
    tokenError: null,
    botListOk: false,
    botListError: null,
    bots: [],
    configuredBotFound: null,
  };
  let token;
  try {
    token = await getAccessToken();
    out.tokenOk = true;
  } catch (e) {
    out.tokenError = e && e.message ? e.message : String(e);
    return out;
  }
  try {
    const r = await fetchWithTimeout(`${API_BASE}/bots`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = await r.text().catch(() => "");
    if (!r.ok) {
      out.botListError = `HTTP ${r.status}: ${text.slice(0, 200)}`;
      return out;
    }
    const data = JSON.parse(text);
    const list = Array.isArray(data.bots) ? data.bots : [];
    out.botListOk = true;
    out.bots = list.map((b) => ({ botId: String(b.botId), name: b.botName || b.name || "" }));
    out.configuredBotFound = out.bots.some((b) => b.botId === String(out.configuredBotId));
  } catch (e) {
    out.botListError = e && e.message ? e.message : String(e);
  }
  return out;
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

module.exports = { configStatus, isConfigured, sendTextToUser, diagnosePrivateKey, diagnoseBot, MAX_TEXT_LEN };
