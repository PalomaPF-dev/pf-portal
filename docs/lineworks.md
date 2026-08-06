# LINE WORKS 連携（承認通知・お知らせのBot送信）

業務アプリの「承認の番が回ってきた」通知や簡単なお知らせを、社員のLINE WORKSへ
Botメッセージとして届けるための連携です。ポータルが LINE WORKS Server API
（Service Account 認証・スコープ `bot`）を呼び出します。

```
業務アプリ ──(POST /api/notify + PF_PROVISION_KEY)──▶ ポータル ──(Bot API)──▶ 社員のLINE WORKS
```

- 実装: `lib/lineworks.js`（認証・送信クライアント） / `api/notify.js`（受け口）
- 宛先: `pf_portal_users.lineworks_id`（管理画面で登録）。未登録ならメールアドレスを宛先に使う
  （LINE WORKSのログインIDがメール形式のため、社用メール＝LINE WORKS IDの運用ならそのまま届く）
- LINE WORKS未設定・宛先未登録でも業務アプリの処理は止まらない（送信スキップで正常応答）

## 1. LINE WORKS Developer Console での設定

[LINE WORKS Developer Console](https://dev.worksmobile.com/) に管理者アカウントでログインして行います。

1. **アプリの新規作成**（API 2.0）
   - 「API」→「アプリの新規追加」でアプリを作成（例: `業務ポータル通知`）
   - **Client ID / Client Secret** を控える
2. **Service Account の発行**
   - 作成したアプリの詳細画面で「Service Account」を発行
   - `xxxxx.serviceaccount@（会社ドメイン）` 形式のIDを控える
3. **Private Key の発行**
   - 同画面で「Private Key」を発行・ダウンロード（PEMファイル）
4. **OAuth Scope の設定**
   - アプリのスコープに **`bot`** を追加して保存する
   - ここを忘れると、トークン取得時に
     `invalid_scope: Request scope is not valid.` で失敗する
   - 保存直後は反映まで数分かかることがある
   - Console のスコープ名が `bot` と異なる場合は、環境変数 `LINEWORKS_SCOPE`
     にその名前を設定する（スペース区切りで複数指定も可）
5. **Bot の登録**
   - 「Bot」→「登録」で通知用Botを作成（例: 名前 `業務ポータル`）
   - **Bot ID**（数字）を控える
   - LINE WORKS **管理者画面（Admin）→ サービス → Bot** で、作成したBotを追加し**公開**する
     （公開しないとメッセージを送れません）

## 2. Vercel 環境変数の設定

ポータルのVercelプロジェクトに以下を設定します（Settings → Environment Variables）。

| 環境変数 | 内容 |
| --- | --- |
| `LINEWORKS_CLIENT_ID` | アプリの Client ID |
| `LINEWORKS_CLIENT_SECRET` | アプリの Client Secret |
| `LINEWORKS_SERVICE_ACCOUNT` | Service Account ID（`xxxxx.serviceaccount@…`） |
| `LINEWORKS_PRIVATE_KEY` | Private Key（PEMの中身をそのまま貼り付け。`\n` エスケープ表記でも可） |
| `LINEWORKS_BOT_ID` | Bot ID |
| `LINEWORKS_SCOPE` | （任意）要求するスコープ。未設定なら `bot` |

設定後に再デプロイすると有効になります。未設定の間は送信をスキップするだけで、
既存機能への影響はありません。

## 3. 宛先（社員のLINE WORKS ID）の登録

- 管理画面（admin.html）→ ユーザー設定 → ユーザーの追加・編集フォームの
  **「LINE WORKS ID」** に、メンバーのログインID（例 `taro@paloma-pf`）を登録
- 未登録の場合は**メールアドレス**を宛先に使う。社用メールとLINE WORKSのログインIDが
  同じ運用なら、LINE WORKS IDの個別登録は不要
- ユーザー詳細モーダルの **「テスト送信」** ボタンで疎通確認ができる

## 4. 業務アプリからの通知送信（API仕様）

各業務アプリは、承認申請の発生時などに以下を呼び出します
（認証は既存のアプリ連携と同じ共有シークレット `PF_PROVISION_KEY`）。

```
POST https://portal.paloma-pf.com/api/notify
Content-Type: application/json

{
  "key":     "<PF_PROVISION_KEY>",
  "loginId": "12345",                  // 通知したい相手の社員番号（必須）
  "message": "山田 太郎 さんから購買単価の承認申請が届いています。", // 本文（必須・2000文字以内）
  "app":     "purchasing",             // 任意: アプリキー（見出しの表示名に使う）
  "title":   "承認依頼",                // 任意: 見出し（省略時「お知らせ」）
  "url":     "https://purchasing.paloma-pf.com/#approvals" // 任意: 確認用リンク（https必須）
}
```

届くメッセージの例:

```
【購買単価】承認依頼

山田 太郎 さんから購買単価の承認申請が届いています。

▼確認はこちら
https://purchasing.paloma-pf.com/#approvals
```

### 承認依頼の通知（推奨）

**申請が発生したときは、これを使ってください。**アプリは「誰の申請か」を渡すだけで、
**通知先はポータルが決めます**（アプリ側で承認者を持つ必要がありません）。

```
POST https://portal.paloma-pf.com/api/notify

{
  "key":         "<PF_PROVISION_KEY>",
  "approvalFor": "12345",              // 申請者の社員番号（必須）
  "app":         "purchasing",         // 任意: アプリキー
  "url":         "https://purchasing.paloma-pf.com/#approvals",  // 任意
  "title":       "承認依頼",            // 任意（既定「承認依頼」）
  "message":     "..."                 // 任意（省略時は申請者名から自動生成）
}
```

届くメッセージ（`message` 省略時）:

```
【購買単価】承認依頼

申請者 花子 さんから購買単価の承認申請が届いています。

▼確認はこちら
https://purchasing.paloma-pf.com/#approvals
```

**通知先の決まり方**（LINE WORKS の宛先を持つ人が見つかるまで順に下る）:

| 順 | 通知先 | `via` |
| --- | --- | --- |
| 1 | 申請者に指定された**承認者** | `approver` |
| 2 | 申請者の**職場の管理者**（職場マスターで指定） | `workplace-admin` |
| 3 | その**職場に所属する管理者**（社員番号順） | `workplace-member-admin` |
| 4 | 申請者の**所属部署の管理者**（該当者全員・最大20名） | `department-admin` |

1〜3 は承認する人なので、宛先を持つ人が1人見つかった時点で確定します。
誰も LINE WORKS を設定していなければ 4 に回ります（LINE WORKS が工場長クラスにしか
入っていない運用でも、部署の誰かには届くようにするため）。

レスポンス例:

```json
{"ok": true, "sent": true, "sentCount": 1,
 "results": [{"loginId": "20001", "sent": true, "via": "approver"}]}
```

該当者が誰も LINE WORKS もメールも登録していない場合は
`{"ok":true, "sent":false, "reason":"no-approver-destination"}` を返します
（**200 なので、アプリ側の申請処理は止めないでください**）。

#### 各アプリへの組み込み

申請を保存した直後に、この1関数を呼ぶだけです。**通知の失敗で申請を失敗させない**よう、
待たずに投げっぱなしにします（await して例外を上げると、通知不能で申請が通らなくなります）。

```js
/** 申請の登録後に承認者へLINE WORKS通知を送る（失敗しても申請は成立させる）。 */
function notifyApproval(applicantLoginId, url) {
  const key = process.env.PF_PROVISION_KEY;
  if (!key) return;
  fetch("https://portal.paloma-pf.com/api/notify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      key,
      approvalFor: applicantLoginId,
      app: "purchasing",   // 自アプリのキー
      url,
    }),
  }).catch((e) => console.error("[notify] 承認通知に失敗:", e && e.message));
}
```

`PF_PROVISION_KEY` は既に各アプリの環境変数に入っています（SSO で使用中）。
追加の設定は要りません。

### 関係者へ一斉通知（複数宛て）

`loginId` の代わりに `loginIds`（配列・最大100名）を渡すと、関係者へまとめて送れます。
同じ社員番号は自動で重複排除されます。

```
POST https://portal.paloma-pf.com/api/notify

{
  "key":      "<PF_PROVISION_KEY>",
  "loginIds": ["12345", "23456", "34567"],
  "app":      "hinshitsu",
  "title":    "不具合報告",
  "message":  "第一工場のライン2で不具合報告が登録されました。",
  "url":      "https://hinshitsu.paloma-pf.com/#reports"
}
```

宛先ごとの結果が返ります（一部が届かなくても全体は 200）。

```json
{
  "ok": true, "sentCount": 2, "total": 3,
  "results": [
    {"loginId": "12345", "sent": true},
    {"loginId": "23456", "sent": true},
    {"loginId": "34567", "sent": false, "reason": "no-destination"}
  ]
}
```

`reason` は単数送信時と同じ値（`user-not-found` / `no-destination` / `send-failed` /
`not-configured`）です。誰に届かなかったかを呼び出し元で記録・表示できます。

### レスポンス（1名宛て）

| 状況 | ステータス | ボディ |
| --- | --- | --- |
| 送信成功 | 200 | `{"ok":true,"sent":true}` |
| LINE WORKS未設定 | 200 | `{"ok":true,"sent":false,"reason":"not-configured"}` |
| 社員番号が名簿にない | 200 | `{"ok":true,"sent":false,"reason":"user-not-found"}` |
| 宛先未登録（LINE WORKS IDもメールもなし） | 200 | `{"ok":true,"sent":false,"reason":"no-destination"}` |
| LINE WORKS APIエラー | 502 | `{"ok":false,"sent":false,"reason":"send-failed"}` |
| 認証失敗 | 401 | `{"message":"認証に失敗しました"}` |

`sent:false` は正常応答（通知は届かないが業務は継続してよい）。アプリ側は
通知送信の失敗で承認処理自体を失敗させないこと（fire-and-forget 推奨）。

## 5. 認証の仕組み（参考）

- Service Account 認証: `iss=Client ID / sub=Service Account` のJWTをRS256で署名し、
  `https://auth.worksmobile.com/oauth2/v2.0/token` でアクセストークンに交換（スコープ `bot`）
- アクセストークン（有効24時間）はサーバー内でキャッシュし、期限5分前に取り直す
- 送信は `POST https://www.worksapis.com/v1.0/bots/{botId}/users/{userId}/messages`
  （`userId` はメンバーのUUIDまたはログインID=メール形式のどちらでも可）
- 追加のnpmパッケージは不要（JWT署名はNode標準の `crypto` を使用）

## トラブルシューティング

| 症状 | 確認すること |
| --- | --- |
| テスト送信で「LINE WORKS が未設定です」 | 表示された環境変数をVercelに設定し再デプロイ |
| トークン取得に失敗（`invalid_client` 等） | Client ID / Secret / Service Account / Private Key の値。Private Keyの改行が保たれているか |
| `invalid_scope: Request scope is not valid.` | アプリの OAuth Scope に `bot` が未追加。追加・保存して数分待つ。名前が違う場合は `LINEWORKS_SCOPE` で指定 |
| `ACCESS_DENIED: Access is denied for bot.`（403） | 管理者画面（Admin）→ サービス → Bot で、その Bot が**追加・公開**されているか。公開範囲に宛先のメンバーが含まれているか。Bot ID が別アプリの Bot を指していないか（管理者ログイン中に `GET /api/notify` を開くと、このアプリが操作できる Bot 一覧と ID の一致を確認できる） |
| 送信でHTTP 404 | Bot IDが正しいか。宛先ID（ログインID／メール）がLINE WORKSのメンバーと一致しているか |
| 届かないがエラーも出ない | 対象ユーザーの `sent:false` 応答（reason）をアプリ側ログで確認 |
