// お問い合わせフォーム受付。
//   POST（一般・要ログイン）: {category, loginId, name, message, website?}
//     → pf_portal_inquiries に保存。RESEND_API_KEY があれば info@ へ通知メールも送る（任意）。
//     website はハニーポット（値があれば送信扱いで無視）。レート制限: 同一IP 10分5回。
//   GET（管理者）: 一覧を返す（status=open を上位）。
//   PATCH（管理者）: {id, status:"open"|"resolved"} で対応状態を更新。
const { requireSql, ensureSchema, readBody, isUuid } = require("../lib/db");
const { verifyUserSession } = require("../lib/portalAuth");
const { requireManage } = require("../lib/portalAuth");

// 問い合わせ分類（フロントの選択肢と一致させる）
const CATEGORIES = [
  "ログインできない",
  "アプリのエラー・不具合",
  "アカウント・権限（部署／職場／承認者）",
  "操作方法について",
  "機能の要望・改善",
  "その他",
];

const RL = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const WIN = 10 * 60 * 1000;
  const MAX = 5;
  const arr = (RL.get(ip) || []).filter((t) => now - t < WIN);
  if (arr.length >= MAX) { RL.set(ip, arr); return true; }
  arr.push(now); RL.set(ip, arr);
  return false;
}

async function sendMail(inq) {
  const key = (process.env.RESEND_API_KEY || "").trim();
  if (!key) return; // メール未設定でも保存は成立させる（管理画面で確認できる）
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: process.env.CONTACT_FROM || "業務ポータル <noreply@paloma-pf.com>",
        to: ["info@paloma-pf.com"],
        subject: "【業務ポータル】お問い合わせ（" + inq.category + "）",
        text:
          "業務ポータルのお問い合わせフォームに新しい投稿がありました。\n\n" +
          "分類: " + inq.category + "\n" +
          "社員番号: " + inq.loginId + "\n" +
          "氏名: " + inq.name + "\n" +
          "内容:\n" + inq.message + "\n\n" +
          "— 管理画面（ユーザー設定 › お問い合わせ）でも確認・対応できます。",
        ...(process.env.MAIL_REPLY_TO ? { reply_to: process.env.MAIL_REPLY_TO.trim() } : {}),
      }),
    });
  } catch (e) {
    console.warn("[contact] mail failed:", e && e.message);
  }
}

module.exports = async (req, res) => {
  const sql = requireSql(res);
  if (!sql) return;

  try {
    await ensureSchema(sql);

    // ===== 一覧（管理者） =====
    if (req.method === "GET") {
      if (!requireManage(req, res)) return;
      const rows = await sql`
        SELECT id, category, login_id, name, message, status, created_at
        FROM pf_portal_inquiries
        ORDER BY (status = 'open') DESC, created_at DESC
        LIMIT 500`;
      res.status(200).json(rows.map((r) => ({
        id: r.id, category: r.category, loginId: r.login_id, name: r.name,
        message: r.message, status: r.status, createdAt: r.created_at,
      })));
      return;
    }

    // ===== 対応状態の更新（管理者） =====
    if (req.method === "PATCH") {
      if (!requireManage(req, res)) return;
      const body = readBody(req);
      const id = body.id;
      const status = body.status === "resolved" ? "resolved" : "open";
      if (!isUuid(id)) { res.status(400).json({ message: "IDが不正です" }); return; }
      const r = await sql`UPDATE pf_portal_inquiries SET status = ${status} WHERE id = ${id} RETURNING id`;
      if (r.length === 0) { res.status(404).json({ message: "見つかりません" }); return; }
      res.status(200).json({ ok: true, status });
      return;
    }

    // ===== 投稿（要ログイン） =====
    if (req.method !== "POST") {
      res.status(405).json({ message: "Method not allowed" });
      return;
    }

    const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
    if (rateLimited(ip)) {
      res.status(429).json({ message: "送信が続いています。時間をおいて再度お試しください。" });
      return;
    }

    const body = readBody(req);
    if (body.website) { res.status(200).json({ ok: true }); return; } // ハニーポット

    // ログイン必須（社員番号は自己申告ではなくセッションからも取得できるが、フォーム入力を尊重しつつ本人確認）
    const session = verifyUserSession(req);
    if (!session) { res.status(401).json({ message: "ログインが必要です" }); return; }

    let category = String(body.category || "").trim();
    if (!CATEGORIES.includes(category)) category = "その他";
    const loginId = String(body.loginId || "").trim();
    const name = String(body.name || "").trim();
    const message = String(body.message || "").trim();

    if (!loginId || loginId.length > 64) { res.status(400).json({ message: "社員番号を入力してください" }); return; }
    if (!name || name.length > 100) { res.status(400).json({ message: "氏名を入力してください" }); return; }
    if (!message) { res.status(400).json({ message: "お問い合わせ内容を入力してください" }); return; }
    if (message.length > 2000) { res.status(400).json({ message: "内容は2000文字以内で入力してください" }); return; }

    await sql`
      INSERT INTO pf_portal_inquiries (category, login_id, name, message)
      VALUES (${category}, ${loginId}, ${name}, ${message})`;
    await sendMail({ category, loginId, name, message });
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error("[contact]", e);
    res.status(500).json({ message: "サーバーエラーが発生しました。時間をおいて再度お試しください。" });
  }
};
