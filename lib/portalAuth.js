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

// ===== 利用者セッション（HttpOnly cookie `pf_user` = "exp.loginId.hmac"）=====
// pf_admin と同じ3部形式・同じパース規則（login_id が '.' を含み得るため、
// 最初の '.' の前を exp、最後の '.' の後を HMAC として解釈）。
// ※HMAC 入力には接頭辞 "user." を付けて署名ドメインを分離する
//   （pf_user の値を pf_admin cookie に流用して管理セッションに化けるのを防ぐ）。
const USER_COOKIE_NAME = "pf_user";
const USER_SIGN_PREFIX = "user";

function createUserSessionValue(secret, loginId) {
  const exp = Date.now() + SESSION_HOURS * 60 * 60 * 1000;
  const id = String(loginId);
  return `${exp}.${id}.${sign(`${USER_SIGN_PREFIX}.${exp}.${id}`, secret)}`;
}

// 利用者セッション検証。有効なら { loginId } を返し、無効なら null。
function verifyUserSession(req) {
  const secret = getSecret();
  if (!secret) return null;
  const value = parseCookies(req)[USER_COOKIE_NAME];
  if (!value) return null;
  const first = value.indexOf(".");
  const last = value.lastIndexOf(".");
  if (first <= 0 || last <= first + 1) return null;
  const exp = Number(value.slice(0, first));
  const loginId = value.slice(first + 1, last);
  const mac = value.slice(last + 1);
  if (!loginId || !Number.isFinite(exp) || exp < Date.now()) return null;
  const expected = sign(`${USER_SIGN_PREFIX}.${exp}.${loginId}`, secret);
  const a = Buffer.from(mac, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  return { loginId };
}

function userSessionCookie(value, maxAgeSec) {
  return `${USER_COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

function setUserSessionCookie(res, value) {
  res.setHeader("Set-Cookie", userSessionCookie(value, SESSION_HOURS * 60 * 60));
}

function clearUserSessionCookie(res) {
  res.setHeader("Set-Cookie", userSessionCookie("", 0));
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

// 管理セッション必須（マスターパスワード、または「ポータル管理権限」を持つユーザーのみ）。
// ※ 承認フロー上の管理者権限（pf_portal_users.role='admin'）では管理画面に入れない。
//    管理画面のアクセス可否は can_manage（ポータル管理権限）だけで決まる。
// cookie の署名だけでなく毎回 DB の can_manage を確認する（権限を外した直後でも、
// 手元に残っているセッションを即座に無効化するため）。
// OK なら { kind, isMaster, loginId } を返す。NG なら 401/503 を書き込んで null。
async function requireManageSession(req, res, sql) {
  if (!getSecret()) {
    res.status(503).json({ message: "サーバー設定が未完了です（PORTAL_SESSION_SECRET）" });
    return null;
  }
  const session = verifySession(req);
  if (!session) {
    res.status(401).json({ message: "管理者ログインが必要です" });
    return null;
  }
  if (session.isMaster) return session;
  if (!sql) {
    // DB を参照できない呼び出しでは権限を確認できないため許可しない
    res.status(503).json({ message: "サーバー設定が未完了です（データベース）" });
    return null;
  }
  try {
    const rows = await sql`
      SELECT can_manage, manage_password_hash
      FROM pf_portal_users WHERE login_id = ${session.loginId} LIMIT 1`;
    const u = rows[0];
    if (!u || u.can_manage !== true || !u.manage_password_hash) {
      clearSessionCookie(res);
      res.status(401).json({ message: "ポータル管理権限がありません。再度ログインしてください。" });
      return null;
    }
  } catch (e) {
    console.error("[portalAuth] manage check failed:", e && e.message);
    res.status(503).json({ message: "サーバーエラーが発生しました（権限確認）" });
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
  USER_COOKIE_NAME,
  SESSION_HOURS,
  createUserSessionValue,
  verifyUserSession,
  setUserSessionCookie,
  clearUserSessionCookie,
  MASTER_KIND,
  getSecret,
  createSessionValue,
  verifySession,
  setSessionCookie,
  clearSessionCookie,
  // 非同期（DB の can_manage を毎回確認する）。呼び出し側は必ず await すること。
  // ※ 旧 requireManage / requireAdmin（同期・cookie のみ検証）は削除した。
  //    await 無しで呼ぶと Promise が truthy になり素通りするため、名前ごと変えて誤用を防ぐ。
  requireManageSession,
  hashManagePassword,
  verifyManagePassword,
};
