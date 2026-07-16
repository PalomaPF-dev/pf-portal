// 社内限定ゲートの合言葉検証。POST { code } → PF_GATE_CODE と一致で pf_gate クッキー発行（30日）。
// クッキー値 = "有効期限(epoch ms).HMAC(PF_GATE_SECRET, 有効期限)"。middleware.ts が検証する。
const crypto = require("crypto");

const COOKIE_NAME = "pf_gate";
const DAYS = 30;

module.exports = (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }
  const code = (process.env.PF_GATE_CODE || "").trim();
  const secret = (process.env.PF_GATE_SECRET || "").trim();
  if (!code || !secret) {
    res.status(503).json({ error: "ゲートが未設定です" });
    return;
  }
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const input = body && body.code != null ? String(body.code).trim() : "";
  const a = Buffer.from(input, "utf8");
  const b = Buffer.from(code, "utf8");
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) {
    res.status(401).json({ error: "アクセスコードが違います" });
    return;
  }
  const exp = Date.now() + DAYS * 24 * 60 * 60 * 1000;
  const mac = crypto.createHmac("sha256", secret).update(String(exp)).digest("hex");
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${exp}.${mac}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${DAYS * 24 * 60 * 60}`,
  );
  res.status(200).json({ ok: true });
};
