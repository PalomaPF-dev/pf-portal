// 管理者ログイン。
// POST {password} → PF_ADMIN_BOOTSTRAP_HASH と bcrypt 照合。成功で HttpOnly cookie pf_admin を発行（12時間）。
// DELETE → ログアウト（cookie 破棄）。
// レート制限: 同一IP 10分10回。
const bcrypt = require("bcryptjs");
const { readBody } = require("../lib/db");
const { getSecret, createSessionValue, setSessionCookie, clearSessionCookie } = require("../lib/portalAuth");

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

  const hash = (process.env.PF_ADMIN_BOOTSTRAP_HASH || "").trim();
  const secret = getSecret();
  if (!hash || !secret) {
    res.status(503).json({ message: "サーバー設定が未完了です（管理者パスワード/セッション秘密鍵）" });
    return;
  }

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) {
    res.status(429).json({ message: "試行回数が多すぎます。時間をおいて再度お試しください。" });
    return;
  }

  const body = readBody(req);
  const password = String(body.password || "");
  if (!password) {
    res.status(400).json({ message: "パスワードを入力してください" });
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

  setSessionCookie(res, createSessionValue(secret));
  res.status(200).json({ ok: true });
};
