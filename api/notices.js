// 連絡板（業務アプリ全体の連絡網）。
//
// 各アプリの画面ごとに散らすのではなく、ポータルに1か所だけ置く。
// 投稿ごとに「どのアプリの話か」と「誰に届けるか」を選び、選んだ宛先へ
// LINE WORKS で一斉通知する（＝現場への展開の入口）。
//
// GET（要ログイン）
//   一覧。自分に宛てられた連絡だけを返す（全員宛て＋自分の所属部署宛て）。
//   ?unread=1 で未読件数だけを返す（ポータルのバッジ用）。
// POST（要ログイン）
//   {action:"post", title, body, app?, audienceKind, audienceValue?}
//     連絡を投稿する。投稿できるのは管理者（role=admin）またはポータル管理権限者。
//     周知の手段なので、一般ユーザーには開放しない（返信は誰でもできる）。
//   {action:"reply", id, body}   連絡に返信する（投稿者と既返信者へ通知）
//   {action:"read", id}          既読にする
// DELETE（投稿者本人またはポータル管理権限者）
//   {id} 連絡を削除する（返信・既読も一緒に消える）
const { requireSql, ensureSchema, readBody, isUuid } = require("../lib/db");
const { verifyUserSession } = require("../lib/portalAuth");
const { configStatus, sendTextToUser } = require("../lib/lineworks");

const MAX_TITLE = 100;
const MAX_BODY = 2000;
const MAX_LIST = 100;
// 一斉通知の上限。Vercel の maxDuration=60s に収まる範囲に抑える。
// 超えた分は送らずログに残す（黙って切り捨てない）。
const MAX_NOTIFY = 300;
const NOTIFY_CONCURRENCY = 8;
// 通知に載せる本文の抜粋（長文をそのまま LINE WORKS へ流さない）
const NOTIFY_EXCERPT = 200;

// 対象アプリの表示名（index.html の APPS / api/contact.js と同じキー）
const APP_NAMES = {
  keikaku: "生産計画", nippou: "生産日報", sekisai: "出荷積載", zumen: "図面管理",
  keisoku: "計測機器", setsubi: "設備管理", hinshitsu: "品質管理", zaiko: "在庫管理",
  kanagata: "型管理", hoju: "補充計画", tenchu: "転注管理", purchasing: "購買単価",
  jinji: "人事管理", operation: "進捗管理",
};
function normalizeApp(v) {
  const k = String(v || "").trim();
  return APP_NAMES[k] ? k : null;
}
function appLabel(k) {
  return APP_NAMES[k] || "ポータル全体";
}

function portalOrigin() {
  return (process.env.PORTAL_ORIGIN || "https://portal.paloma-pf.com").replace(/\/+$/, "");
}

/**
 * ログイン中ユーザーの素性。宛先の絞り込みと投稿権限の判定に使う。
 * 権限は cookie ではなく毎回 DB を見る（権限を外した直後のセッションを通さないため）。
 */
async function currentUser(sql, loginId) {
  const rows = await sql`
    SELECT u.login_id, u.name, u.role, u.can_manage, d.code AS dept_code
    FROM pf_portal_users u
    LEFT JOIN pf_portal_departments d ON d.id = u.department_id
    WHERE u.login_id = ${loginId} LIMIT 1`;
  if (rows.length === 0) return null;
  const u = rows[0];
  return {
    loginId: u.login_id,
    name: u.name,
    deptCode: u.dept_code || null,
    // 投稿できるのは承認フロー上の管理者か、ポータル管理権限者
    canPost: u.role === "admin" || u.can_manage === true,
    canManage: u.can_manage === true,
  };
}

// 宛先の解決。'all' は全員、'dept' は指定の部署・工場コードの所属者。
// 返り値は [{loginId, to}]（to = LINE WORKS ID。無ければメール。どちらも無い人は除外）
async function resolveAudience(sql, kind, value) {
  const rows = kind === "dept"
    ? await sql`
        SELECT u.login_id, u.lineworks_id, u.email
        FROM pf_portal_users u
        JOIN pf_portal_departments d ON d.id = u.department_id
        WHERE d.code = ${value}`
    : await sql`SELECT login_id, lineworks_id, email FROM pf_portal_users`;
  return rows
    .map((r) => ({
      loginId: r.login_id,
      to: (r.lineworks_id || "").trim() || (r.email || "").trim() || null,
    }))
    .filter((r) => r.to);
}

// LINE WORKS へ一斉送信。1件の失敗で全体を止めない。送れた件数を返す。
async function broadcast(targets, text) {
  let sent = 0;
  let cursor = 0;
  async function worker() {
    while (cursor < targets.length) {
      const t = targets[cursor++];
      try {
        await sendTextToUser(t.to, text);
        sent++;
      } catch (e) {
        console.error("[notices] send failed:", t.loginId, e && e.message);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(NOTIFY_CONCURRENCY, targets.length) }, worker));
  return sent;
}

function excerpt(s) {
  return s.length > NOTIFY_EXCERPT ? s.slice(0, NOTIFY_EXCERPT) + "…" : s;
}

module.exports = async (req, res) => {
  const sql = requireSql(res);
  if (!sql) return;

  try {
    await ensureSchema(sql);

    const session = verifyUserSession(req);
    if (!session) { res.status(401).json({ message: "ログインが必要です" }); return; }
    const me = await currentUser(sql, session.loginId);
    if (!me) { res.status(401).json({ message: "ユーザーが見つかりません" }); return; }

    // 一覧・未読件数の抽出条件は「全員宛て、または自分の部署宛て」。
    // 所属未設定の人には全員宛てだけが見える（deptCode が NULL なら dept 条件は成立しない）。

    // ===== 一覧・未読件数 =====
    if (req.method === "GET") {
      const unreadOnly = /[?&]unread=1(&|$)/.test(String(req.url || ""));
      if (unreadOnly) {
        const rows = await sql`
          SELECT count(*)::int AS n
          FROM pf_portal_notices n
          WHERE (n.audience_kind = 'all'
                 OR (n.audience_kind = 'dept' AND n.audience_value = ${me.deptCode}))
            AND NOT EXISTS (
              SELECT 1 FROM pf_portal_notice_reads r
              WHERE r.notice_id = n.id AND r.login_id = ${me.loginId})`;
        res.status(200).json({ unread: rows[0] ? rows[0].n : 0 });
        return;
      }

      const notices = await sql`
        SELECT n.id, n.app, n.title, n.body, n.audience_kind, n.audience_value,
               n.created_by, n.created_by_name, n.created_at,
               d.name AS audience_name,
               (SELECT count(*)::int FROM pf_portal_notice_replies rp WHERE rp.notice_id = n.id) AS reply_count,
               EXISTS (SELECT 1 FROM pf_portal_notice_reads r
                       WHERE r.notice_id = n.id AND r.login_id = ${me.loginId}) AS is_read
        FROM pf_portal_notices n
        LEFT JOIN pf_portal_departments d ON d.code = n.audience_value
        WHERE (n.audience_kind = 'all'
               OR (n.audience_kind = 'dept' AND n.audience_value = ${me.deptCode}))
        ORDER BY n.created_at DESC
        LIMIT ${MAX_LIST}`;
      const ids = notices.map((n) => n.id);
      // 返信は一覧と一緒に返す（連絡ごとに追加で問い合わせると件数分の往復になる）
      const replies = ids.length
        ? await sql`
            SELECT id, notice_id, login_id, name, body, created_at
            FROM pf_portal_notice_replies
            WHERE notice_id = ANY(${ids}::uuid[])
            ORDER BY created_at`
        : [];
      const byNotice = new Map();
      for (const r of replies) {
        if (!byNotice.has(r.notice_id)) byNotice.set(r.notice_id, []);
        byNotice.get(r.notice_id).push({
          id: r.id, loginId: r.login_id, name: r.name, body: r.body,
          createdAt: r.created_at, mine: r.login_id === me.loginId,
        });
      }
      // 宛先の選択肢。部署マスターAPIは管理画面専用のため、投稿できる人にだけここで返す
      // （承認フロー上の管理者はポータル管理画面に入れないので、あちらは使えない）。
      const departments = me.canPost
        ? await sql`SELECT code, name FROM pf_portal_departments ORDER BY sort, code`
        : [];

      res.status(200).json({
        canPost: me.canPost,
        me: me.loginId,
        departments: departments.map((d) => ({ code: d.code, name: d.name })),
        items: notices.map((n) => ({
          id: n.id,
          app: n.app,
          appName: appLabel(n.app),
          title: n.title,
          body: n.body,
          audienceKind: n.audience_kind,
          audienceValue: n.audience_value,
          audienceName: n.audience_kind === "all" ? "全員" : (n.audience_name || n.audience_value || ""),
          createdBy: n.created_by,
          createdByName: n.created_by_name,
          createdAt: n.created_at,
          replyCount: n.reply_count,
          isRead: n.is_read === true,
          canDelete: n.created_by === me.loginId || me.canManage,
          replies: byNotice.get(n.id) || [],
        })),
      });
      return;
    }

    // ===== 削除 =====
    if (req.method === "DELETE") {
      const body = readBody(req);
      const id = body.id || (req.query && req.query.id);
      if (!isUuid(id)) { res.status(400).json({ message: "IDが不正です" }); return; }
      const rows = await sql`SELECT created_by FROM pf_portal_notices WHERE id = ${id} LIMIT 1`;
      if (rows.length === 0) { res.status(404).json({ message: "見つかりません" }); return; }
      if (rows[0].created_by !== me.loginId && !me.canManage) {
        res.status(403).json({ message: "この連絡を削除する権限がありません" });
        return;
      }
      await sql`DELETE FROM pf_portal_notices WHERE id = ${id}`;
      res.status(200).json({ ok: true });
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ message: "Method not allowed" });
      return;
    }

    const body = readBody(req);
    const action = String(body.action || "post").trim();

    // ===== 既読 =====
    if (action === "read") {
      const id = body.id;
      if (!isUuid(id)) { res.status(400).json({ message: "IDが不正です" }); return; }
      await sql`
        INSERT INTO pf_portal_notice_reads (notice_id, login_id)
        VALUES (${id}, ${me.loginId})
        ON CONFLICT (notice_id, login_id) DO NOTHING`;
      res.status(200).json({ ok: true });
      return;
    }

    // ===== 返信 =====
    if (action === "reply") {
      const id = body.id;
      if (!isUuid(id)) { res.status(400).json({ message: "IDが不正です" }); return; }
      const text = String(body.body || "").trim();
      if (!text) { res.status(400).json({ message: "返信内容を入力してください" }); return; }
      if (text.length > MAX_BODY) {
        res.status(400).json({ message: `返信は${MAX_BODY}文字以内で入力してください` });
        return;
      }
      const rows = await sql`
        SELECT id, app, title, audience_kind, audience_value, created_by
        FROM pf_portal_notices WHERE id = ${id} LIMIT 1`;
      if (rows.length === 0) { res.status(404).json({ message: "見つかりません" }); return; }
      const n = rows[0];
      // 自分に宛てられていない連絡には返信させない（一覧に出ないものへの書き込みを防ぐ）
      if (n.audience_kind === "dept" && n.audience_value !== me.deptCode) {
        res.status(403).json({ message: "この連絡に返信する権限がありません" });
        return;
      }
      await sql`
        INSERT INTO pf_portal_notice_replies (notice_id, login_id, name, body)
        VALUES (${id}, ${me.loginId}, ${me.name}, ${text})`;
      // 返信した本人は既読にしておく
      await sql`
        INSERT INTO pf_portal_notice_reads (notice_id, login_id)
        VALUES (${id}, ${me.loginId}) ON CONFLICT (notice_id, login_id) DO NOTHING`;

      // 通知先は「投稿者＋既に返信した人」。宛先全員に返信を流すと通知が多すぎるため。
      if (configStatus().ok) {
        try {
          const targets = await sql`
            SELECT DISTINCT u.login_id, u.lineworks_id, u.email
            FROM pf_portal_users u
            WHERE u.login_id <> ${me.loginId}
              AND (u.login_id = ${n.created_by}
                   OR u.login_id IN (SELECT login_id FROM pf_portal_notice_replies WHERE notice_id = ${id}))`;
          const list = targets
            .map((t) => ({ loginId: t.login_id, to: (t.lineworks_id || "").trim() || (t.email || "").trim() || null }))
            .filter((t) => t.to);
          if (list.length) {
            await broadcast(list, [
              `【${appLabel(n.app)}】連絡に返信がありました`, "", n.title, "",
              `${me.name}:`, excerpt(text), "", "▼確認はこちら", portalOrigin(),
            ].join("\n"));
          }
        } catch (e) {
          console.error("[notices] reply notify failed:", e && e.message);
        }
      }
      res.status(201).json({ ok: true });
      return;
    }

    if (action !== "post") {
      res.status(400).json({ message: "action は post / reply / read のいずれかです" });
      return;
    }

    // ===== 投稿 =====
    if (!me.canPost) {
      res.status(403).json({ message: "連絡を投稿できるのは管理者のみです" });
      return;
    }
    const title = String(body.title || "").trim();
    const text = String(body.body || "").trim();
    if (!title || title.length > MAX_TITLE) {
      res.status(400).json({ message: `件名を${MAX_TITLE}文字以内で入力してください` });
      return;
    }
    if (!text) { res.status(400).json({ message: "本文を入力してください" }); return; }
    if (text.length > MAX_BODY) {
      res.status(400).json({ message: `本文は${MAX_BODY}文字以内で入力してください` });
      return;
    }
    const app = normalizeApp(body.app);
    const audienceKind = body.audienceKind === "dept" ? "dept" : "all";
    let audienceValue = null;
    if (audienceKind === "dept") {
      audienceValue = String(body.audienceValue || "").trim();
      const d = await sql`SELECT code FROM pf_portal_departments WHERE code = ${audienceValue} LIMIT 1`;
      if (d.length === 0) { res.status(400).json({ message: "宛先の部署・工場を選択してください" }); return; }
    }

    const inserted = await sql`
      INSERT INTO pf_portal_notices (app, title, body, audience_kind, audience_value, created_by, created_by_name)
      VALUES (${app}, ${title}, ${text}, ${audienceKind}, ${audienceValue}, ${me.loginId}, ${me.name})
      RETURNING id, created_at`;
    const noticeId = inserted[0].id;
    // 投稿者本人は既読にしておく
    await sql`
      INSERT INTO pf_portal_notice_reads (notice_id, login_id)
      VALUES (${noticeId}, ${me.loginId}) ON CONFLICT DO NOTHING`;

    // ===== 宛先へ一斉通知 =====
    let notified = 0;
    let skipped = 0;
    const st = configStatus();
    if (!st.ok) {
      console.warn("[notices] LINE WORKS 未設定のため通知をスキップ:", st.missing.join(", "));
    } else {
      try {
        let targets = (await resolveAudience(sql, audienceKind, audienceValue))
          .filter((t) => t.loginId !== me.loginId); // 投稿者本人には送らない
        if (targets.length > MAX_NOTIFY) {
          skipped = targets.length - MAX_NOTIFY;
          console.warn(`[notices] 宛先が${MAX_NOTIFY}名を超えたため${skipped}名分を送信していません`);
          targets = targets.slice(0, MAX_NOTIFY);
        }
        notified = await broadcast(targets, [
          `【${appLabel(app)}】${title}`, "", excerpt(text), "",
          `— ${me.name}`, "", "▼ポータルで確認・返信", portalOrigin(),
        ].join("\n"));
      } catch (e) {
        // 通知に失敗しても投稿は残す（掲示自体は成立させる）
        console.error("[notices] broadcast failed:", e && e.message);
      }
    }

    res.status(201).json({ ok: true, id: noticeId, notified, skipped });
  } catch (e) {
    console.error("[notices]", e);
    res.status(500).json({ message: "サーバーエラーが発生しました" });
  }
};
