// プロビジョニング共通処理。
// ユーザーの部署 apps に含まれる各アプリの /api/provision へ
// POST { key: PF_PROVISION_KEY, users: [{loginId,name,email?,factory?,role,approverLoginId}] } を送り、
// 結果 { results: [{loginId, status:'created'|'exists'|'error', inviteUrl?, passwordSet?}] } を
// pf_portal_provisions に UPSERT する。
// passwordSet は契約 v2.1（アプリ側パスワード設定済みか）。旧アプリ等で欠落時は null（不明）扱い。
// role は 'admin' | 'member' | 'worker'、approverLoginId は承認者（管理者）の login_id または null。
// ※ zumen はアカウント不要のためプロビジョニング対象外。
// ※ アプリ側 API 未実装・鍵未設定（503 等）や タイムアウト/通信失敗 は status:'error' として記録。

const { appBaseUrl } = require("./appUrls");

const PROVISION_APP_KEYS = ["keikaku", "nippou", "sekisai", "keisoku", "setsubi", "hinshitsu", "zaiko", "kanagata", "hoju", "tenchu", "purchasing", "jinji", "operation"];

const FETCH_TIMEOUT_MS = 15000;

function provisionUrl(appKey) {
  return `${appBaseUrl(appKey)}/api/provision`;
}

// 1アプリ分をまとめて呼ぶ。users: [{loginId,name,email?,factory?,role?,approverLoginId?}] → [{loginId,status,inviteUrl,passwordSet}]
async function callProvisionApi(appKey, users) {
  const key = (process.env.PF_PROVISION_KEY || "").trim();
  if (!key) {
    return users.map((u) => ({ loginId: u.loginId, status: "error", inviteUrl: null, passwordSet: null }));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(provisionUrl(appKey), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key,
        users: users.map((u) => ({
          loginId: u.loginId,
          name: u.name,
          email: u.email || undefined,
          factory: u.factory || undefined,
          // 役割は admin/member の2種に統一（旧データの worker は一般として連携）
          role: u.role === "admin" ? "admin" : "member",
          // ポータル管理権限。管理者専用アプリ（人事管理など）が入室可否の判定に使う。
          // 追加フィールドなので、参照しない既存アプリには影響しない。
          canManage: u.canManage === true,
          approverLoginId: u.approverLoginId || null,
        })),
      }),
      signal: controller.signal,
    });
    if (!r.ok) {
      // 未実装/鍵未設定などは 503 等が返る → error として記録
      return users.map((u) => ({ loginId: u.loginId, status: "error", inviteUrl: null, passwordSet: null }));
    }
    const data = await r.json().catch(() => null);
    const results = data && Array.isArray(data.results) ? data.results : [];
    const byLogin = new Map(results.map((x) => [String(x && x.loginId), x]));
    return users.map((u) => {
      const x = byLogin.get(u.loginId);
      if (!x) return { loginId: u.loginId, status: "error", inviteUrl: null, passwordSet: null };
      const status = x.status === "created" || x.status === "exists" ? x.status : "error";
      const inviteUrl = typeof x.inviteUrl === "string" && x.inviteUrl ? x.inviteUrl : null;
      // 契約 v2.1: passwordSet（boolean）。欠落（旧アプリ）は null = 不明
      const passwordSet = typeof x.passwordSet === "boolean" ? x.passwordSet : null;
      return { loginId: u.loginId, status, inviteUrl, passwordSet };
    });
  } catch {
    return users.map((u) => ({ loginId: u.loginId, status: "error", inviteUrl: null, passwordSet: null }));
  } finally {
    clearTimeout(timer);
  }
}

// users: [{ id, loginId, name, email, apps: [app_key,...], factory?, role?, approverLoginId? }]
// 戻り値: Map<userId, [{app, status, inviteUrl, passwordSet}]>（apps は PROVISION_APP_KEYS 順）
async function provisionUsers(sql, users) {
  const resultByUser = new Map(users.map((u) => [u.id, []]));
  if (users.length === 0) return resultByUser;

  // ポータル管理権限はここでDBから引く。呼び出し元が6か所あり、各所で
  // 積み忘れると「管理者なのにアプリに入れない」が静かに起きるため、
  // 呼び出し元に足させず必ずここで補う。
  try {
    const ids = users.map((u) => u.id).filter(Boolean);
    if (ids.length > 0) {
      const rows = await sql`
        SELECT id, can_manage FROM pf_portal_users WHERE id = ANY(${ids}::uuid[])`;
      const manageById = new Map(rows.map((r) => [r.id, r.can_manage === true]));
      for (const u of users) u.canManage = manageById.get(u.id) === true;
    }
  } catch {
    // 取得できなくても連携そのものは続ける（canManage は false 扱い）
  }

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

  const up = { userIds: [], appKeys: [], statuses: [], inviteUrls: [], passwordSets: [] };
  for (const [app, results] of settled) {
    for (const r of results) {
      const userId = idByLogin.get(r.loginId);
      if (!userId) continue;
      resultByUser.get(userId).push({ app, status: r.status, inviteUrl: r.inviteUrl, passwordSet: r.passwordSet });
      up.userIds.push(userId);
      up.appKeys.push(app);
      up.statuses.push(r.status);
      up.inviteUrls.push(r.inviteUrl);
      up.passwordSets.push(r.passwordSet);
    }
  }

  // 表示順を安定させる
  for (const list of resultByUser.values()) {
    list.sort((a, b) => PROVISION_APP_KEYS.indexOf(a.app) - PROVISION_APP_KEYS.indexOf(b.app));
  }

  if (sql && up.userIds.length > 0) {
    try {
      await sql`
        INSERT INTO pf_portal_provisions (user_id, app_key, status, invite_url, password_set)
        SELECT * FROM unnest(
          ${up.userIds}::uuid[],
          ${up.appKeys}::text[],
          ${up.statuses}::text[],
          ${up.inviteUrls}::text[],
          ${up.passwordSets}::boolean[]
        )
        ON CONFLICT (user_id, app_key) DO UPDATE SET
          status       = EXCLUDED.status,
          invite_url   = COALESCE(EXCLUDED.invite_url, pf_portal_provisions.invite_url),
          password_set = COALESCE(EXCLUDED.password_set, pf_portal_provisions.password_set),
          updated_at   = now()`;
    } catch (e) {
      console.warn("[provision] upsert failed:", e.message);
    }
  }

  return resultByUser;
}

module.exports = { PROVISION_APP_KEYS, provisionUsers, callProvisionApi };
