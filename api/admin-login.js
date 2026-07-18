// 管理ログイン。
// POST {password, loginId?}
//  - loginId 空欄: マスターパスワード（PF_ADMIN_BOOTSTRAP_HASH と bcrypt 照合）→ セッション kind='master'
//  - loginId 指定: pf_portal_users の can_manage=true かつ manage_password_hash 設定済みユーザーと
//    scrypt 照合 → セッション kind=login_id（ポータル管理権限ユーザー）
// 成功で HttpOnly cookie pf_admin（"exp.kind.hmac"・12時間）を発行し {ok,kind:'master'|'manager'} を返す。
// DELETE → ログアウト（cookie 破棄）。
// レート制限: 同一IP 10分10回。
const bcrypt = require("bcryptjs");
const { requireSql, ensureSchema, readBody } = require("../lib/db");
const {
  MASTER_KIND,
  getSecret,
  createSessionValue,
  setSessionCookie,
  clearSessionCookie,
  verifyManagePassword,
} = require("../lib/portalAuth");

const LOGIN_ID_RE = /^[A-Za-z0-9_@.-]+$/;

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

module.exports = async (req, res) => {
  if (req.method === "DELETE") {
    clearSessionCookie(res);
    res.status(200).json({ ok: true });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ message: "Method not allowed" });
    return;
  }

  const secret = getSecret();
  if (!secret) {
    res.status(503).json({ message: "サーバー設定が未完了です（セッション秘密鍵）" });
    return;
  }

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) {
    res.status(429).json({ message: "試行回数が多すぎます。時間をおいて再度お試しください。" });
    return;
  }

  const body = readBody(req);
  const password = String(body.password || "");
  const loginId = String(body.loginId || "").trim();
  if (!password) {
    res.status(400).json({ message: "パスワードを入力してください" });
    return;
  }

  // ===== 社員番号あり: ポータル管理権限ユーザーのログイン =====
  if (loginId) {
    if (!LOGIN_ID_RE.test(loginId) || loginId.length > 64) {
      res.status(400).json({ message: "社員番号（ID）の形式が正しくありません" });
      return;
    }
    // 予約語（セッション kind と衝突するためユーザーとしてはログイン不可）
    if (loginId === MASTER_KIND) {
      res.status(401).json({ message: "社員番号またはパスワードが違います" });
      return;
    }
    const sql = requireSql(res);
    if (!sql) return;
    try {
      await ensureSchema(sql);
      const rows = await sql`
        SELECT id, login_id, name, can_manage, manage_password_hash
        FROM pf_portal_users WHERE login_id = ${loginId} LIMIT 1`;
      const u = rows[0];
      if (!u || u.can_manage !== true || !u.manage_password_hash ||
          !verifyManagePassword(password, u.manage_password_hash)) {
        res.status(401).json({ message: "社員番号またはパスワードが違います（ポータル管理権限が必要です）" });
        return;
      }
      setSessionCookie(res, createSessionValue(secret, u.login_id));
      res.status(200).json({ ok: true, kind: "manager", loginId: u.login_id, name: u.name });
    } catch (e) {
      console.error("[admin-login]", e);
      res.status(500).json({ message: "サーバーエラーが発生しました" });
    }
    return;
  }

  // ===== 社員番号なし: マスターパスワード =====
  const hash = (process.env.PF_ADMIN_BOOTSTRAP_HASH || "").trim();
  if (!hash) {
    res.status(503).json({ message: "サーバー設定が未完了です（管理者パスワード）" });
    return;
  }
  let ok = false;
  try {
    ok = await bcrypt.compare(password, hash);
  } catch {
    ok = false;
  }
  if (!ok) {
    res.status(401).json({ message: "パスワードが違います" });
    return;
  }

  setSessionCookie(res, createSessionValue(secret, MASTER_KIND));
  res.status(200).json({ ok: true, kind: "master" });
};
