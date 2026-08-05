# 業務アプリ内チャット（組み込み手順）

各業務アプリの画面に「連絡・コメント」欄を置き、関係者とやり取りできるようにする仕組みです。
新しい発言は関係者の LINE WORKS へ自動通知されます。

チャットのデータとAPIは**ポータルに集約**しています。各アプリが自前で作ると実装も履歴も
分散するため、アプリ側の作業は**中継エンドポイント1つ＋タグ2行**だけで済むようにしています。

```
アプリ画面（ウィジェット）
   ↓ 同一ドメイン内のfetch
アプリのサーバー（中継。PF_PROVISION_KEY を付ける）
   ↓
ポータル /api/chat  ──▶ DB（履歴）
                    └─▶ LINE WORKS（関係者へ新着通知）
```

- 実装: `api/chat.js`（API） / `chat-widget.js`（埋め込みウィジェット）
- スレッドは **`app` + `ref`** で一意。`ref` は各アプリ内の対象ID（申請番号・報告番号など）。
  `ref` を空にすると、そのアプリ全体の連絡板になります。

## なぜ中継が必要か

ポータル（`portal.paloma-pf.com`）と業務アプリ（`hinshitsu.paloma-pf.com` など）は
**別ドメイン**です。ポータルのログインcookieは `SameSite=Lax` のため、アプリの画面から
ポータルへ直接 fetch してもcookieが送られず、誰の発言か確定できません。

そこで、**アプリのサーバーが共有シークレット `PF_PROVISION_KEY` を付けて中継**します。
発言者の社員番号はアプリのサーバーが自分のセッションから入れるため、
ブラウザから他人になりすますことはできません。

> `PF_PROVISION_KEY` は必ずサーバー側だけで扱ってください。ブラウザに出すと誰でも
> 任意の社員番号で発言できてしまいます。

## 1. アプリ側に中継エンドポイントを作る

`/api/chat` として、ログイン中ユーザーの社員番号を足してポータルへ転送するだけです。

```js
// 例: pf-hinshitsu/api/chat.js（Vercel Serverless Function）
module.exports = async (req, res) => {
  if (req.method !== "POST") { res.status(405).json({ message: "Method not allowed" }); return; }

  // ここは各アプリのログイン確認に置き換える（社員番号をサーバー側で確定させる）
  const loginId = getLoginIdFromSession(req);
  if (!loginId) { res.status(401).json({ message: "ログインが必要です" }); return; }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

  const r = await fetch("https://portal.paloma-pf.com/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...body,                              // action / app / ref / message など
      key: process.env.PF_PROVISION_KEY,    // サーバー側だけで付ける
      loginId,                              // クライアントの申告は使わない
      app: "hinshitsu",                     // 自アプリのキーで固定する
    }),
  });
  const data = await r.json().catch(() => null);
  res.status(r.status).json(data);
};
```

`app` はアプリ側で固定してください（クライアントから渡させると、他アプリのスレッドを
読み書きできてしまいます）。

## 2. 画面にウィジェットを置く

```html
<div id="chat"></div>

<script src="https://portal.paloma-pf.com/chat-widget.js"></script>
<script>
  PFChat.mount("#chat", {
    endpoint: "/api/chat",        // 手順1で作った自アプリの中継先
    app: "hinshitsu",
    ref: "REPORT-123",            // 対象レコードのID
    title: "不具合報告 #123",      // スレッド名（通知の見出しにも使う）
    participants: ["12345", "23456"], // 関係者の社員番号（任意）
    url: location.href,           // 通知に載せる確認用リンク（任意）
    heading: "連絡・コメント"      // 見出し（任意）
  });
</script>
```

これだけで、発言一覧・入力欄・送信・15秒ごとの自動更新・既読処理まで動きます。
発言者本人の吹き出しは右寄せになります。`Ctrl + Enter` でも送信できます。

### 関係者（participants）について

- 発言した人は自動的に参加者に加わります
- `participants` を渡すと、その人たちも参加者になります（申請者・承認者など、
  まだ発言していない関係者を最初から通知対象にしたい場合に使ってください）
- 新着通知は**発言者を除く全参加者**へ届きます
- 一度加わった参加者は、再度渡しても既読状態が壊れることはありません

## 3. API仕様（中継先）

`POST https://portal.paloma-pf.com/api/chat`

| action | 内容 | 主なパラメータ |
| --- | --- | --- |
| `list` | スレッドと発言一覧を取得 | `app`, `ref`, `title?` |
| `post` | 発言する（既定） | `app`, `ref`, `message`, `title?`, `participants?`, `url?` |
| `read` | 既読にする | `app`, `ref` |
| `unread` | 自分の未読合計を取得 | （なし） |

`list` の応答:

```json
{
  "thread": {"id": "...", "app": "hinshitsu", "ref": "REPORT-123", "title": "不具合報告 #123"},
  "me": "12345",
  "messages": [
    {"id":"...", "loginId":"12345", "name":"山田 太郎", "body":"確認しました",
     "createdAt":"2026-08-05T12:00:00.000Z", "mine": true}
  ],
  "participants": [{"loginId":"12345","name":"山田 太郎"}]
}
```

制限値: 発言は2000文字以内、取得は直近200件、参加者は100名まで。

## 4. 新着通知の見え方

LINE WORKS には次の形式で届きます（宛先の決まり方は `docs/lineworks.md` と同じで、
`lineworks_id` 未登録ならメールアドレスを使います）。

```
【品質管理】チャットに新しい発言があります

不具合報告 #123

山田 太郎:
第一工場のライン2で再発しました。至急確認をお願いします。

▼確認はこちら
https://hinshitsu.paloma-pf.com/reports/123
```

LINE WORKS が未設定でも、チャット自体は問題なく動作します（通知だけスキップ）。
通知の送信に失敗しても発言は保存されます。

## 補足

- 発言中の `http(s)://` で始まるURLは自動でリンクになります。それ以外の文字列は
  すべてエスケープして表示するため、HTMLやスクリプトが実行されることはありません
- ポータル自身の画面から使う場合は、cookieのままGET/POSTできます
  （`GET /api/chat?app=X&ref=Y`、`GET /api/chat?unread=1`）
- スレッドは最初のアクセス時に自動作成されるため、事前準備は不要です
