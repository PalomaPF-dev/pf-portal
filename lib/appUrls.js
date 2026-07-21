// アプリ公開URL（独自ドメイン paloma-pf.com）の一覧。
const APP_BASE_URLS = {
  keikaku: "https://plan.paloma-pf.com",
  nippou: "https://pf-nippou.vercel.app",
  sekisai: "https://sekisai.paloma-pf.com",
  zumen: "https://zumen.paloma-pf.com",
  keisoku: "https://keisoku.paloma-pf.com",
  setsubi: "https://setsubi.paloma-pf.com",
  hinshitsu: "https://hinshitsu.paloma-pf.com",
  zaiko: "https://zaiko.paloma-pf.com",
  kanagata: "https://kanagata.paloma-pf.com",
  hoju: "https://pf-hoju.vercel.app",
  tenchu: "https://tenchu.paloma-pf.com",
};

// 未知のキーは従来規則（pf-<key>.vercel.app）へフォールバック。
function appBaseUrl(appKey) {
  return APP_BASE_URLS[appKey] || `https://pf-${appKey}.vercel.app`;
}

module.exports = { APP_BASE_URLS, appBaseUrl };
