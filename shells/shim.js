/**
 * 壳注入给课表内核的接口。Windows 壳与安卓壳共用这一份 —— 免得两边各自漂移。
 *
 * 契约（内核 web/app.js:676 只认这个）：
 *   globalThis.YangShanShell = {
 *     name: 'windows' | 'android', version: 1,
 *     login(username, password), refresh(), status(), forget(),
 *     notify(title, body), openExternal(url)
 *   }
 * 内核在用户点「输入教务账号密码」的那一刻才读它：
 *   读得到 → 真的出现登录框；读不到 → 走降级说明页（讲清楚浏览器为什么做不到）。
 * 所以晚一点注入也没关系，但**必须**注入。
 *
 * 出站（页面 → 壳）两种传输，自己挑：
 *   Windows：window.chrome.webview.postMessage(obj)
 *   安卓：  YangShanNative.post(JSON.stringify(obj))   ← @JavascriptInterface
 *
 * 入站（壳 → 页面）也两种：
 *   Windows：chrome.webview 的 'message' 事件
 *   安卓：  壳 evaluateJavascript 调 window.__ysShellReply('<json>')
 */
(function () {
  if (globalThis.YangShanShell) return;

  var seq = 0;
  var pending = {};

  function post(m) {
    try {
      if (globalThis.chrome && chrome.webview && chrome.webview.postMessage) {
        chrome.webview.postMessage(m);
        return;
      }
      if (globalThis.YangShanNative && YangShanNative.post) {
        YangShanNative.post(JSON.stringify(m));
      }
    } catch (e) {}
  }

  function settle(m) {
    if (!m || !m.id) return;
    var p = pending[m.id];
    if (!p) return;
    delete pending[m.id];
    if (m.ok) p.resolve(m.pack);
    else p.reject(new Error(m.error || '抓取失败'));
  }

  try {
    if (globalThis.chrome && chrome.webview && chrome.webview.addEventListener) {
      chrome.webview.addEventListener('message', function (ev) { settle(ev.data); });
    }
  } catch (e) {}

  globalThis.__ysShellReply = function (json) {
    try { settle(typeof json === 'string' ? JSON.parse(json) : json); } catch (e) {}
  };

  function call(cmd, payload) {
    return new Promise(function (resolve, reject) {
      var id = 'r' + (++seq);
      pending[id] = { resolve: resolve, reject: reject };
      var m = { cmd: cmd, id: id };
      if (payload) { for (var k in payload) { m[k] = payload[k]; } }
      post(m);
    });
  }

  globalThis.YangShanShell = {
    name: globalThis.__ysShellName || 'shell',
    version: 1,
    login: function (username, password) { return call('login', { username: username, password: password }); },
    refresh: function () { return call('refresh'); },
    status: function () { return call('status'); },
    forget: function () { return call('forget'); },
    notify: function (title, body) { post({ cmd: 'notify', title: title, body: body }); },
    requestNotifications: function () { return call('requestNotifications'); },
    openExternal: function (url) { post({ cmd: 'open', url: url }); },
    // 把公告频道交给原生侧，让它在 App 关掉之后也能收。
    // 单向、不回包：前台服务是异步起来的，此刻回“成功”是不诚实 ——
    // 真实状态由 status() 的 annPush 字段说话。
    // Windows 壳不认这条命令，会直接忽略（它没有后台推送这件事）。
    setAnnPush: function (sources, base) {
      // sources 是 [{id, topic, url}]；保留数组形状，安卓壳可按源分别监听和去重。
      post({ cmd: 'annpush', sources: Array.isArray(sources) ? sources : [], base: base || '' });
    }
  };
})();
