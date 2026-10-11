(function () {
  var C = globalThis.__ysCapture;
  if (!C) {
    alert('仰山课表：抓取内核没加载上。请回到「仰山课表 → 我的 → 抓取书签」重新复制一次书签。');
    return;
  }

  function panel() {
    var old = document.getElementById('ys-grab');
    if (old) old.remove();
    var host = document.createElement('div');
    host.id = 'ys-grab';
    host.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.5);' +
      'display:flex;align-items:center;justify-content:center;padding:16px';
    var sh = host.attachShadow({ mode: 'open' });
    sh.innerHTML =
      '<style>' +
      '*{box-sizing:border-box}' +
      '.box{background:#fff;color:#1a1d21;border-radius:14px;max-width:560px;width:100%;' +
      'max-height:86vh;overflow:auto;padding:18px;box-shadow:0 16px 48px rgba(0,0,0,.35);' +
      'font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}' +
      'h2{margin:0 0 4px;font-size:17px}' +
      'p{margin:6px 0;color:#57606a;font-size:13px}' +
      '.st{font-weight:600;font-size:14px;margin:12px 0;color:#1f6feb}' +
      '.st.err{color:#d1242f}' +
      'textarea{width:100%;height:120px;font:12px ui-monospace,Consolas,monospace;' +
      'border:1px solid #e3e6ea;border-radius:9px;padding:8px;resize:vertical}' +
      'button{border:0;border-radius:9px;padding:9px 15px;font:inherit;font-weight:550;cursor:pointer}' +
      '.p{background:#1f6feb;color:#fff}.p:hover{filter:brightness(1.08)}' +
      '.g{background:#eef1f4;color:#1a1d21}' +
      '.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}' +
      '</style>' +
      '<div class="box">' +
      '<h2>仰山课表 · 抓取</h2>' +
      '<p>数据只在这台设备上处理，不会发往任何服务器。</p>' +
      '<div class="st" id="st">准备中…</div>' +
      '<div id="body"></div>' +
      '<div class="row" id="row"></div>' +
      '</div>';
    document.body.appendChild(host);
    return {
      host: host,
      st: sh.getElementById('st'),
      body: sh.getElementById('body'),
      row: sh.getElementById('row'),
      close: function () { host.remove(); },
      say: function (t, err) { this.st.textContent = t; this.st.className = 'st' + (err ? ' err' : ''); },
      button: function (label, cls, fn) {
        var b = document.createElement('button');
        b.className = cls;
        b.textContent = label;
        b.onclick = fn;
        sh.getElementById('row').appendChild(b);
        return b;
      },
    };
  }

  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(
        function () { return true; },
        function () { return false; },
      );
    }
    return Promise.resolve(false);
  }

  if (location.hostname !== C.HOST) {
    if (confirm('请先打开教务系统的课表页面再点这个书签。\n\n现在跳转到教务系统吗？')) {
      location.href = C.ENTRY;
    }
    return;
  }

  var ui = panel();
  ui.say('准备中…');

  C({
    source: 'bookmarklet',
    onStep: function (t) { ui.say(t); },
  })
    .then(function (captured) {
      var text = C.rawText(captured);
      var list = (captured.scheduleDetail && captured.scheduleDetail.datas &&
        captured.scheduleDetail.datas.arrangedList) || [];
      ui.say('已抓到 ' + list.length + ' 条课程记录，共 ' + Math.round(text.length / 1024) + ' KB');

      var ta = document.createElement('textarea');
      ta.readOnly = true;
      ta.value = text;
      ui.body.appendChild(ta);
      ta.addEventListener('focus', function () { ta.select(); });

      return copy(text).then(function (ok) {
        if (ok) {
          ui.say('✅ 已复制到剪贴板。现在打开「仰山课表」，在导入里粘贴。');
        } else {
          ui.say('无法自动复制，请手动全选下面的文本（已帮你选中）。');
          ta.focus();
          ta.select();
        }
        ui.button('再复制一次', 'p', function () {
          copy(text).then(function (ok2) {
            if (!ok2) { ta.focus(); ta.select(); }
            ui.say(ok2 ? '✅ 已复制' : '请手动复制选中的文本');
          });
        });
        ui.button('关闭', 'g', function () { ui.close(); });
      });
    })
    .catch(function (e) {
      ui.say('抓取失败：' + (e && e.message ? e.message : e), true);
      ui.button('重试', 'p', function () { ui.close(); setTimeout(function () { location.reload(); }, 60); });
      ui.button('关闭', 'g', function () { ui.close(); });
    });
})();
