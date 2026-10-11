using System.Runtime.InteropServices;
using System.Text;

namespace YangShan;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (Array.IndexOf(args, "--selfcheck") >= 0)
        {
            return SelfCheck.Run(args);
        }

        if (Array.IndexOf(args, "--uitest") >= 0)
        {
            return UiTest.Run(args);
        }

        ApplicationConfiguration.Initialize();

        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
            WriteCrashLog(e.ExceptionObject as Exception ?? new Exception("未知错误"));

        try
        {
            using var shell = new ShellRuntime(args);
            Application.Run(new MainForm(shell));
            return 0;
        }
        catch (Exception ex)
        {
            WriteCrashLog(ex);
            MessageBox.Show(
                "仰山课表启动失败：\r\n\r\n" + ex.Message + "\r\n\r\n详细信息写在程序目录的 crash.log 里。",
                "仰山课表", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    /// <summary>
    /// 崩了也要留下痕迹 —— 客户端是发给同学用的，没有日志就只能靠猜。
    /// 写在 exe 同级目录（那里一定有写权限，否则程序都装不下）。
    /// </summary>
    internal static void WriteCrashLog(Exception ex)
    {
        try
        {
            var path = Path.Combine(AppContext.BaseDirectory, "crash.log");
            var text = new StringBuilder()
                .AppendLine("时间：" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"))
                .AppendLine("版本：" + typeof(Program).Assembly.GetName().Version)
                .AppendLine("系统：" + Environment.OSVersion.VersionString)
                .AppendLine(".NET：" + Environment.Version)
                .AppendLine()
                .AppendLine(ex.ToString())
                .ToString();
            File.AppendAllText(path, text + Environment.NewLine + new string('-', 60) + Environment.NewLine, Encoding.UTF8);
        }
        catch
        {
        }
    }
}

/// <summary>
/// 自检：不打开任何界面，把「内核有没有打进去、WebView2 在不在、数据目录能不能写」
/// 直接写进文件并打印出来。给用户排查、也给我自己在无头环境里验证用。
/// 用法：YangShanShell.exe --selfcheck [--data &lt;目录&gt;] [--out &lt;文件&gt;]
/// </summary>
internal static class SelfCheck
{
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AttachConsole(uint processId);

    private const uint AttachParentProcess = 0xFFFFFFFF;

    public static int Run(string[] args)
    {
        AttachConsole(AttachParentProcess);
        try { Console.OutputEncoding = new UTF8Encoding(false); } catch { }

        string? dataDir = null, outFile = null;
        for (var i = 0; i < args.Length; i++)
        {
            if (args[i] == "--data" && i + 1 < args.Length) dataDir = args[++i];
            if (args[i] == "--out" && i + 1 < args.Length) outFile = args[++i];
        }

        var report = new StringBuilder();
        var ok = true;

        void Line(string label, string value)
        {
            var text = label.PadRight(16) + value;
            report.AppendLine(text);
            Console.WriteLine(text);
        }

        report.AppendLine("仰山课表 · Windows 壳 自检");
        report.AppendLine("时间：" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));
        report.AppendLine();

        try
        {
            using var shell = new ShellRuntime(args);
            Line("数据目录", shell.Root);
            Line("目录来源", shell.DataRootNote);
            Line("内核来源", shell.AppHtmlNote ?? "（没有）");
            Line("抓取内核", shell.CaptureScript is null ? "（没有）" : $"{shell.CaptureScript.Length:N0} 字符");
            Line("壳接口", shell.ShimScript is null ? "（没有）" : $"{shell.ShimScript.Length:N0} 字符");
            Line("主页地址", shell.AppUrl ?? "（没有）");
            if (!string.IsNullOrEmpty(shell.StartupNote)) Line("备注", shell.StartupNote!);

            try
            {
                var version = Microsoft.Web.WebView2.Core.CoreWebView2Environment.GetAvailableBrowserVersionString();
                Line("WebView2", string.IsNullOrWhiteSpace(version) ? "（没装运行时）" : version);
                if (string.IsNullOrWhiteSpace(version)) ok = false;
            }
            catch (Exception ex)
            {
                Line("WebView2", "（读不到：" + ex.Message + "）");
                ok = false;
            }

            var stored = CredStore.Load();
            Line("记住的账号", stored is null ? "没有" : stored.Value.User + "（密码在 Windows 凭据管理器里）");
            Line("自动刷新", shell.Settings.AutoRefreshEnabled ? $"每 {shell.Settings.AutoRefreshMinutes} 分钟" : "关闭");

            if (shell.CaptureScript is null)
            {
                report.AppendLine();
                report.AppendLine("问题：capture.js 没有作为资源打进 exe。");
                ok = false;
            }
            if (shell.ShimScript is null)
            {
                report.AppendLine();
                report.AppendLine("问题：shim.js 没有作为资源打进 exe，内核会拿不到壳接口。");
                ok = false;
            }
            if (shell.AppHtmlNote is null && (shell.AppUrl?.StartsWith("https://yangshan.local", StringComparison.OrdinalIgnoreCase) ?? false))
            {
                report.AppendLine();
                report.AppendLine("问题：主页指向虚拟主机，但内核文件没落地。");
                ok = false;
            }
        }
        catch (Exception ex)
        {
            Line("启动", "失败：" + ex.Message);
            report.AppendLine();
            report.AppendLine(ex.ToString());
            ok = false;
        }

        report.AppendLine();
        var verdict = ok ? "结果：全部正常。" : "结果：有问题，见上面。";
        report.AppendLine(verdict);
        Console.WriteLine(verdict);

        try
        {
            var path = outFile ?? Path.Combine(AppContext.BaseDirectory, "selfcheck.txt");
            File.WriteAllText(path, report.ToString(), new UTF8Encoding(false));
            Console.WriteLine("报告已写入：" + path);
        }
        catch
        {
        }

        return ok ? 0 : 1;
    }
}
