// プロビジョニング共通処理。
// ユーザーの部署 apps に含まれる各アプリの /api/provision へ
// POST { key: PF_PROVISION_KEY, users: [{loginId,name,email}] } を送り、
// 結果 { results: [{loginId, status:'created'|'exists'|'error', inviteUrl?}] } を
// pf_portal_provisions に UPSERT する。
// ※ zumen はアカウント不要のためプロビジョニング対象外。
// ※ アプリ側 API 未実装・鍵未設定（503 等）や タイムアウト/通信失敗 は status:'error' として記録。

const PROVISION_APP_KEYS = ["keikaku", "nippou", "sekisai", "keisoku", "setsubi", "hinshitsu", "zaiko", "kanagata", "hoju"];

const FETCH_TIMEOUT_MS = 15000;

function provisionUrl(appKey) {
  return `https://pf-${appKey}.vercel.app/api/provision`;
}

// 1アプリ分をまとめて呼ぶ。users: [{loginId,name,email}] → [{loginId,status,inviteUrl}]
async function callProvisionApi(appKey, users) {
  const key = (process.env.PF_PROVISION_KEY || "").trim();
  if (!key) {
    return users.map((u) => ({ loginId: u.loginId, status: "error", inviteUrl: null }));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(provisionUrl(appKey), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key,
        users: users.map((u) => ({ loginId: u.loginId, name: u.name, email: u.email || undefined, factory: u.factory || undefined })),
      }),
      signal: controller.signal,
    });
    if (!r.ok) {
      // 未実装/鍵未設定などは 503 等が返る → error として記録
      return users.map((u) => ({ loginId: u.loginId, status: "error", inviteUrl: null }));
    }
    const data = await r.json().catch(() => null);
    const results = data && Array.isArray(data.results) ? data.results : [];
    const byLogin = new Map(results.map((x) => [String(x && x.loginId), x]));
    return users.map((u) => {
      const x = byLogin.get(u.loginId);
      if (!x) return { loginId: u.loginId, status: "error", inviteUrl: null };
      const status = x.status === "created" || x.status === "exists" ? x.status : "error";
      const inviteUrl = typeof x.inviteUrl === "string" && x.inviteUrl ? x.inviteUrl : null;
      return { loginId: u.loginId, status, inviteUrl };
    });
  } catch {
    return users.map((u) => ({ loginId: u.loginId, status: "error", inviteUrl: null }));
  } finally {
    clearTimeout(timer);
  }
}

// users: [{ id, loginId, name, email, apps: [app_key,...] }]
// 戻り値: Map<userId, [{app, status, inviteUrl}]>（apps は PROVISION_APP_KEYS 順）
async function provisionUsers(sql, users) {
  const resultByUser = new Map(users.map((u) => [u.id, []]));
  if (users.length === 0) return resultByUser;

  // アプリごとにユーザーをまとめる（1アプリ=1リクエスト）
  const byApp = new Map();
  for (const u of users) {
    const apps = Array.isArray(u.apps) ? u.apps : [];
    for (const app of apps) {
      if (!PROVISION_APP_KEYS.includes(app)) continue; // zumen・未知キーは除外
      if (!byApp.has(app)) byApp.set(app, []);
      byApp.get(app).push(u);
    }
  }
  if (byApp.size === 0) return resultByUser;

  const idByLogin = new Map(users.map((u) => [u.loginId, u.id]));

  // アプリ横断で並列実行（最大7並列・各15sタイムアウト）
  const settled = await Promise.all(
    [...byApp.entries()].map(async ([app, appUsers]) => {
      const results = await callProvisionApi(app, appUsers);
      return [app, results];
    })
  );

  const up = { userIds: [], appKeys: [], statuses: [], inviteUrls: [] };
  for (const [app, results] of settled) {
    for (const r of results) {
      const userId = idByLogin.get(r.loginId);
      if (!userId) continue;
      resultByUser.get(userId).push({ app, status: r.status, inviteUrl: r.inviteUrl });
      up.userIds.push(userId);
      up.appKeys.push(app);
      up.statuses.push(r.status);
      up.inviteUrls.push(r.inviteUrl);
    }
  }

  // 表示順を安定させる
  for (const list of resultByUser.values()) {
    list.sort((a, b) => PROVISION_APP_KEYS.indexOf(a.app) - PROVISION_APP_KEYS.indexOf(b.app));
  }

  if (sql && up.userIds.length > 0) {
    try {
      await sql`
        INSERT INTO pf_portal_provisions (user_id, app_key, status, invite_url)
        SELECT * FROM unnest(
          ${up.userIds}::uuid[],
          ${up.appKeys}::text[],
          ${up.statuses}::text[],
          ${up.inviteUrls}::text[]
        )
        ON CONFLICT (user_id, app_key) DO UPDATE SET
          status     = EXCLUDED.status,
          invite_url = COALESCE(EXCLUDED.invite_url, pf_portal_provisions.invite_url),
          updated_at = now()`;
    } catch (e) {
      console.warn("[provision] upsert failed:", e.message);
    }
  }

  return resultByUser;
}

module.exports = { PROVISION_APP_KEYS, provisionUsers, callProvisionApi };
