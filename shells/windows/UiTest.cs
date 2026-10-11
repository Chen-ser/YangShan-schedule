using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;

namespace YangShan;

/// <summary>
/// 界面自检：真的把窗口开起来、把内核加载出来，然后逐项核对
/// 「内核在不在、localStorage 有没有、注入的 YangShanShell 在不在、
///  内核里的 YangShan 桥在不在、postMessage 一来一回通不通」。
///
/// 存在的理由：壳是发给同学用的，光「编译通过」证明不了它能跑 ——
/// 而 GUI 程序又没法靠命令行看输出。所以给它一个能自己跑完并退出的模式。
/// 用法：YangShanShell.exe --uitest [--data &lt;目录&gt;] [--out &lt;文件&gt;] [--wait 毫秒]
/// </summary>
internal static class UiTest
{
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AttachConsole(uint processId);

    private const uint AttachParentProcess = 0xFFFFFFFF;

    private static int _exitCode = 1;

    public static int Run(string[] args)
    {
        AttachConsole(AttachParentProcess);
        try { Console.OutputEncoding = new UTF8Encoding(false); } catch { }
        ApplicationConfiguration.Initialize();

        var budgetMs = 45000;
        for (var i = 0; i < args.Length; i++)
        {
            if (args[i] == "--wait" && i + 1 < args.Length && int.TryParse(args[i + 1], out var w)) budgetMs = w;
        }

        var report = new StringBuilder();
        report.AppendLine("仰山课表 · Windows 壳 界面自检");
        report.AppendLine("时间：" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));
        report.AppendLine();

        void Line(string label, string value)
        {
            var text = label.PadRight(16) + value;
            report.AppendLine(text);
            Console.WriteLine(text);
        }

        MainForm form;
        ShellRuntime shell;
        try
        {
            shell = new ShellRuntime(args);
            form = new MainForm(shell);
        }
        catch (Exception ex)
        {
            Line("启动", "失败：" + ex.Message);
            Finish(report, args, 1);
            return 1;
        }

        Line("数据目录", shell.Root);
        Line("主页地址", shell.AppUrl ?? "（没有）");
        Line("内核来源", shell.AppHtmlNote ?? "（没有）");

        // 摆在屏幕里（不是屏幕外）：WebView2 在完全不可见的窗口上有时候不合成，
        // 就不用离屏位置，免得把「没渲染」误判成「初始化失败」。
        form.StartPosition = FormStartPosition.Manual;
        form.Location = new Point(60, 60);
        form.ClientSize = new Size(430, 900);

        form.Shown += async (_, _) =>
        {
            var ok = false;
            try
            {
                ok = await ProbeAsync(form, shell, Line, budgetMs);
            }
            catch (Exception ex)
            {
                report.AppendLine();
                report.AppendLine("探针异常：");
                report.AppendLine(ex.ToString());
            }

            var verdict = ok ? "结果：界面自检通过。" : "结果：界面自检没通过，见上面。";
            report.AppendLine();
            report.AppendLine(verdict);
            Console.WriteLine(verdict);

            Finish(report, args, ok ? 0 : 1);
            _exitCode = ok ? 0 : 1;
            Application.Exit();
        };

        Application.Run(form);
        return _exitCode;
    }

    private static async Task<bool> ProbeAsync(MainForm form, ShellRuntime shell, Action<string, string> line, int budgetMs)
    {
        var web = form.Web;
        var core = web.CoreWebView2;
        if (core is null)
        {
            // Load 里的 InitializeAsync 是 fire-and-forget，给它一点时间。
            for (var waited = 0; waited < 15000 && web.CoreWebView2 is null; waited += 250)
            {
                await Task.Delay(250);
            }
            core = web.CoreWebView2;
        }
        if (core is null)
        {
            line("WebView2", "没初始化出来");
            return false;
        }

        line("WebView2", CoreVersion(core));
        line("虚拟主机", shell.AppUrl is not null && shell.AppUrl.StartsWith($"https://{ShellRuntime.VirtualHost}/", StringComparison.OrdinalIgnoreCase)
            ? $"{ShellRuntime.VirtualHost} → {shell.AppFolder}"
            : "（没用虚拟主机）");

        // 等内核自己宣布准备好。内核在 documentElement.dataset.ready 里写 '1'。
        var ready = false;
        for (var waited = 0; waited < budgetMs; waited += 300)
        {
            var r = await ShellRuntime.EvalAsync(web, "document.documentElement.dataset.ready || ''");
            if (r.Ok && r.Value == "1") { ready = true; break; }
            await Task.Delay(300);
        }
        line("内核就绪", ready ? "是" : $"否（等了 {budgetMs} 毫秒）");

        var probe = await ShellRuntime.EvalAsync(web, """
            (function () {
              var box = {};
              box.url = location.href;
              box.title = document.title;
              box.ready = document.documentElement.dataset.ready || '';
              box.bridge = typeof globalThis.YangShan;
              box.bridgeVersion = (globalThis.YangShan || {}).version || '';
              box.shell = typeof globalThis.YangShanShell;
              box.shellName = (globalThis.YangShanShell || {}).name || '';
              box.tabs = document.querySelectorAll('.tab').length;
              try {
                localStorage.setItem('__ys_probe', '1');
                box.storage = localStorage.getItem('__ys_probe') === '1' ? 'ok' : 'bad';
                localStorage.removeItem('__ys_probe');
              } catch (e) { box.storage = 'error: ' + e.message; }
              box.text = (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 160);
              return JSON.stringify(box);
            })()
            """);

        if (!probe.Ok || probe.Value is null)
        {
            line("页面探针", "失败：" + (probe.Error ?? "（没有返回值）"));
            return false;
        }

        line("页面探针", probe.Value);

        var ok = true;
        void Check(string label, bool good, string detail)
        {
            line(label, (good ? "✔ " : "✘ ") + detail);
            if (!good) ok = false;
        }

        var bridgeOk = probe.Value.Contains("\"bridge\":\"object\"");
        var shellOk = probe.Value.Contains("\"shell\":\"object\"");
        var storageOk = probe.Value.Contains("\"storage\":\"ok\"");
        Check("内核桥", bridgeOk, bridgeOk ? "globalThis.YangShan 已就位" : "globalThis.YangShan 不见了");
        Check("壳接口", shellOk, shellOk ? "globalThis.YangShanShell 已注入" : "globalThis.YangShanShell 没注入进去");
        Check("本地存储", storageOk, storageOk ? "localStorage 可读可写（课表存得住）" : "localStorage 不可用，内核存不了课表");

        // 真正跑一次 postMessage 往返：status() 发消息给 C#，C# 回包，Promise 解开。
        var status = await ShellRuntime.EvalAsync(web,
            "globalThis.YangShanShell.status().then(function (s) { return typeof s === 'string' ? s : JSON.stringify(s); })");
        var statusOk = status.Ok && !string.IsNullOrWhiteSpace(status.Value) && status.Value!.Contains("windows");
        Check("壳往返通信", statusOk, statusOk ? status.Value! : "status() 没拿到回包：" + (status.Error ?? status.Value ?? "（空）"));

        // 内核往壳这边的一侧：YangShan.importRaw 必须是个函数。
        var importOk = await ShellRuntime.EvalAsync(web, "typeof (globalThis.YangShan || {}).importRaw");
        var good = importOk.Ok && importOk.Value == "function";
        Check("导入入口", good, good ? "YangShan.importRaw 可用" : "YangShan.importRaw 不是函数：" + (importOk.Error ?? importOk.Value));

        return ok && ready;
    }

    private static string CoreVersion(CoreWebView2 core)
    {
        try
        {
            return $"{core.Environment.BrowserVersionString}（内核 {typeof(CoreWebView2).Assembly.GetName().Version}）";
        }
        catch
        {
            return "已就绪";
        }
    }

    private static void Finish(StringBuilder report, string[] args, int code)
    {
        string? outFile = null;
        for (var i = 0; i < args.Length; i++)
        {
            if (args[i] == "--out" && i + 1 < args.Length) outFile = args[++i];
        }
        report.AppendLine();
        report.AppendLine("退出码：" + code);

        try
        {
            var path = outFile ?? Path.Combine(AppContext.BaseDirectory, "uitest.txt");
            File.WriteAllText(path, report.ToString(), new UTF8Encoding(false));
            Console.WriteLine("报告已写入：" + path);
        }
        catch
        {
        }
    }
}
