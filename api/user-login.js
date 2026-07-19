// 利用者ログイン。
// POST {loginId, password}
//  - ユーザーが存在し password_hash 未設定（NULL）→ 409 {needsSetup:true}（初回設定へ誘導）
//  - scrypt 照合成功 → HttpOnly cookie pf_user（"exp.loginId.hmac"・12時間）を発行し、
//    本人の所属部署のアプリ一覧を返す（部署未設定なら apps:[] と noDepartment:true）
// DELETE → ログアウト（cookie 破棄）。
// レート制限: 同一IP 10分10回（admin-login と同様）。
const { requireSql, ensureSchema, readBody } = require("../lib/db");
const {
  getSecret,
  createUserSessionValue,
  setUserSessionCookie,
  clearUserSessionCookie,
  verifyManagePassword,
} = require("../lib/portalAuth");
const { fetchUserProfile, profileResponse } = require("../lib/userProfile");

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
    clearUserSessionCookie(res);
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
  const loginId = String(body.loginId || "").trim();
  const password = String(body.password || "");
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
    console.error("[user-login]", e);
    res.status(500).json({ message: "サーバーエラーが発生しました" });
  }
};
