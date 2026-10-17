// 抓取内核 —— 在教务系统自己的页面里运行，把三段原始响应取回来。
//
// 这是**唯一一份**抓取实现：书签小工具（bookmarklet/grab.js 只留界面）与各平台
// 客户端壳（shells/windows 通过 EmbeddedResource 注入）都调这里的 __ysCapture。
// 教务接口真变了的时候，只需要改这一个文件。
//
// 它只负责取数据，不做任何解析 —— 解析规则留在 core/ 里，
// 所以改规则既不需要用户重新存书签，也不需要重新装客户端。

(function () {
  // Use absolute URLs. Android WebView can expose the school page with the
  // literal *default route as a non-standard document base, which makes
  // a relative fetch fail before any request is sent.
  var API_ORIGIN = 'https://jwxt.bistu.edu.cn';
  var API_USER = API_ORIGIN + '/jwapp/sys/homeapp/api/home/currentUser.do';
  var API_WEEKS = API_ORIGIN + '/jwapp/sys/kbbpapp/api/schoolCalendar/getTermWeeks.do';
  var API_SCHED = API_ORIGIN + '/jwapp/sys/homeapp/api/home/student/getMyScheduleDetail.do';
  var RAW_PREFIX = 'YSRAW1-';

  function get(url, onLog) {
    return fetch(url, {
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    }).then(function (r) {
      return r.text().then(function (text) {
        var summary = 'status=' + r.status + ' bytes=' + text.length;
        if (!r.ok) {
          if (onLog) onLog('GET ' + url + ' ' + summary);
          throw new Error(url + ' → HTTP ' + r.status);
        }
        var value;
        try { value = JSON.parse(text); } catch (e) {
          if (onLog) onLog('GET ' + url + ' ' + summary + ' invalid-json');
          throw new Error(url + ' → 返回内容不是 JSON');
        }
        if (onLog) onLog('GET ' + url + ' ' + summary + ' ' + describe(value));
        return value;
      });
    }).catch(function (e) {
      if (onLog) onLog('GET fetch-reject name=' + ((e && e.name) || 'Error') +
        ' message=' + ((e && e.message) || e));
      throw e;
    });
  }

  function post(url, body, onLog) {
    return fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: body,
    }).then(function (r) {
      return r.text().then(function (text) {
        var summary = 'status=' + r.status + ' bytes=' + text.length;
        if (!r.ok) {
          if (onLog) onLog('POST ' + url + ' ' + summary);
          throw new Error(url + ' → HTTP ' + r.status);
        }
        var value;
        try { value = JSON.parse(text); } catch (e) {
          if (onLog) onLog('POST ' + url + ' ' + summary + ' invalid-json');
          throw new Error(url + ' → 返回内容不是 JSON');
        }
        if (onLog) onLog('POST ' + url + ' ' + summary + ' ' + describe(value));
        return value;
      });
    }).catch(function (e) {
      if (onLog) onLog('POST fetch-reject name=' + ((e && e.name) || 'Error') +
        ' message=' + ((e && e.message) || e));
      throw e;
    });
  }

  function describe(value) {
    if (Array.isArray(value)) return 'array=' + value.length;
    if (!value || typeof value !== 'object') return 'type=' + typeof value;
    var keys = Object.keys(value).slice(0, 12).join(',');
    var d = value.datas;
    var detail = d && typeof d === 'object'
      ? ' datasKeys=' + Object.keys(d).slice(0, 12).join(',')
      : '';
    return 'objectKeys=' + keys + detail;
  }

  function b64url(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // 返回 Promise<captured>。captured 的形状与 core/model.mjs 的 isRawCapture 对齐：
  //   { kind:'yangshan-raw', schema:1, source, capturedAt, currentUser, termWeeks, scheduleDetail }
  // 失败时抛 Error，message 是已经写好、可以直接展示给用户的中文。
  function capture(opts) {
    opts = opts || {};
    var say = opts.onStep || function () {};
    var log = opts.onLog || function () {};
    var source = opts.source || 'page';
    var captured = {
      kind: 'yangshan-raw',
      schema: 1,
      source: source,
      capturedAt: new Date().toISOString(),
    };
    var termCode = '';
    var studentCode = '';

    log('capture-start source=' + source);
    say('读取当前用户…');
    return get(API_USER, log)
      .then(function (cu) {
        captured.currentUser = cu;
        var d = (cu && cu.datas) || cu || {};
        var wi = d.welcomeInfo || {};
        termCode = wi.xnxqdm || d.xnxqdm || '';
        studentCode =
          d.userId ||
          (d.user && (d.user.xh || d.user.usrId)) ||
          (d.student && d.student.xh) ||
          wi.xh ||
          '';
        if (!termCode) {
          log('current-user missing-term-code');
          throw new Error('没读到当前学期代码，可能是登录已过期。请重新登录教务系统后再试一次。');
        }
        log('current-user ok term-present=true student-present=' + (!!studentCode));
        say('当前学期 ' + termCode + '，读取周历…');
        return post(API_WEEKS, 'XNXQDM=' + encodeURIComponent(termCode), log);
      })
      .then(function (weeks) {
        captured.termWeeks = weeks;
        var arr = (weeks && weeks.datas && weeks.datas.getTermWeeks) || [];
        if (!arr.length) {
          log('term-weeks empty');
          throw new Error('教务系统没有返回学期周历（可能这一学期还没开始）。');
        }
        log('term-weeks count=' + arr.length);
        say('共 ' + arr.length + ' 周，读取课表…');
        var body =
          'termCode=' + encodeURIComponent(termCode) +
          (studentCode
            ? '&studentCode=' + encodeURIComponent(studentCode) + '&xh=' + encodeURIComponent(studentCode)
            : '') +
          '&type=term';
        return post(API_SCHED, body, log);
      })
      .then(function (sched) {
        captured.scheduleDetail = sched;
        var list = (sched && sched.datas && sched.datas.arrangedList) || [];
        if (!list.length) {
          log('schedule empty');
          throw new Error('这一学期没有读到任何课程。如果课表里确实有课，可能是教务系统改了接口。');
        }
        log('schedule ok courses=' + list.length);
        say('已抓到 ' + list.length + ' 门课');
        return captured;
      });
  }

  // 把 captured 包成一行可复制的文本（书签小工具与「导出成 .txt」用）。
  // 前缀 + base64url 是为了让它能安全地经过剪贴板与聊天软件而不被改动。
  function rawText(captured) {
    return RAW_PREFIX + b64url(JSON.stringify(captured));
  }

  globalThis.__ysCapture = capture;
  globalThis.__ysCapture.rawText = rawText;
  globalThis.__ysCapture.RAW_PREFIX = RAW_PREFIX;
  globalThis.__ysCapture.HOST = 'jwxt.bistu.edu.cn';
  globalThis.__ysCapture.ENTRY = 'https://jwxt.bistu.edu.cn/jwapp/sys/kbapp/*default/index.do';
  globalThis.__ysCapture.API = { user: API_USER, weeks: API_WEEKS, sched: API_SCHED };
})();
