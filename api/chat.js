// 業務アプリ内チャット。スレッドは (app, ref) で一意
// （ref = 各アプリ内の対象ID。申請番号・報告番号など。空文字ならアプリ全体の連絡板）。
//
// 各アプリが自前で持つと実装も履歴も分散するため、DBもAPIもポータルに集約する。
// 新着は LINE WORKS へ通知する（宛先解決は api/notify.js と同じ規則）。
//
// 認証は2通り。どちらも「発言者が誰か」をサーバー側で確定させる:
//   1. 利用者セッション（cookie pf_user）… ポータル自身の画面から使う場合
//   2. 共有シークレット {key, loginId} … 業務アプリのサーバーが中継する場合
//      （アプリは別ドメインのため、ブラウザから直接呼ぶとcookieが送られない。
//        アプリのサーバーで PF_PROVISION_KEY を付けて中継する。docs/chat.md 参照）
//
// POST {action}:
//   "list"   {app, ref}                               → スレッドと発言一覧
//   "post"   {app, ref, message, title?, participants?, url?} → 発言（既定のaction）
//   "read"   {app, ref}                               → 既読にする
//   "unread" {}                                       → 自分の未読合計
// GET（利用者セッションのみ）: ?app=&ref= で一覧、?unread=1 で未読合計
const crypto = require("crypto");
const { requireSql, ensureSchema, readBody } = require("../lib/db");
const { verifyUserSession } = require("../lib/portalAuth");
const { configStatus, sendTextToUser } = require("../lib/lineworks");

const MAX_BODY_LEN = 2000;
const MAX_MESSAGES = 200;
const MAX_PARTICIPANTS = 100;
// 新着通知に載せる本文の抜粋長（長文をそのままLINE WORKSへ流さない）
const NOTIFY_EXCERPT = 120;
const SEND_CONCURRENCY = 5;

const APP_NAMES = {
  keikaku: "生産計画", nippou: "生産日報", sekisai: "出荷積載", zumen: "図面管理",
  keisoku: "計測機器", setsubi: "設備管理", hinshitsu: "品質管理", zaiko: "在庫管理",
  kanagata: "型管理", hoju: "補充計画", tenchu: "転注管理", purchasing: "購買単価",
  jinji: "人事管理", operation: "進捗管理",
};

function safeKeyEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * 発言者を確定する。セッションか共有シークレットのどちらかで必ずサーバー側が決める
 * （body の loginId をそのまま信用すると、誰にでもなりすませてしまうため、
 *   共有シークレットが一致した場合のみ body の loginId を採用する）。
 * OK なら {loginId} を返す。NG なら res に応答を書いて null。
 */
function authenticate(req, res, body) {
  const session = verifyUserSession(req);
  if (session) return { loginId: session.loginId };

  const provisionKey = (process.env.PF_PROVISION_KEY || "").trim();
  const given = String(body.key || "");
  if (provisionKey && given && safeKeyEqual(given, provisionKey)) {
    const loginId = String(body.loginId || "").trim();
    if (!loginId || loginId.length > 64) {
      res.status(400).json({ message: "loginId を指定してください" });
      return null;
    }
    return { loginId };
  }
  res.status(401).json({ message: "ログインが必要です" });
  return null;
}

function appLabel(k) {
  return APP_NAMES[k] || "業務ポータル";
}

// スレッドを取得（無ければ作る）。title は初回作成時と、空だった場合のみ設定する。
async function getOrCreateThread(sql, app, ref, title) {
  const rows = await sql`
    INSERT INTO pf_portal_chat_threads (app, ref, title)
    VALUES (${app}, ${ref}, ${title || ""})
    ON CONFLICT (app, ref) DO UPDATE
      SET title = CASE WHEN pf_portal_chat_threads.title = '' THEN EXCLUDED.title
                       ELSE pf_portal_chat_threads.title END
    RETURNING id, app, ref, title, created_at, updated_at`;
  return rows[0];
}

// 参加者を冪等に追加する（既にいれば何もしない＝既読状態を壊さない）
async function addParticipants(sql, threadId, loginIds) {
  const ids = [...new Set(loginIds.filter(Boolean))].slice(0, MAX_PARTICIPANTS);
  if (ids.length === 0) return;
  await sql`
    INSERT INTO pf_portal_chat_participants (thread_id, login_id)
    SELECT ${threadId}, unnest(${ids}::text[])
    ON CONFLICT (thread_id, login_id) DO NOTHING`;
}

// 発言者の氏名（名簿にない場合は社員番号で代用し、投稿自体は通す）
async function displayName(sql, loginId) {
  const rows = await sql`SELECT name FROM pf_portal_users WHERE login_id = ${loginId} LIMIT 1`;
  return rows[0] && rows[0].name ? rows[0].name : loginId;
}

// 新着を関係者へLINE WORKS通知（本人は除く）。通知の失敗で投稿を失敗させない。
async function notifyParticipants(sql, { threadId, app, ref, title, senderName, body, url, senderLoginId }) {
  if (!configStatus().ok) return;
  const rows = await sql`
    SELECT p.login_id, u.lineworks_id, u.email
    FROM pf_portal_chat_participants p
    LEFT JOIN pf_portal_users u ON u.login_id = p.login_id
    WHERE p.thread_id = ${threadId} AND p.login_id <> ${senderLoginId}`;
  const targets = rows
    .map((r) => ({
      loginId: r.login_id,
      to: (r.lineworks_id || "").trim() || (r.email || "").trim() || null,
    }))
    .filter((t) => t.to);
  if (targets.length === 0) return;

  const excerpt = body.length > NOTIFY_EXCERPT ? body.slice(0, NOTIFY_EXCERPT) + "…" : body;
  const heading = title || (ref ? `${appLabel(app)} ${ref}` : appLabel(app));
  const lines = [`【${appLabel(app)}】チャットに新しい発言があります`, "", heading, "", `${senderName}:`, excerpt];
  if (url) lines.push("", "▼確認はこちら", url);
  const text = lines.join("\n");

  let cursor = 0;
  async function worker() {
    while (cursor < targets.length) {
      const t = targets[cursor++];
      try {
        await sendTextToUser(t.to, text);
      } catch (e) {
        console.error("[chat] notify failed:", t.loginId, e && e.message);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(SEND_CONCURRENCY, targets.length) }, worker));
}

async function loadThreadView(sql, thread, loginId) {
  const messages = await sql`
    SELECT id, login_id, name, body, created_at
    FROM pf_portal_chat_messages
    WHERE thread_id = ${thread.id}
    ORDER BY created_at
    LIMIT ${MAX_MESSAGES}`;
  const participants = await sql`
    SELECT p.login_id, COALESCE(u.name, p.login_id) AS name
    FROM pf_portal_chat_participants p
    LEFT JOIN pf_portal_users u ON u.login_id = p.login_id
    WHERE p.thread_id = ${thread.id}
    ORDER BY p.login_id`;
  return {
    thread: { id: thread.id, app: thread.app, ref: thread.ref, title: thread.title },
    me: loginId,
    messages: messages.map((m) => ({
      id: m.id,
      loginId: m.login_id,
      name: m.name,
      body: m.body,
      createdAt: m.created_at,
      mine: m.login_id === loginId,
    })),
    participants: participants.map((p) => ({ loginId: p.login_id, name: p.name })),
  };
}

// 自分が参加しているスレッドの未読合計（自分の発言は数えない）
async function unreadCount(sql, loginId) {
  const rows = await sql`
    SELECT count(*)::int AS n
    FROM pf_portal_chat_participants p
    JOIN pf_portal_chat_messages m ON m.thread_id = p.thread_id
    WHERE p.login_id = ${loginId}
      AND m.login_id <> ${loginId}
      AND (p.last_read_at IS NULL OR m.created_at > p.last_read_at)`;
  return rows[0] ? rows[0].n : 0;
}

module.exports = async (req, res) => {
  const sql = requireSql(res);
  if (!sql) return;

  try {
    await ensureSchema(sql);

    const body = req.method === "GET" ? {} : readBody(req);

    // GET は利用者セッション専用（共有シークレットをURLに載せないため）
    if (req.method === "GET") {
      const session = verifyUserSession(req);
      if (!session) { res.status(401).json({ message: "ログインが必要です" }); return; }
      const url = new URL(req.url, "http://localhost");
      if (url.searchParams.get("unread") === "1") {
        res.status(200).json({ unread: await unreadCount(sql, session.loginId) });
        return;
      }
      const app = String(url.searchParams.get("app") || "").trim();
      const ref = String(url.searchParams.get("ref") || "").trim();
      if (!app) { res.status(400).json({ message: "app を指定してください" }); return; }
      const thread = await getOrCreateThread(sql, app, ref, "");
      res.status(200).json(await loadThreadView(sql, thread, session.loginId));
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ message: "Method not allowed" });
      return;
    }

    const auth = authenticate(req, res, body);
    if (!auth) return;
    const { loginId } = auth;
    const action = String(body.action || "post").trim();

    if (action === "unread") {
      res.status(200).json({ unread: await unreadCount(sql, loginId) });
      return;
    }

    const app = String(body.app || "").trim();
    const ref = String(body.ref == null ? "" : body.ref).trim().slice(0, 128);
    if (!app || app.length > 32) { res.status(400).json({ message: "app を指定してください" }); return; }

    if (action === "list") {
      const thread = await getOrCreateThread(sql, app, ref, String(body.title || "").trim().slice(0, 200));
      res.status(200).json(await loadThreadView(sql, thread, loginId));
      return;
    }

    if (action === "read") {
      const thread = await getOrCreateThread(sql, app, ref, "");
      // 参加していない人が既読にしても意味がないので、参加者として登録もする
      await addParticipants(sql, thread.id, [loginId]);
      await sql`
        UPDATE pf_portal_chat_participants SET last_read_at = now()
        WHERE thread_id = ${thread.id} AND login_id = ${loginId}`;
      res.status(200).json({ ok: true });
      return;
    }

    if (action !== "post") {
      res.status(400).json({ message: "action は list / post / read / unread のいずれかです" });
      return;
    }

    // ===== 発言 =====
    const text = String(body.message || "").trim();
    if (!text) { res.status(400).json({ message: "message を入力してください" }); return; }
    if (text.length > MAX_BODY_LEN) {
      res.status(400).json({ message: `発言は${MAX_BODY_LEN}文字以内で入力してください` });
      return;
    }
    const url = String(body.url || "").trim();
    if (url && !/^https:\/\//.test(url)) { res.status(400).json({ message: "url は https:// で指定してください" }); return; }

    const thread = await getOrCreateThread(sql, app, ref, String(body.title || "").trim().slice(0, 200));
    const name = await displayName(sql, loginId);

    // 関係者（アプリが渡した参加者）と発言者を参加者に加えてから保存する
    const given = Array.isArray(body.participants)
      ? body.participants.map((v) => String(v == null ? "" : v).trim()).filter((v) => v && v.length <= 64)
      : [];
    await addParticipants(sql, thread.id, [...given, loginId]);

    const inserted = await sql`
      INSERT INTO pf_portal_chat_messages (thread_id, login_id, name, body)
      VALUES (${thread.id}, ${loginId}, ${name}, ${text})
      RETURNING id, created_at`;
    await sql`UPDATE pf_portal_chat_threads SET updated_at = now() WHERE id = ${thread.id}`;
    // 発言者本人は自分の発言を読んだ状態にする
    await sql`
      UPDATE pf_portal_chat_participants SET last_read_at = now()
      WHERE thread_id = ${thread.id} AND login_id = ${loginId}`;

    // 通知の失敗で投稿を失敗させない（発言はすでに保存済み）
    try {
      await notifyParticipants(sql, {
        threadId: thread.id, app, ref, title: thread.title,
        senderName: name, body: text, url, senderLoginId: loginId,
      });
    } catch (e) {
      console.error("[chat] notify error:", e && e.message);
    }

    res.status(201).json({
      ok: true,
      message: { id: inserted[0].id, loginId, name, body: text, createdAt: inserted[0].created_at, mine: true },
    });
  } catch (e) {
    console.error("[chat]", e);
    res.status(500).json({ message: "サーバーエラーが発生しました" });
  }
};
