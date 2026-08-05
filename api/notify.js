// LINE WORKS 通知の受け口（承認通知・関係者へのお知らせ）。
//   POST {key, loginId, message, app?, title?, url?}
//     業務アプリからの通知（1名）。共有シークレット PF_PROVISION_KEY で認証し、
//     社員番号（loginId）から宛先（pf_portal_users.lineworks_id、未設定ならメール
//     = LINE WORKS のログインIDと同じ想定）を解決して Bot からテキストを送る。
//     宛先未登録・LINE WORKS 未設定でも業務アプリ側の処理は止めないため、
//     その場合は 200 {ok:true, sent:false, reason} を返す（送信APIの失敗のみ 502）。
//   POST {key, loginIds:[...], message, ...}
//     関係者への一斉通知（最大 MAX_RECIPIENTS 名）。宛先ごとの結果を results で返す。
//     一部が届かなくても全体は 200（業務を止めないため）。同じ社員番号は自動で重複排除。
//   POST {test:true, loginId}（要管理セッション）
//     管理画面からのテスト送信。設定と宛先の疎通確認に使う。
//   GET（要管理セッション）
//     設定状態を返す {configured, missing:[環境変数名]}。
// LINE WORKS 側のセットアップは docs/lineworks.md を参照。
const crypto = require("crypto");
const { requireSql, ensureSchema, readBody } = require("../lib/db");
const { requireManageSession } = require("../lib/portalAuth");
const { configStatus, sendTextToUser, diagnosePrivateKey, diagnoseBot, MAX_TEXT_LEN } = require("../lib/lineworks");

// 通知の見出しに使うアプリ表示名（index.html の APPS / api/contact.js と同じキー）
const APP_NAMES = {
  keikaku: "生産計画", nippou: "生産日報", sekisai: "出荷積載", zumen: "図面管理",
  keisoku: "計測機器", setsubi: "設備管理", hinshitsu: "品質管理", zaiko: "在庫管理",
  kanagata: "型管理", hoju: "補充計画", tenchu: "転注管理", purchasing: "購買単価",
  jinji: "人事管理", operation: "進捗管理",
};

/** タイミング安全な鍵比較（長さ違いは即 false）。api/hr-sync.js と同じ。 */
function safeKeyEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// 一斉通知の上限。Vercel の maxDuration=60s に収まる範囲で、実運用の
// 「部署・工程の関係者へまとめて」を賄える値にしている。
const MAX_RECIPIENTS = 100;
// 同時送信数。LINE WORKS 側の負荷とレート制限を考えて控えめにする。
const SEND_CONCURRENCY = 5;

// 社員番号 → LINE WORKS の宛先。lineworks_id 優先、無ければメール
// （LINE WORKS のログインIDはメール形式のため、社用メール＝LINE WORKS ID の運用ならそのまま届く）。
async function resolveDestination(sql, loginId) {
  const rows = await sql`
    SELECT name, lineworks_id, email FROM pf_portal_users WHERE login_id = ${loginId} LIMIT 1`;
  if (rows.length === 0) return { found: false, to: null, name: null };
  const u = rows[0];
  const to = (u.lineworks_id || "").trim() || (u.email || "").trim() || null;
  return { found: true, to, name: u.name };
}

// 複数の社員番号の宛先をまとめて引く（1件ずつ問い合わせると人数分の往復になるため）。
// 戻り値: Map<login_id, {to, name}>。名簿に無い社員番号はキーごと入らない。
async function resolveDestinations(sql, loginIds) {
  const rows = await sql`
    SELECT login_id, name, lineworks_id, email
    FROM pf_portal_users WHERE login_id = ANY(${loginIds})`;
  const map = new Map();
  for (const u of rows) {
    map.set(u.login_id, {
      to: (u.lineworks_id || "").trim() || (u.email || "").trim() || null,
      name: u.name,
    });
  }
  return map;
}

// 宛先ごとに送信し、1件の失敗で全体を止めない。結果は入力順で返す。
async function sendToMany(sql, loginIds, text) {
  const dests = await resolveDestinations(sql, loginIds);
  const results = new Array(loginIds.length);
  let cursor = 0;
  async function worker() {
    while (cursor < loginIds.length) {
      const i = cursor++;
      const loginId = loginIds[i];
      const d = dests.get(loginId);
      if (!d) { results[i] = { loginId, sent: false, reason: "user-not-found" }; continue; }
      if (!d.to) { results[i] = { loginId, sent: false, reason: "no-destination" }; continue; }
      try {
        await sendTextToUser(d.to, text);
        results[i] = { loginId, sent: true };
      } catch (e) {
        console.error("[notify] send failed:", loginId, e && e.message);
        results[i] = { loginId, sent: false, reason: "send-failed" };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(SEND_CONCURRENCY, loginIds.length) }, worker));
  return results;
}

// 通知本文の組み立て。「【アプリ名】見出し」＋本文＋確認用URL。
function composeText({ appLabel, title, message, url }) {
  const head = "【" + (appLabel || "業務ポータル") + "】" + (title ? title : "お知らせ");
  const parts = [head, "", message];
  if (url) parts.push("", "▼確認はこちら", url);
  return parts.join("\n");
}

module.exports = async (req, res) => {
  const sql = requireSql(res);
  if (!sql) return;

  try {
    await ensureSchema(sql);

    // ===== 設定状態（管理画面） =====
    // privateKey は鍵の「形」だけの診断（本体は含まない）。貼り付け崩れの切り分けに使う。
    if (req.method === "GET") {
      if (!(await requireManageSession(req, res, sql))) return;
      const st = configStatus();
      const body = { configured: st.ok, missing: st.missing, privateKey: diagnosePrivateKey() };
      // 設定が揃っているときだけ LINE WORKS へ問い合わせる（Bot の切り分け用）
      if (st.ok) body.bot = await diagnoseBot();
      res.status(200).json(body);
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ message: "Method not allowed" });
      return;
    }

    const body = readBody(req);

    // ===== テスト送信（管理画面・要管理セッション） =====
    if (body.test === true) {
      if (!(await requireManageSession(req, res, sql))) return;
      const st = configStatus();
      if (!st.ok) {
        res.status(503).json({ message: "LINE WORKS が未設定です（環境変数: " + st.missing.join(", ") + "）" });
        return;
      }
      const loginId = String(body.loginId || "").trim();
      if (!loginId) { res.status(400).json({ message: "loginId を指定してください" }); return; }
      const dest = await resolveDestination(sql, loginId);
      if (!dest.found) { res.status(404).json({ message: "対象のユーザーが見つかりません" }); return; }
      if (!dest.to) {
        res.status(400).json({ message: "宛先がありません。LINE WORKS ID かメールアドレスを登録してください" });
        return;
      }
      try {
        await sendTextToUser(
          dest.to,
          composeText({
            title: "テスト送信",
            message: dest.name + " さん\nLINE WORKS 連携のテスト送信です。このメッセージが届いていれば設定は完了しています。",
          })
        );
        res.status(200).json({ ok: true, sent: true, to: dest.to });
      } catch (e) {
        console.error("[notify] test send failed:", e && e.message);
        res.status(502).json({ message: "送信に失敗しました: " + (e && e.message ? e.message : "不明なエラー") });
      }
      return;
    }

    // ===== 業務アプリからの通知（共有シークレット認証） =====
    const provisionKey = (process.env.PF_PROVISION_KEY || "").trim();
    if (!provisionKey) {
      res.status(503).json({ message: "サーバー設定が未完了です（PF_PROVISION_KEY）" });
      return;
    }
    if (!safeKeyEqual(String(body.key || ""), provisionKey)) {
      res.status(401).json({ message: "認証に失敗しました" });
      return;
    }

    const loginId = String(body.loginId || "").trim();
    const message = String(body.message || "").trim();
    const title = String(body.title || "").trim().slice(0, 100);
    const url = String(body.url || "").trim();
    const appKey = String(body.app || "").trim();

    // 複数宛て（関係者への一斉通知）。空白・重複・自明な不正値は落として整える。
    const multi = Array.isArray(body.loginIds);
    const loginIds = multi
      ? [...new Set(body.loginIds.map((v) => String(v == null ? "" : v).trim()).filter((v) => v && v.length <= 64))]
      : [];

    if (multi) {
      if (loginIds.length === 0) { res.status(400).json({ message: "loginIds に有効な社員番号を指定してください" }); return; }
      if (loginIds.length > MAX_RECIPIENTS) {
        res.status(400).json({ message: `一度に送れるのは最大${MAX_RECIPIENTS}名です` });
        return;
      }
    } else if (!loginId || loginId.length > 64) {
      res.status(400).json({ message: "loginId または loginIds を指定してください" });
      return;
    }
    if (!message) { res.status(400).json({ message: "message を指定してください" }); return; }
    if (message.length > MAX_TEXT_LEN) {
      res.status(400).json({ message: "message は" + MAX_TEXT_LEN + "文字以内で指定してください" });
      return;
    }
    if (url && !/^https:\/\//.test(url)) { res.status(400).json({ message: "url は https:// で指定してください" }); return; }

    const st = configStatus();
    if (!st.ok) {
      // 未設定でもアプリ側の承認処理は成立させる（気付けるようログだけ残す）
      console.warn("[notify] LINE WORKS 未設定のため送信をスキップ:", st.missing.join(", "));
      if (multi) {
        res.status(200).json({
          ok: true, sentCount: 0, total: loginIds.length, reason: "not-configured",
          results: loginIds.map((id) => ({ loginId: id, sent: false, reason: "not-configured" })),
        });
      } else {
        res.status(200).json({ ok: true, sent: false, reason: "not-configured" });
      }
      return;
    }

    const text = composeText({ appLabel: APP_NAMES[appKey], title, message, url });

    // ===== 関係者へ一斉送信 =====
    // 一部が届かなくても全体は 200。呼び出し元は results で個別の可否を確認する。
    if (multi) {
      const results = await sendToMany(sql, loginIds, text);
      const sentCount = results.filter((r) => r.sent).length;
      res.status(200).json({ ok: true, sentCount, total: results.length, results });
      return;
    }

    // ===== 1名へ送信（従来どおりの応答形式を保つ） =====
    const dest = await resolveDestination(sql, loginId);
    if (!dest.found) { res.status(200).json({ ok: true, sent: false, reason: "user-not-found" }); return; }
    if (!dest.to) { res.status(200).json({ ok: true, sent: false, reason: "no-destination" }); return; }

    try {
      await sendTextToUser(dest.to, text);
      res.status(200).json({ ok: true, sent: true });
    } catch (e) {
      console.error("[notify] send failed:", loginId, e && e.message);
      res.status(502).json({ ok: false, sent: false, reason: "send-failed" });
    }
  } catch (e) {
    console.error("[notify]", e);
    res.status(500).json({ message: "サーバーエラーが発生しました" });
  }
};
