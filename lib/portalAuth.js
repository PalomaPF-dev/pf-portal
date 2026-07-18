// 管理セッション（HttpOnly cookie `pf_admin` = "exp.kind.hmac"）。
// kind は 'master'（マスターパスワード）またはログインしたユーザーの login_id。
// HMAC-SHA256("exp.kind") を PORTAL_SESSION_SECRET で署名。有効期限 12 時間。
// ※ 旧形式（"exp.hmac" の2部構成）は無効として扱う（再ログインで新形式に移行）。
const crypto = require("crypto");

const COOKIE_NAME = "pf_admin";
const SESSION_HOURS = 12;
const MASTER_KIND = "master";

function getSecret() {
  return (process.env.PORTAL_SESSION_SECRET || "").trim() || null;
}

function sign(payload, secret) {
  return crypto.createHmac("sha256", secret).update(String(payload)).digest("hex");
}

// "有効期限(epoch ms).kind.HMAC" 形式のセッション値を作る。kind 省略時はマスター。
function createSessionValue(secret, kind) {
  const exp = Date.now() + SESSION_HOURS * 60 * 60 * 1000;
  const k = String(kind || MASTER_KIND);
  return `${exp}.${k}.${sign(`${exp}.${k}`, secret)}`;
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

// セッション検証。有効なら { kind, isMaster, loginId } を返し、無効なら null。
// kind（= login_id）には '.' を含み得るため、最初の '.' の前を exp、最後の '.' の後を HMAC として解釈する。
function verifySession(req) {
  const secret = getSecret();
  if (!secret) return null;
  const value = parseCookies(req)[COOKIE_NAME];
  if (!value) return null;
  const first = value.indexOf(".");
  const last = value.lastIndexOf(".");
  if (first <= 0 || last <= first + 1) return null; // 旧2部形式・不正形式は無効
  const exp = Number(value.slice(0, first));
  const kind = value.slice(first + 1, last);
  const mac = value.slice(last + 1);
  if (!kind || !Number.isFinite(exp) || exp < Date.now()) return null;
  const expected = sign(`${exp}.${kind}`, secret);
  const a = Buffer.from(mac, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  return { kind, isMaster: kind === MASTER_KIND, loginId: kind === MASTER_KIND ? null : kind };
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

// 管理セッション必須（マスター・ポータル管理権限ユーザーの両方を許可）。
// OK なら { kind, isMaster, loginId } を返す。NG なら 401/503 を書き込んで null。
function requireManage(req, res) {
  if (!getSecret()) {
    res.status(503).json({ message: "サーバー設定が未完了です（PORTAL_SESSION_SECRET）" });
    return null;
  }
  const session = verifySession(req);
  if (!session) {
    res.status(401).json({ message: "管理者ログインが必要です" });
    return null;
  }
  return session;
}

// ===== 管理用パスワード（scrypt）=====
// 保存形式 "scrypt$<hexsalt>$<hexhash>"（salt 16バイト・keylen 64）。Node 標準 crypto のみ使用。

function hashManagePassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

function verifyManagePassword(password, stored) {
  try {
    const parts = String(stored || "").split("$");
    if (parts.length !== 3 || parts[0] !== "scrypt") return false;
    const salt = Buffer.from(parts[1], "hex");
    const expected = Buffer.from(parts[2], "hex");
    if (salt.length !== 16 || expected.length !== 64) return false;
    const hash = crypto.scryptSync(String(password), salt, 64);
    return crypto.timingSafeEqual(hash, expected);
  } catch {
    return false;
  }
}

module.exports = {
  COOKIE_NAME,
  SESSION_HOURS,
  MASTER_KIND,
  getSecret,
  createSessionValue,
  verifySession,
  setSessionCookie,
  clearSessionCookie,
  requireManage,
  // 旧名（マスター専用だった頃の名称）。管理セッション全般を許可する requireManage の別名。
  requireAdmin: requireManage,
  hashManagePassword,
  verifyManagePassword,
};
