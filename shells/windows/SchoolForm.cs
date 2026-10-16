using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace YangShan;

/// <summary>
/// 教务窗口。它专门用来跟学校打交道：登录、抓课表。
///
/// 为什么不直接用 .NET 的 HttpClient 去调接口 —— 两个原因：
///   1. 跨源。学校接口没有 CORS 头，任何外部程序（包括我们）都不是同源。
///      在 WebView2 里走学校自己的页面，脚本就是在 jwxt.bistu.edu.cn 上跑的，跨源问题不存在。
///   2. 证书。jwxt.bistu.edu.cn 不下发中间证书，Node / curl / .NET 都会验签失败，
///      只有浏览器（靠 AIA 自动补链）能连上。
///
/// 平时它藏在屏幕外，用户的课表更新是静默完成的；只有在需要人过验证码、或者第一次
/// 登录时才会被搬到屏幕中间。
/// </summary>
internal sealed class SchoolForm : Form
{
    private const string CaptureExpr =
        "(function(){ if (typeof __ysCapture === 'undefined') return Promise.resolve('__YS_NO_CAPTURE__');" +
        " return __ysCapture({ source: 'windows' }).then(function(r){ return JSON.stringify(r); }); })()";

    private static readonly Point OffScreen = new(-32000, -32000);

    private readonly ShellRuntime _shell;
    private readonly Label _status = new();
    private readonly System.Windows.Forms.Timer _tick = new() { Interval = 1000 };

    private WebView2? _web;
    private TaskCompletionSource<string>? _pending;
    private DateTime _deadline;
    private string? _user;
    private string? _password;
    private bool _interactive;
    private bool _fillAttempted;
    private bool _capturing;
    private bool _shownForUser;

    public SchoolForm(ShellRuntime shell)
    {
        _shell = shell;
        Text = "仰山课表 · 登录学校教务";
        ClientSize = new Size(1040, 760);
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(520, 420);
        ShowInTaskbar = false;
        Location = OffScreen;

        _status.Dock = DockStyle.Top;
        _status.Height = 44;
        _status.TextAlign = ContentAlignment.MiddleLeft;
        _status.Padding = new Padding(14, 0, 14, 0);
        _status.BackColor = Color.FromArgb(245, 246, 250);
        _status.Text = "正在连接学校教务…";

        Controls.Add(_status);
        _tick.Tick += OnTick;
    }

    /// <summary>抓一次课表。interactive 为真时窗口会显示出来（首次登录、要过验证码）。</summary>
    public async Task<string> CaptureAsync(string? user, string? password, bool interactive)
    {
        await EnsureWebAsync();

        if (_pending is not null && !_pending.Task.IsCompleted)
        {
            throw new InvalidOperationException("上一次抓取还没结束");
        }

        _user = string.IsNullOrWhiteSpace(user) ? null : user!.Trim();
        _password = password ?? "";
        _interactive = interactive;
        _fillAttempted = false;
        _capturing = false;
        _shownForUser = false;

        // 没有账号可填、又需要人操作 —— 第一次用就属于这种，直接把窗口摆出来。
        if (interactive || _user is null) RevealWindow("请在这个窗口里登录学校教务系统。");

        _pending = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        _deadline = DateTime.UtcNow.AddSeconds(interactive || _user is null ? 300 : 120);
        _tick.Start();

        _web!.CoreWebView2.Navigate(ShellRuntime.SchoolEntry);
        return await _pending.Task;
    }

    /// <summary>窗口收起来（不是关掉）。Cookie 和登录状态都留着，下次刷新不用重新登。</summary>
    public void TuckAway()
    {
        if (!Visible) return;
        Hide();
        ShowInTaskbar = false;
        Location = OffScreen;
        _shownForUser = false;
    }

    private async Task EnsureWebAsync()
    {
        if (_web is not null) return;

        // 先把窗口句柄建出来，否则 WebView2 没有可挂靠的父窗口。
        CreateControl();

        _web = new WebView2 { Dock = DockStyle.Fill };
        Controls.Add(_web);
        Controls.SetChildIndex(_web, 0);

        var environment = await _shell.EnsureEnvironmentAsync();
        await _web.EnsureCoreWebView2Async(environment);

        var core = _web.CoreWebView2
            ?? throw new InvalidOperationException("WebView2 内核没有初始化成功");
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.AreDefaultContextMenusEnabled = true;

        if (!string.IsNullOrEmpty(_shell.CaptureScript))
        {
            await core.AddScriptToExecuteOnDocumentCreatedAsync(_shell.CaptureScript!);
        }

        core.NavigationCompleted += OnNavigationCompleted;
        // 登录表单在 iframe 里（normal/login-normal.html），而 CoreWebView2.FrameNavigationCompleted
        // 的事件参数拿不到 frame 本身，所以挂在 FrameCreated 上逐个订阅。
        core.FrameCreated += OnFrameCreated;
        core.NewWindowRequested += (_, e) =>
        {
            // 学校偶尔用 target=_blank 弹新窗口，我们不需要新窗口，就地跳。
            e.Handled = true;
            if (!string.IsNullOrWhiteSpace(e.Uri)) core.Navigate(e.Uri);
        };
    }

    // ── 导航 ────────────────────────────────────────────────────────────────

    private async void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (_pending is null || _pending.Task.IsCompleted) return;
        var url = _web?.Source?.ToString() ?? "";
        if (!e.IsSuccess)
        {
            if (IsSchoolHost(url) || url.Contains(ShellRuntime.SsoHost, StringComparison.OrdinalIgnoreCase))
            {
                SetStatus($"页面没加载成功（{e.WebErrorStatus}）。检查一下网络，或者在这个窗口里重试一次。");
                RevealWindow(null);
            }
            return;
        }

        if (IsSchoolHost(url))
        {
            SetStatus("已进入教务系统，正在读取课表…");
            await Task.Delay(900);
            await TryCaptureAsync();
            return;
        }

        if (url.Contains(ShellRuntime.SsoHost, StringComparison.OrdinalIgnoreCase))
        {
            if (_user is null)
            {
                RevealWindow("请在这个窗口里登录学校统一身份认证。");
            }
            else
            {
                SetStatus("正在登录…");
            }
        }
    }

    private void OnFrameCreated(object? sender, CoreWebView2FrameCreatedEventArgs e)
    {
        var frame = e.Frame;
        frame.NavigationCompleted += (_, args) =>
        {
            if (args.IsSuccess) _ = OnFrameReadyAsync(frame);
        };
    }

    private async Task OnFrameReadyAsync(CoreWebView2Frame frame)
    {
        if (_pending is null || _pending.Task.IsCompleted) return;
        if (_fillAttempted || _user is null) return;

        string href;
        try
        {
            var raw = await frame.ExecuteScriptAsync("location.href");
            href = JsonSerializer.Deserialize<string>(raw) ?? "";
        }
        catch
        {
            return; // 这个 frame 已经没了
        }

        if (!href.Contains(ShellRuntime.SsoHost, StringComparison.OrdinalIgnoreCase)) return;
        await TryFillAsync(frame);
    }

    /// <summary>
    /// 往登录表单里填账号密码。登录页是 Vue 的 v-model —— 直接改 el.value 不会更新 Vue 的状态，
    /// 必须走原型上的原生 setter，再派发一个冒泡的 input 事件，否则点提交时发出去的是空字符串。
    /// </summary>
    private async Task TryFillAsync(CoreWebView2Frame frame)
    {
        _fillAttempted = true;
        var script = FillScript(_user!, _password ?? "");
        string status;
        try
        {
            var raw = await frame.ExecuteScriptAsync(script);
            status = JsonSerializer.Deserialize<string>(raw) ?? "";
        }
        catch
        {
            _fillAttempted = false;
            return;
        }

        switch (status)
        {
            case "submitted":
                SetStatus("正在登录…");
                break;
            case "captcha":
                RevealWindow("这次登录需要过验证码，请在这个窗口里完成（账号密码已经帮你填好了）。");
                break;
            case "nofields":
                _fillAttempted = false;
                break;
            default:
                RevealWindow("请在这个窗口里登录学校统一身份认证。");
                break;
        }
    }

    /// <summary>
    /// 往登录表单里填账号密码。登录页是 Vue 的 v-model —— 直接改 el.value 不会更新 Vue 的状态，
    /// 必须走原型上的原生 setter，再派发一个冒泡的 input 事件，否则点提交时发出去的是空字符串。
    /// ★ 这个脚本跑在**登录页那个 iframe 里**（document 就是登录页自己），下面不用再翻 iframe。
    /// ★ 桌面版登录页是「扫码 / 账号密码 / 短信」三页签，而且**选中的是哪一个会被记住**
    ///   （源码里 `loginType: 'username-password'` 只是初值，紧接着被
    ///   `localStorage.getItem('loginType')` 覆盖）—— 所以完全可能停在扫码或短信页，
    ///   那时账号口令表单还在 DOM 里、只是被 v-show 藏着。填是照样能填，
    ///   但用户接手时得看见对的那一屏，所以先切过去。
    /// ★ 验证码框是 v-if="showCaptcha" 控制的，不需要时**根本不在 DOM 里**：
    ///   判「有没有」就够，**不能**判可见性（它所在的「账号密码」面板可能正被 v-show 藏着，
    ///   用 offsetParent 判会永远判不到，然后盲提交、只剩一句看不懂的「登录失败」）。
    /// ★ 同一页上 button.btn-submit 会同时命中扫码页的「刷新二维码」，
    ///   按 DOM 顺序取第一个会点错，所以要按「看得见 + 不叫刷新」来挑。
    /// </summary>
    private static string FillScript(string user, string password) =>
        "(function(){" +
        "var u=document.querySelector('input[name=\"username\"]');" +
        "var p=document.querySelector('input[name=\"password\"]');" +
        "if(!u||!p) return 'nofields';" +
        "var tabs=document.querySelectorAll('.content-tabs-title > div');" +
        "for(var i=0;i<tabs.length;i++){" +
        "if(/账号密码|帳號密碼|password/i.test(tabs[i].textContent||'')){tabs[i].click();break;}}" +
        "function set(el,v){var d=Object.getOwnPropertyDescriptor(el.constructor.prototype,'value');" +
        "if(d&&d.set){d.set.call(el,v);}else{el.value=v;}" +
        "el.dispatchEvent(new Event('input',{bubbles:true}));" +
        "el.dispatchEvent(new Event('change',{bubbles:true}));}" +
        $"set(u,{JsonSerializer.Serialize(user)});set(p,{JsonSerializer.Serialize(password)});" +
        "if(document.querySelector('#captchaId,#TencentCaptchaId,#aliCaptchaId,.ali-captcha,.captcha-box')) return 'captcha';" +
        "var bs=document.querySelectorAll('button.btn-submit,.btn-submit,button[type=\"submit\"]');" +
        "for(var k=0;k<bs.length;k++){" +
        "var b=bs[k];" +
        "if(b.offsetParent===null) continue;" +
        "if(/刷新|Refresh/i.test(b.textContent||'')) continue;" +
        "(function(x){setTimeout(function(){x.click();},200);})(b);" +
        "return 'submitted';}" +
        "p.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));" +
        "return 'submitted';" +
        "})()";

    // ── 抓取 ────────────────────────────────────────────────────────────────

    private async Task TryCaptureAsync()
    {
        if (_capturing || _web is null) return;
        _capturing = true;
        try
        {
            var result = await ShellRuntime.EvalAsync(_web, CaptureExpr);
            if (!result.Ok)
            {
                Fail(result.Error ?? "抓取失败");
                return;
            }
            var text = result.Value;
            if (string.IsNullOrEmpty(text) || text == "__YS_NO_CAPTURE__")
            {
                Fail("抓取脚本没有注入成功，可能是教务系统换了页面结构。");
                return;
            }
            // 顺手确认一下是合法 JSON，别把坏数据丢给内核。
            try
            {
                using var _ = JsonDocument.Parse(text);
            }
            catch
            {
                Fail("抓到的内容不是合法数据。");
                return;
            }
            Complete(text);
        }
        finally
        {
            _capturing = false;
        }
    }

    private void Complete(string packJson)
    {
        _tick.Stop();
        var pending = _pending;
        _pending = null;
        SetStatus("课表已更新。");
        if (!_interactive) TuckAway();
        pending?.TrySetResult(packJson);
    }

    private void Fail(string message)
    {
        _tick.Stop();
        var pending = _pending;
        _pending = null;
        SetStatus(message);
        if (pending is not null)
        {
            // 失败时把窗口摆出来：多数失败是登录过期，人得看一眼。
            RevealWindow(message);
            pending.TrySetException(new InvalidOperationException(message));
        }
    }

    // ── 窗口与超时 ──────────────────────────────────────────────────────────

    private void RevealWindow(string? status)
    {
        if (_shownForUser)
        {
            if (status is not null) SetStatus(status);
            return;
        }
        _shownForUser = true;
        if (status is not null) SetStatus(status);
        Location = new Point(
            Math.Max(0, (Screen.PrimaryScreen?.WorkingArea.Width ?? 1280 - Width) / 2),
            Math.Max(0, (Screen.PrimaryScreen?.WorkingArea.Height ?? 800 - Height) / 2));
        ShowInTaskbar = true;
        Show();
        BringToFront();
        Activate();
    }

    private void SetStatus(string text)
    {
        if (InvokeRequired)
        {
            BeginInvoke(new Action(() => _status.Text = text));
            return;
        }
        _status.Text = text;
    }

    private void OnTick(object? sender, EventArgs e)
    {
        if (_pending is null || _pending.Task.IsCompleted)
        {
            _tick.Stop();
            return;
        }
        if (DateTime.UtcNow < _deadline) return;

        var pending = _pending;
        _pending = null;
        _tick.Stop();
        var message = _user is null
            ? "还没有登录学校教务系统。"
            : "登录或抓取超时了。可能需要在窗口里手动点一下。";
        SetStatus(message);
        RevealWindow(message);
        pending?.TrySetException(new InvalidOperationException(message));
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (e.CloseReason == CloseReason.UserClosing && _pending is not null && !_pending.Task.IsCompleted)
        {
            // 用户手动关掉窗口 = 放弃这次抓取，但把窗口留下（下次刷新还要用它的登录状态）。
            e.Cancel = true;
            TuckAway();
            var pending = _pending;
            _pending = null;
            _tick.Stop();
            pending?.TrySetException(new InvalidOperationException("已取消。"));
            return;
        }
        base.OnFormClosing(e);
    }

    private static bool IsSchoolHost(string url) =>
        url.Contains(ShellRuntime.SchoolHost, StringComparison.OrdinalIgnoreCase)
        && url.Contains("/jwapp/", StringComparison.OrdinalIgnoreCase);
}
