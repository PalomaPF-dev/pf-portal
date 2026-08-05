/*!
 * 業務アプリ組み込み用チャットウィジェット（株式会社パロマ 生産・調達統括本部）
 *
 * 各アプリで同じものを作り直さずに済むよう、ポータルが配信する 1 ファイルにまとめている。
 * 使い方（詳細は docs/chat.md）:
 *   <div id="chat"></div>
 *   <script src="https://portal.paloma-pf.com/chat-widget.js"></script>
 *   <script>
 *     PFChat.mount("#chat", {
 *       endpoint: "/api/chat",      // 自アプリ側の中継エンドポイント
 *       app: "hinshitsu",
 *       ref: "REPORT-123",           // 対象レコードのID
 *       title: "不具合報告 #123",
 *       participants: ["12345"],     // 関係者（任意）
 *       url: location.href           // 通知に載せる確認用リンク（任意）
 *     });
 *   </script>
 *
 * ブラウザから直接ポータルを叩かない（別ドメインのためcookieが飛ばない）。
 * 必ず自アプリのサーバーで中継すること。
 */
(function (global) {
  "use strict";

  var POLL_MS = 15000;

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // 発言中のURLだけリンクにする。URLの判定は「生テキスト」に対して行い、
  // URL部分・それ以外を分けてから個別にエスケープする。
  // （エスケープ後の文字列に対して行うと、URL直後の &quot; などの実体参照まで
  //   URLの一部として飲み込み、リンクが壊れる）
  // 判定は http/https のみ。javascript: 等はリンク化しない。
  function linkify(raw) {
    var re = /https?:\/\/[^\s<>"']+/g;
    var out = "", last = 0, m;
    while ((m = re.exec(raw)) !== null) {
      out += esc(raw.slice(last, m.index));
      var u = esc(m[0]); // 属性値・表示文字の双方に使う（< > " ' は元々含まれない）
      out += '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + u + "</a>";
      last = m.index + m[0].length;
    }
    return out + esc(raw.slice(last));
  }

  function timeLabel(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    var now = new Date();
    var sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    var hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    if (sameDay) return hm;
    return (d.getMonth() + 1) + "/" + d.getDate() + " " + hm;
  }

  var CSS = [
    ".pfchat{display:flex;flex-direction:column;border:1px solid #e3e3e6;border-radius:10px;background:#fff;font-family:inherit;overflow:hidden}",
    ".pfchat-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #eee;font-size:13px;font-weight:600;color:#333}",
    ".pfchat-head .pfchat-count{margin-left:auto;font-weight:400;font-size:11.5px;color:#888}",
    ".pfchat-list{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:10px;min-height:180px;max-height:420px;background:#fafafa}",
    ".pfchat-empty{color:#999;font-size:12.5px;text-align:center;padding:24px 0}",
    ".pfchat-msg{display:flex;flex-direction:column;max-width:82%}",
    ".pfchat-msg.mine{align-self:flex-end;align-items:flex-end}",
    ".pfchat-meta{font-size:11px;color:#888;margin-bottom:3px}",
    ".pfchat-bubble{padding:8px 11px;border-radius:10px;background:#fff;border:1px solid #e6e6e9;font-size:13px;line-height:1.7;white-space:pre-wrap;word-break:break-word;color:#222}",
    ".pfchat-msg.mine .pfchat-bubble{background:#e8f1fd;border-color:#d3e3f8}",
    ".pfchat-bubble a{color:#1558b0}",
    ".pfchat-form{display:flex;gap:8px;padding:10px;border-top:1px solid #eee;background:#fff}",
    ".pfchat-form textarea{flex:1;resize:vertical;min-height:38px;max-height:140px;padding:8px 10px;border:1px solid #d8d8dc;border-radius:8px;font-family:inherit;font-size:13px;line-height:1.6;color:#222;background:#fff}",
    ".pfchat-form button{padding:0 16px;border:0;border-radius:8px;background:#c8102e;color:#fff;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap}",
    ".pfchat-form button:disabled{opacity:.55;cursor:default}",
    ".pfchat-msgbox{padding:8px 12px;font-size:12px;color:#b3261e;background:#fdeced;border-top:1px solid #f6d5d8}",
    ".pfchat-msgbox.hidden{display:none}",
  ].join("");

  function injectCss() {
    if (document.getElementById("pfchat-css")) return;
    var st = document.createElement("style");
    st.id = "pfchat-css";
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function Chat(root, opts) {
    this.root = root;
    this.o = opts;
    this.lastId = null;
    this.timer = null;
    this.busy = false;
    this.render();
    this.load(true);
    var self = this;
    // 画面が見えている間だけ取りに行く（裏に回ったタブが叩き続けないように）
    this.timer = setInterval(function () {
      if (!document.hidden) self.load(false);
    }, POLL_MS);
  }

  Chat.prototype.api = function (payload) {
    return fetch(this.o.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(payload),
    }).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (d) {
        if (!r.ok) throw new Error((d && d.message) || "通信に失敗しました (" + r.status + ")");
        return d;
      });
    });
  };

  Chat.prototype.render = function () {
    injectCss();
    this.root.innerHTML =
      '<div class="pfchat">' +
      '<div class="pfchat-head"><span>' + esc(this.o.heading || "連絡・コメント") + "</span>" +
      '<span class="pfchat-count"></span></div>' +
      '<div class="pfchat-list"><div class="pfchat-empty">読み込み中…</div></div>' +
      '<div class="pfchat-msgbox hidden"></div>' +
      '<form class="pfchat-form"><textarea placeholder="メッセージを入力（Ctrl+Enterで送信）"></textarea>' +
      '<button type="submit">送信</button></form>' +
      "</div>";
    this.elList = this.root.querySelector(".pfchat-list");
    this.elCount = this.root.querySelector(".pfchat-count");
    this.elMsg = this.root.querySelector(".pfchat-msgbox");
    this.elForm = this.root.querySelector(".pfchat-form");
    this.elText = this.root.querySelector("textarea");
    this.elBtn = this.root.querySelector("button");

    var self = this;
    this.elForm.addEventListener("submit", function (e) {
      e.preventDefault();
      self.send();
    });
    this.elText.addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        self.send();
      }
    });
  };

  Chat.prototype.error = function (msg) {
    if (!msg) { this.elMsg.classList.add("hidden"); return; }
    this.elMsg.textContent = msg;
    this.elMsg.classList.remove("hidden");
  };

  Chat.prototype.draw = function (data) {
    var msgs = data.messages || [];
    this.elCount.textContent = msgs.length ? msgs.length + "件" : "";
    if (msgs.length === 0) {
      this.elList.innerHTML = '<div class="pfchat-empty">まだ発言はありません</div>';
      this.lastId = null;
      return;
    }
    var newest = msgs[msgs.length - 1].id;
    if (newest === this.lastId) return; // 変化なしなら描き直さない（入力中のスクロールを乱さない）
    var atBottom = this.elList.scrollHeight - this.elList.scrollTop - this.elList.clientHeight < 60;
    var html = "";
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      html +=
        '<div class="pfchat-msg' + (m.mine ? " mine" : "") + '">' +
        '<div class="pfchat-meta">' + esc(m.name) + "　" + esc(timeLabel(m.createdAt)) + "</div>" +
        '<div class="pfchat-bubble">' + linkify(m.body) + "</div></div>";
    }
    this.elList.innerHTML = html;
    var first = this.lastId === null;
    this.lastId = newest;
    if (first || atBottom) this.elList.scrollTop = this.elList.scrollHeight;
  };

  Chat.prototype.load = function (first) {
    var self = this;
    return this.api({ action: "list", app: this.o.app, ref: this.o.ref, title: this.o.title })
      .then(function (d) {
        self.error("");
        self.draw(d || {});
        if (first) self.api({ action: "read", app: self.o.app, ref: self.o.ref }).catch(function () {});
      })
      .catch(function (e) {
        // 定期取得の失敗はうるさいので初回だけ出す
        if (first) self.error(e.message);
      });
  };

  Chat.prototype.send = function () {
    if (this.busy) return;
    var text = this.elText.value.trim();
    if (!text) return;
    var self = this;
    this.busy = true;
    this.elBtn.disabled = true;
    this.api({
      action: "post",
      app: this.o.app,
      ref: this.o.ref,
      title: this.o.title,
      participants: this.o.participants,
      url: this.o.url,
      message: text,
    })
      .then(function () {
        self.elText.value = "";
        self.error("");
        return self.load(false);
      })
      .catch(function (e) { self.error(e.message); })
      .then(function () {
        self.busy = false;
        self.elBtn.disabled = false;
      });
  };

  Chat.prototype.destroy = function () {
    if (this.timer) clearInterval(this.timer);
    this.root.innerHTML = "";
  };

  var PFChat = {
    mount: function (target, opts) {
      var root = typeof target === "string" ? document.querySelector(target) : target;
      if (!root) throw new Error("PFChat: 表示先の要素が見つかりません: " + target);
      opts = opts || {};
      if (!opts.app) throw new Error("PFChat: app を指定してください");
      return new Chat(root, {
        endpoint: opts.endpoint || "/api/chat",
        app: opts.app,
        ref: opts.ref == null ? "" : String(opts.ref),
        title: opts.title || "",
        heading: opts.heading || "",
        participants: Array.isArray(opts.participants) ? opts.participants : [],
        url: opts.url || "",
      });
    },
  };

  global.PFChat = PFChat;
})(window);
