// 管理者セッション（HttpOnly cookie `pf_admin` = "exp.hmac"）。
// PORTAL_SESSION_SECRET で HMAC-SHA256 署名。有効期限 12 時間。
const crypto = require("crypto");

const COOKIE_NAME = "pf_admin";
const SESSION_HOURS = 12;

function getSecret() {
  return (process.env.PORTAL_SESSION_SECRET || "").trim() || null;
}

function sign(exp, secret) {
  return crypto.createHmac("sha256", secret).update(String(exp)).digest("hex");
}

// "有効期限(epoch ms).HMAC" 形式のセッション値を作る
function createSessionValue(secret) {
  const exp = Date.now() + SESSION_HOURS * 60 * 60 * 1000;
  return `${exp}.${sign(exp, secret)}`;
}

function parseCookies(req) {
  const header = req.headers && req.headers.cookie ? String(req.headers.cookie) : "";
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

function verifySession(req) {
  const secret = getSecret();
  if (!secret) return false;
  const value = parseCookies(req)[COOKIE_NAME];
  if (!value) return false;
  const dot = value.indexOf(".");
  if (dot <= 0) return false;
  const exp = Number(value.slice(0, dot));
  const mac = value.slice(dot + 1);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = sign(exp, secret);
  const a = Buffer.from(mac, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function sessionCookie(value, maxAgeSec) {
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

function setSessionCookie(res, value) {
  res.setHeader("Set-Cookie", sessionCookie(value, SESSION_HOURS * 60 * 60));
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", sessionCookie("", 0));
}

// 管理者セッション必須。OK なら true。NG なら 401/503 を書き込んで false。
function requireAdmin(req, res) {
  if (!getSecret()) {
    res.status(503).json({ message: "サーバー設定が未完了です（PORTAL_SESSION_SECRET）" });
    return false;
  }
  if (!verifySession(req)) {
    res.status(401).json({ message: "管理者ログインが必要です" });
    return false;
  }
  return true;
}

module.exports = {
  COOKIE_NAME,
  SESSION_HOURS,
  getSecret,
  createSessionValue,
  verifySession,
  setSessionCookie,
  clearSessionCookie,
  requireAdmin,
};
