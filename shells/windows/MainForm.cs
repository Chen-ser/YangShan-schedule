using System.Diagnostics;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace YangShan;

/// <summary>
/// 主窗口：把课表内核装进一个没有地址栏的窗口，并补上浏览器做不到的两件事 ——
/// 直连学校教务抓数据、每小时自动刷新一次。
/// </summary>
internal sealed class MainForm : Form
{
    // 注入给内核的壳接口（globalThis.YangShanShell）与抓取内核（__ysCapture）都不是硬编码在这里的：
    // 前者是 shells/shim.js、后者是 shells/capture.js，都是 EmbeddedResource ——
    // 和安卓壳、书签小工具共用同一份源码，改规则不用三处一起改。
    // 内核里 modalImportAccount()（web/app.js:676）会读 globalThis.YangShanShell，
    // 读到就把「机构登录」做成真的能用的入口，读不到就走降级说明页。

    private readonly ShellRuntime _shell;
    private readonly WebView2 _web = new() { Dock = DockStyle.Fill };
    private readonly NotifyIcon _tray;
    private readonly System.Windows.Forms.Timer _auto = new();
    private SchoolForm? _school;
    private bool _balloonShown;

    /// <summary>给界面自检（UiTest）用的入口，把内部的 WebView2 露出去。</summary>
    internal WebView2 Web => _web;

    public MainForm(ShellRuntime shell)
    {
        _shell = shell;

        Text = "仰山课表";
        ClientSize = new Size(1000, 780);
        MinimumSize = new Size(420, 560);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.White;

        Controls.Add(_web);

        // 窗口与托盘共用一个图标，来源是 exe 里嵌的那份 app.ico（见 csproj 的 <ApplicationIcon>）。
        // 之前托盘写死 SystemIcons.Application，exe 换成品牌图标后托盘会一直是系统默认的那个。
        var appIcon = Icon.ExtractAssociatedIcon(Environment.ProcessPath ?? Application.ExecutablePath);
        if (appIcon is not null) Icon = appIcon;

        _tray = new NotifyIcon
        {
            Icon = appIcon ?? SystemIcons.Application,
            Text = "仰山课表",
            Visible = true,
        };
        _tray.DoubleClick += (_, _) => RestoreFromTray();

        var menu = new ContextMenuStrip();
        menu.Items.Add("打开仰山课表", null, (_, _) => RestoreFromTray());
        menu.Items.Add("立即刷新课表", null, async (_, _) => await RefreshQuietlyAsync());
        menu.Items.Add(new ToolStripSeparator());
        var autoItem = new ToolStripMenuItem("每小时自动更新") { CheckOnClick = true, Checked = _shell.Settings.AutoRefreshEnabled };
        autoItem.CheckedChanged += (_, _) =>
        {
            _shell.Settings.AutoRefreshEnabled = autoItem.Checked;
            _shell.SaveSettings();
            ApplyAutoRefresh();
        };
        menu.Items.Add(autoItem);
        menu.Items.Add("忘记记住的账号", null, (_, _) =>
        {
            CredStore.Forget();
            _shell.Settings.Username = null;
            _shell.SaveSettings();
            _tray.ShowBalloonTip(3000, "仰山课表", "已经从 Windows 凭据管理器里删掉了保存的账号。", ToolTipIcon.Info);
        });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出", null, (_, _) => ExitApp());

        _tray.ContextMenuStrip = menu;

        _auto.Tick += async (_, _) => await RefreshQuietlyAsync();

        Load += async (_, _) => await InitializeAsync();
        FormClosing += OnFormClosing;
    }

    // ── 启动 ────────────────────────────────────────────────────────────────

    private async Task InitializeAsync()
    {
        try
        {
            var environment = await _shell.EnsureEnvironmentAsync();
            await _web.EnsureCoreWebView2Async(environment);

            var core = _web.CoreWebView2
                ?? throw new InvalidOperationException("WebView2 内核没有初始化成功");
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreDevToolsEnabled = true;
            core.NewWindowRequested += (_, e) =>
            {
                e.Handled = true;
                OpenExternal(e.Uri);
            };
            core.WebMessageReceived += OnWebMessageReceived;
            if (string.IsNullOrWhiteSpace(_shell.ShimScript))
            {
                throw new InvalidOperationException("shim.js 没有作为资源打进 exe，内核拿不到壳接口。");
            }
            await core.AddScriptToExecuteOnDocumentCreatedAsync(
                "globalThis.__ysShellName='windows';\n" + _shell.ShimScript);

            if (_shell.AppUrl is not null && _shell.AppUrl.StartsWith($"https://{ShellRuntime.VirtualHost}/", StringComparison.OrdinalIgnoreCase))
            {
                // file:// 下 Chromium 不给 localStorage，而内核靠它存课表 ——
                // 所以把内核托到一个虚拟的 https 源上，内核自己完全不知道。
                core.SetVirtualHostNameToFolderMapping(
                    ShellRuntime.VirtualHost, _shell.AppFolder, CoreWebView2HostResourceAccessKind.Allow);
            }

            core.Navigate(_shell.AppUrl ?? ShellRuntime.HostedUrl);
            ApplyAutoRefresh();

            if (!string.IsNullOrEmpty(_shell.StartupNote))
            {
                _tray.ShowBalloonTip(5000, "仰山课表", _shell.StartupNote!, ToolTipIcon.Warning);
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                "WebView2 没能启动：" + ex.Message + "\r\n\r\n装一下 Microsoft Edge WebView2 Runtime 再试。",
                "仰山课表", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private void ApplyAutoRefresh()
    {
        _auto.Stop();
        if (!_shell.Settings.AutoRefreshEnabled) return;
        var minutes = Math.Clamp(_shell.Settings.AutoRefreshMinutes, 5, 24 * 60);
        _auto.Interval = minutes * 60 * 1000;
        _auto.Start();
    }

    // ── 与内核对话 ──────────────────────────────────────────────────────────

    private async void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        JsonElement root;
        try
        {
            using var doc = JsonDocument.Parse(e.WebMessageAsJson);
            root = doc.RootElement.Clone();
        }
        catch
        {
            return;
        }

        var cmd = root.TryGetProperty("cmd", out var c) ? c.GetString() : null;
        var id = root.TryGetProperty("id", out var i) ? i.GetString() : null;

        try
        {
            switch (cmd)
            {
                case "login":
                {
                    var user = root.TryGetProperty("username", out var u) ? u.GetString() : null;
                    var pass = root.TryGetProperty("password", out var p) ? p.GetString() : null;
                    var json = await CaptureAsync(user, pass, interactive: true);
                    if (_shell.Settings.RememberPassword && !string.IsNullOrWhiteSpace(user))
                    {
                        CredStore.Save(user!, pass ?? "");
                        _shell.Settings.Username = user;
                        _shell.SaveSettings();
                    }
                    Reply(id, true, json, null);
                    break;
                }
                case "refresh":
                {
                    var json = await RefreshQuietlyAsync();
                    if (json is null)
                    {
                        Reply(id, false, null, "自动刷新失败，请查看托盘提示后重试。");
                    }
                    else
                    {
                        Reply(id, true, json, null);
                    }
                    break;
                }
                case "status":
                {
                    var stored = CredStore.Load();
                    var hasSchedule = false;
                    if (_web.CoreWebView2 is not null)
                    {
                        var probe = await ShellRuntime.EvalAsync(
                            _web,
                            "(globalThis.YangShan && typeof YangShan.hasSchedule === 'function') ? String(YangShan.hasSchedule()) : 'false'");
                        hasSchedule = probe.Ok && string.Equals(probe.Value, "true", StringComparison.OrdinalIgnoreCase);
                    }
                    var payload = JsonSerializer.Serialize(new
                    {
                        name = "windows",
                        // 从程序集元数据取，别再手写 —— 这里写死过 "0.1.9"，而当时
                        // 全局版本已经是 0.1.12：一旦有谁开始用这个字段就会拿到错值。
                        version = typeof(MainForm).Assembly.GetName().Version?.ToString(3) ?? "",
                        hasSchedule,
                        remembered = stored is not null,
                        username = stored?.User ?? _shell.Settings.Username,
                        autoRefresh = _shell.Settings.AutoRefreshEnabled,
                        autoRefreshMinutes = _shell.Settings.AutoRefreshMinutes,
                    });
                    Reply(id, true, payload, null);
                    break;
                }
                case "forget":
                {
                    CredStore.Forget();
                    _shell.Settings.Username = null;
                    _shell.SaveSettings();
                    Reply(id, true, "{}", null);
                    break;
                }
                case "notify":
                {
                    var title = root.TryGetProperty("title", out var t) ? t.GetString() : "仰山课表";
                    var body = root.TryGetProperty("body", out var b) ? b.GetString() : "";
                    _tray.ShowBalloonTip(6000, title ?? "仰山课表", body ?? "", ToolTipIcon.Info);
                    break;
                }
                case "notifyReminder":
                {
                    var title = root.TryGetProperty("title", out var t) ? t.GetString() : "仰山课表提醒";
                    var body = root.TryGetProperty("body", out var b) ? b.GetString() : "";
                    _tray.ShowBalloonTip(6000, title ?? "仰山课表提醒", body ?? "", ToolTipIcon.Info);
                    break;
                }
                case "requestNotifications":
                    // Windows notifications use the tray balloon and need no runtime permission.
                    Reply(id, true, "{\"granted\":true}", null);
                    break;
                case "open":
                {
                    var url = root.TryGetProperty("url", out var url2) ? url2.GetString() : null;
                    if (!string.IsNullOrWhiteSpace(url)) OpenExternal(url!);
                    break;
                }
            }
        }
        catch (Exception ex)
        {
            if (id is not null) Reply(id, false, null, ex.Message);
        }
    }

    private void Reply(string? id, bool ok, string? packJson, string? error)
    {
        if (id is null || _web.CoreWebView2 is null) return;
        var payload = ok
            ? $"{{\"id\":{JsonSerializer.Serialize(id)},\"ok\":true,\"pack\":{packJson ?? "null"}}}"
            : $"{{\"id\":{JsonSerializer.Serialize(id)},\"ok\":false,\"error\":{JsonSerializer.Serialize(error ?? "抓取失败")}}}";
        _web.CoreWebView2.PostWebMessageAsJson(payload);
    }

    // ── 抓取 ────────────────────────────────────────────────────────────────

    private SchoolForm EnsureSchool()
    {
        if (_school is not null && !_school.IsDisposed) return _school;
        _school = new SchoolForm(_shell);
        return _school;
    }

    private Task<string> CaptureAsync(string? user, string? password, bool interactive) =>
        EnsureSchool().CaptureAsync(user, password, interactive);

    /// <summary>
    /// 静默刷新。优先用已经存下来的账号；没存账号就靠上次的会话 cookie 试一次
    /// （学校的登录态一般能撑好几天），过期了再把窗口摆出来让用户重新登。
    /// </summary>
    private async Task<string?> RefreshQuietlyAsync()
    {
        try
        {
            var stored = CredStore.Load();
            var json = await CaptureAsync(stored?.User, stored?.Password, interactive: false);
            await PushToPageAsync(json);
            return json;
        }
        catch (Exception ex)
        {
            _tray.ShowBalloonTip(5000, "仰山课表 · 自动更新没成功", ex.Message, ToolTipIcon.Warning);
            return null;
        }
    }

    /// <summary>
    /// 把抓到的原始数据交给内核。走的是内核自己的集成桥 YangShan.importRaw()，
    /// 与书签小工具、文件导入完全同一条路径 —— 解析规则只有一份。
    /// </summary>
    private async Task PushToPageAsync(string packJson)
    {
        if (_web.CoreWebView2 is null) return;
        var script =
            "(function(){ if (!globalThis.YangShan) return 'no-bridge';" +
            $" try {{ globalThis.YangShan.importRaw({packJson}, {{ preserveChanges: true }}); return 'ok'; }}" +
            " catch (e) { return 'error: ' + e.message; } })()";
        var result = await ShellRuntime.EvalAsync(_web, script);
        if (!result.Ok || result.Value != "ok")
        {
            _tray.ShowBalloonTip(5000, "仰山课表", "课表抓到了但没能交给页面：" + (result.Error ?? result.Value), ToolTipIcon.Warning);
        }
    }

    // ── 托盘与退出 ──────────────────────────────────────────────────────────

    private void RestoreFromTray()
    {
        Show();
        WindowState = FormWindowState.Normal;
        ShowInTaskbar = true;
        BringToFront();
        Activate();
    }

    private void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        // 关窗口 ≠ 退出：自动更新要留在托盘里继续跑。真要退出走托盘菜单。
        if (e.CloseReason != CloseReason.UserClosing) return;
        e.Cancel = true;
        Hide();
        ShowInTaskbar = false;
        if (!_balloonShown)
        {
            _balloonShown = true;
            _tray.ShowBalloonTip(4000, "仰山课表还在后台运行",
                "每小时会自动更新一次课表。要彻底退出，右键托盘图标选「退出」。", ToolTipIcon.Info);
        }
    }

    private void ExitApp()
    {
        _tray.Visible = false;
        _auto.Stop();
        _school?.Dispose();
        FormClosing -= OnFormClosing;
        Application.Exit();
    }

    private static void OpenExternal(string url)
    {
        try
        {
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        }
        catch
        {
        }
    }
}
