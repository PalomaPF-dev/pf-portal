// お問い合わせフォーム受付。
//   POST（一般・要ログイン）: {app?, category, loginId, name, message, website?}
//     → pf_portal_inquiries に保存。RESEND_API_KEY があれば info@ へ通知メールも送る（任意）。
//     website はハニーポット（値があれば送信扱いで無視）。レート制限: 同一IP 10分5回。
//   GET（管理者）: 一覧を返す（status=open を上位）。
//   GET ?mine=1（本人・要ログイン）: 自分の問い合わせと回答の一覧。
//   PATCH（管理者）: {id, status:"open"|"resolved"} で対応状態を更新。
//                    {id, reply} で回答を保存（回答すると自動で対応済み＋本人は未読になる）。
//   PATCH ?mine=1（本人）: {id} で自分の回答を既読にする。
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

// 対象アプリ（index.html の APPS と同じキー）。表示名は管理画面と通知メールで使う。
// 空文字・未知のキーは「ポータル全体・その他」扱いで NULL 保存する。
const APP_NAMES = {
  keikaku: "生産計画", nippou: "生産日報", sekisai: "出荷積載", zumen: "図面管理",
  keisoku: "計測機器", setsubi: "設備管理", hinshitsu: "品質管理", zaiko: "在庫管理",
  kanagata: "型管理", hoju: "補充計画", tenchu: "転注管理",
};
function normalizeApp(v) {
  const k = String(v || "").trim();
  return APP_NAMES[k] ? k : null;
}
function appLabel(k) {
  return APP_NAMES[k] || "ポータル全体・その他";
}

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
        subject: "【業務ポータル】お問い合わせ（" + appLabel(inq.app) + "／" + inq.category + "）",
        text:
          "業務ポータルのお問い合わせフォームに新しい投稿がありました。\n\n" +
          "対象アプリ: " + appLabel(inq.app) + "\n" +
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

// 回答を書いたことを本人へメールで知らせる（メール未設定・アドレス未登録なら何もしない）。
// 保存自体は成功させたいので、失敗しても例外は投げない。
async function sendReplyMail(sql, inq) {
  const key = (process.env.RESEND_API_KEY || "").trim();
  if (!key) return;
  try {
    const rows = await sql`SELECT email FROM pf_portal_users WHERE login_id = ${inq.login_id} LIMIT 1`;
    const to = rows[0] && rows[0].email ? String(rows[0].email).trim() : "";
    if (!to) return;
    const origin = (process.env.PORTAL_ORIGIN || "https://portal.paloma-pf.com").replace(/\/+$/, "");
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: process.env.CONTACT_FROM || "業務ポータル <noreply@paloma-pf.com>",
        to: [to],
        subject: "【業務ポータル】お問い合わせへの回答",
        text:
          inq.name + " さん\n\n" +
          "お問い合わせいただいた件について回答しました。\n\n" +
          "対象アプリ: " + appLabel(inq.app) + "\n" +
          "分類: " + inq.category + "\n" +
          "お問い合わせ内容:\n" + inq.message + "\n\n" +
          "―――― 回答 ――――\n" + inq.reply + "\n\n" +
          "業務ポータル（" + origin + "）にログインすると、いつでも確認できます。",
        ...(process.env.MAIL_REPLY_TO ? { reply_to: process.env.MAIL_REPLY_TO.trim() } : {}),
      }),
    });
  } catch (e) {
    console.warn("[contact] reply mail failed:", e && e.message);
  }
}

module.exports = async (req, res) => {
  const sql = requireSql(res);
  if (!sql) return;

  // ?mine=1 は「本人が自分の問い合わせを見る／既読にする」経路（管理者権限は不要）
  const mine = /[?&]mine=1(&|$)/.test(String(req.url || ""));

  try {
    await ensureSchema(sql);

    // ===== 自分の問い合わせと回答（本人・要ログイン） =====
    if (req.method === "GET" && mine) {
      const session = verifyUserSession(req);
      if (!session) { res.status(401).json({ message: "ログインが必要です" }); return; }
      const rows = await sql`
        SELECT id, app, category, message, status, reply, replied_at, read_at, created_at
        FROM pf_portal_inquiries
        WHERE login_id = ${session.loginId}
        ORDER BY created_at DESC
        LIMIT 100`;
      res.status(200).json({
        items: rows.map((r) => ({
          id: r.id, app: r.app, appName: appLabel(r.app), category: r.category, message: r.message, status: r.status,
          reply: r.reply, repliedAt: r.replied_at, readAt: r.read_at, createdAt: r.created_at,
        })),
        // 未読の回答件数（ポータルの「回答が届いています」表示に使う）
        unread: rows.filter((r) => r.reply && !r.read_at).length,
      });
      return;
    }

    // ===== 一覧（管理者） =====
    if (req.method === "GET") {
      if (!requireManage(req, res)) return;
      const rows = await sql`
        SELECT id, app, category, login_id, name, message, status, reply, replied_at, read_at, created_at
        FROM pf_portal_inquiries
        ORDER BY (status = 'open') DESC, created_at DESC
        LIMIT 500`;
      res.status(200).json(rows.map((r) => ({
        id: r.id, app: r.app, appName: appLabel(r.app), category: r.category, loginId: r.login_id, name: r.name,
        message: r.message, status: r.status, createdAt: r.created_at,
        reply: r.reply, repliedAt: r.replied_at, readAt: r.read_at,
      })));
      return;
    }

    // ===== 回答を既読にする（本人） =====
    if (req.method === "PATCH" && mine) {
      const session = verifyUserSession(req);
      if (!session) { res.status(401).json({ message: "ログインが必要です" }); return; }
      const body = readBody(req);
      const id = body.id;
      if (!isUuid(id)) { res.status(400).json({ message: "IDが不正です" }); return; }
      // 自分の問い合わせ以外は更新できないよう login_id も条件に入れる
      await sql`
        UPDATE pf_portal_inquiries
        SET read_at = now()
        WHERE id = ${id} AND login_id = ${session.loginId} AND reply IS NOT NULL AND read_at IS NULL`;
      res.status(200).json({ ok: true });
      return;
    }

    // ===== 回答の保存・対応状態の更新（管理者） =====
    if (req.method === "PATCH") {
      if (!requireManage(req, res)) return;
      const body = readBody(req);
      const id = body.id;
      if (!isUuid(id)) { res.status(400).json({ message: "IDが不正です" }); return; }

      // reply が含まれていれば回答の保存。回答すると対応済みにし、本人には未読として届ける。
      if (Object.prototype.hasOwnProperty.call(body, "reply")) {
        const reply = String(body.reply == null ? "" : body.reply).trim();
        if (!reply) { res.status(400).json({ message: "回答内容を入力してください" }); return; }
        if (reply.length > 4000) { res.status(400).json({ message: "回答は4000文字以内で入力してください" }); return; }
        const r = await sql`
          UPDATE pf_portal_inquiries
          SET reply = ${reply}, replied_at = now(), read_at = NULL, status = 'resolved'
          WHERE id = ${id}
          RETURNING id, app, category, login_id, name, message, reply, replied_at, status`;
        if (r.length === 0) { res.status(404).json({ message: "見つかりません" }); return; }
        await sendReplyMail(sql, r[0]);
        res.status(200).json({ ok: true, status: r[0].status, repliedAt: r[0].replied_at });
        return;
      }

      const status = body.status === "resolved" ? "resolved" : "open";
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

    const app = normalizeApp(body.app);
    await sql`
      INSERT INTO pf_portal_inquiries (app, category, login_id, name, message)
      VALUES (${app}, ${category}, ${loginId}, ${name}, ${message})`;
    await sendMail({ app, category, loginId, name, message });
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error("[contact]", e);
    res.status(500).json({ message: "サーバーエラーが発生しました。時間をおいて再度お試しください。" });
  }
};
