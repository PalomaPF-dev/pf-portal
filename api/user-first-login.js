// 初回パスワード設定。
// POST {loginId, password} → 名簿に存在し、かつ password_hash 未設定（NULL）のユーザーのみ
// scrypt ハッシュを保存して {ok:true}。設定済みなら 409。8文字未満は 400。
// ※ここではログインさせない（フロントが続けて /api/user-login を呼ぶ）。
// レート制限: 同一IP 10分10回（admin-login と同様）。
const { requireSql, ensureSchema, readBody } = require("../lib/db");
const { hashManagePassword } = require("../lib/portalAuth");

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
  const loginId = String(body.loginId || "").trim();
  const password = String(body.password || "");
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
    console.error("[user-first-login]", e);
    res.status(500).json({ message: "サーバーエラーが発生しました" });
  }
};
