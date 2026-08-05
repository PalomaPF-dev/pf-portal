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

レスポンス:

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
