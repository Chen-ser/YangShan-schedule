using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace YangShan;

/// <summary>一次 JS 求值的结果。Ok 为假时 Error 里是页面抛出的原文，够用来排查。</summary>
internal readonly record struct EvalResult(bool Ok, string? Value, string? Error)
{
    public static EvalResult Fail(string why) => new(false, null, why);
}

/// <summary>壳的设置。密码**不在**这里，它在 Windows 凭据管理器里。</summary>
internal sealed class Settings
{
    public string? AppUrl { get; set; }
    public bool AutoRefreshEnabled { get; set; } = true;
    public int AutoRefreshMinutes { get; set; } = 60;
    public bool RememberPassword { get; set; }
    public string? Username { get; set; }
}

/// <summary>
/// 壳的全部非界面逻辑：设置读写、内核文件落盘、WebView2 环境、JS 求值、凭据。
/// </summary>
internal sealed class ShellRuntime : IDisposable
{
    public const string SchoolHost = "jwxt.bistu.edu.cn";
    public const string SchoolEntry = "https://jwxt.bistu.edu.cn/jwapp/sys/kbapp/*default/index.do";
    public const string SsoHost = "sso.bistu.edu.cn";
    public const string VirtualHost = "yangshan.local";

    /// <summary>
    /// 默认托管地址。只在「没内嵌内核、本地也没有 dist」时才会用到 ——
    /// 正常路径是内嵌的 /app.html，离线可用；这个地址是最后的退路。
    /// 仓库：https://github.com/Chen-ser/yangshan-schedule
    /// </summary>
    public const string HostedUrl = "https://chen-ser.github.io/yangshan-schedule/";

    private static readonly JsonSerializerOptions Json = new() { WriteIndented = true };

    public string Root { get; }
    public Settings Settings { get; private set; }
    public CoreWebView2Environment? WebViewEnv { get; private set; }
    public string? CaptureScript { get; }

    /// <summary>注入给内核的壳接口（shells/shim.js），与安卓壳共用同一份源码。</summary>
    public string? ShimScript { get; }
    public string AppFolder { get; }
    public string? AppUrl { get; private set; }
    public string? StartupNote { get; private set; }
    public string DataRootNote { get; private set; } = "";
    public string? AppHtmlNote { get; private set; }

    private readonly string? _cliApp;

    public ShellRuntime(string[] args)
    {
        string? cliData = null;
        for (var i = 0; i < args.Length; i++)
        {
            if (args[i] is "--url" or "--app" && i + 1 < args.Length) _cliApp = args[++i];
            if (args[i] == "--data" && i + 1 < args.Length) cliData = args[++i];
        }

        (Root, DataRootNote) = ResolveDataRoot(cliData);
        AppFolder = Path.Combine(Root, "app");
        Directory.CreateDirectory(AppFolder);

        Settings = LoadSettings();
        CaptureScript = ReadResource(".js", "capture.js");
        ShimScript = ReadResource(".js", "shim.js");
        AppUrl = ResolveAppUrl();
    }

    /// <summary>
    /// 数据目录。首选 %LOCALAPPDATA%，但受限环境（沙箱、只读漫游配置、公用电脑）下可能不给写 ——
    /// 那就依次退到临时目录、exe 同级目录。**绝不因为一个目录不可写就崩在启动画面。**
    /// </summary>
    private static (string Root, string Note) ResolveDataRoot(string? cliData)
    {
        var candidates = new List<(string Path, string Label)>();
        if (!string.IsNullOrWhiteSpace(cliData)) candidates.Add((cliData!, "命令行 --data"));

        var local = System.Environment.GetFolderPath(System.Environment.SpecialFolder.LocalApplicationData);
        if (!string.IsNullOrWhiteSpace(local)) candidates.Add((Path.Combine(local, "YangShanSchedule"), "本地应用数据目录"));

        var temp = Path.GetTempPath();
        if (!string.IsNullOrWhiteSpace(temp)) candidates.Add((Path.Combine(temp, "YangShanSchedule"), "临时目录"));

        candidates.Add((Path.Combine(AppContext.BaseDirectory, "data"), "程序同级目录"));

        var blocked = new List<string>();
        foreach (var (path, label) in candidates)
        {
            if (TryUse(path, out _))
            {
                return blocked.Count == 0 ? (path, label) : (path, $"{label}（{string.Join("、", blocked)}写不进去）");
            }
            blocked.Add(label);
        }
        throw new IOException("找不到可以写入的数据目录，试过：" + string.Join("、", blocked));
    }

    private static bool TryUse(string dir, out string? error)
    {
        try
        {
            Directory.CreateDirectory(dir);
            var probe = Path.Combine(dir, ".probe");
            File.WriteAllText(probe, "ok");
            File.Delete(probe);
            error = null;
            return true;
        }
        catch (Exception ex)
        {
            error = ex.Message;
            return false;
        }
    }

    // ── 设置 ────────────────────────────────────────────────────────────────

    private string SettingsPath => Path.Combine(Root, "settings.json");

    private Settings LoadSettings()
    {
        try
        {
            if (File.Exists(SettingsPath))
            {
                return JsonSerializer.Deserialize<Settings>(File.ReadAllText(SettingsPath, Encoding.UTF8))
                       ?? new Settings();
            }
        }
        catch
        {
            // 坏了就用默认值，不要因为一个配置文件把软件卡在启动画面。
        }
        return new Settings();
    }

    public void SaveSettings()
    {
        try
        {
            File.WriteAllText(SettingsPath, JsonSerializer.Serialize(Settings, Json), Encoding.UTF8);
        }
        catch
        {
        }
    }

    // ── 内核 ────────────────────────────────────────────────────────────────

    /// <summary>
    /// 内核是一个自包含的单文件 HTML。优先用打进 exe 的那份（放在 EmbeddedResource app.html），
    /// 没有就去 exe 同级目录和仓库的 dist/ 里找 —— 这样开发者只改网页时不用重新编 C#。
    /// 解出来的文件放在 app/index.html，再由虚拟主机映射托成 https://yangshan.local/index.html。
    /// </summary>
    private string? ResolveAppUrl()
    {
        if (!string.IsNullOrWhiteSpace(_cliApp))
        {
            if (_cliApp!.StartsWith("http", StringComparison.OrdinalIgnoreCase)) return _cliApp;
            if (File.Exists(_cliApp))
            {
                File.Copy(_cliApp, Path.Combine(AppFolder, "index.html"), true);
                return $"https://{VirtualHost}/index.html";
            }
        }

        var embedded = ReadResource(".html", "app.html");
        if (embedded is not null)
        {
            var target = Path.Combine(AppFolder, "index.html");
            var bytes = Encoding.UTF8.GetBytes(embedded);
            if (!File.Exists(target) || new FileInfo(target).Length != bytes.Length)
            {
                File.WriteAllBytes(target, bytes);
            }
            AppHtmlNote = $"exe 内嵌（{bytes.Length:N0} 字节）";
            return $"https://{VirtualHost}/index.html";
        }

        foreach (var candidate in LocalAppCandidates())
        {
            if (!File.Exists(candidate)) continue;
            File.Copy(candidate, Path.Combine(AppFolder, "index.html"), true);
            AppHtmlNote = $"仓库文件 {candidate}（{new FileInfo(candidate).Length:N0} 字节）";
            StartupNote = "用的是仓库里的内核文件，没有内嵌版本。";
            return $"https://{VirtualHost}/index.html";
        }

        StartupNote = "exe 里没有内嵌课表内核，本地也没找到 dist/仰山课表.html，先用在线版启动。";
        return string.IsNullOrWhiteSpace(Settings.AppUrl) ? HostedUrl : Settings.AppUrl;
    }

    private IEnumerable<string> LocalAppCandidates()
    {
        var exeDir = AppContext.BaseDirectory;
        yield return Path.Combine(exeDir, "yangshan.html");
        yield return Path.Combine(exeDir, "app.html");

        // 从 exe 目录往上找仓库：bin/Release/net10.0-windows → shells/windows → shells → 仓库根
        var dir = new DirectoryInfo(exeDir);
        for (var depth = 0; depth < 8 && dir is not null; depth++, dir = dir.Parent)
        {
            yield return Path.Combine(dir.FullName, "dist", "仰山课表.html");
            yield return Path.Combine(dir.FullName, "yangshan-schedule.html");
        }
    }

    private static string? ReadResource(string suffix, string contains)
    {
        try
        {
            var asm = Assembly.GetExecutingAssembly();
            var name = asm.GetManifestResourceNames()
                .FirstOrDefault(n => n.EndsWith(suffix, StringComparison.OrdinalIgnoreCase)
                                     && n.Contains(contains, StringComparison.OrdinalIgnoreCase));
            if (name is null) return null;
            using var stream = asm.GetManifestResourceStream(name);
            if (stream is null) return null;
            using var reader = new StreamReader(stream, Encoding.UTF8);
            return reader.ReadToEnd();
        }
        catch
        {
            return null;
        }
    }

    // ── WebView2 ────────────────────────────────────────────────────────────

    /// <summary>
    /// 整个进程**只有一个** CoreWebView2Environment：主窗口和教务窗口共用它，
    /// 这样两边的登录状态是同一份 cookie，不需要在壳里搬 cookie。
    /// </summary>
    public async Task<CoreWebView2Environment> EnsureEnvironmentAsync()
    {
        if (WebViewEnv is not null) return WebViewEnv;

        var options = new CoreWebView2EnvironmentOptions(
            "--disable-features=msWebOOUI,msPdfOOUI --autoplay-policy=no-user-gesture-required");
        var dataDir = Path.Combine(Root, "wv2");
        Directory.CreateDirectory(dataDir);
        WebViewEnv = await CoreWebView2Environment.CreateAsync(null, dataDir, options);
        return WebViewEnv;
    }

    /// <summary>
    /// ExecuteScriptAsync **不会等待 Promise**（返回 {}），所以要拿异步结果必须走 CDP 的
    /// Runtime.evaluate + awaitPromise。顺带还能拿到页面抛出的异常原文。
    /// </summary>
    public static async Task<EvalResult> EvalAsync(WebView2 web, string expression)
    {
        var core = web.CoreWebView2;
        if (core is null) return EvalResult.Fail("WebView 还没准备好");
        var args = JsonSerializer.Serialize(new { expression, awaitPromise = true, returnByValue = true });
        string raw;
        try
        {
            raw = await core.CallDevToolsProtocolMethodAsync("Runtime.evaluate", args);
        }
        catch (Exception ex)
        {
            return EvalResult.Fail(ex.Message);
        }

        try
        {
            using var doc = JsonDocument.Parse(raw);
            var root = doc.RootElement;
            if (root.TryGetProperty("exceptionDetails", out var exDetails))
            {
                return EvalResult.Fail(DescribeException(exDetails));
            }
            if (!root.TryGetProperty("result", out var result)) return EvalResult.Fail("页面没有返回值");
            if (!result.TryGetProperty("value", out var value)) return EvalResult.Fail("页面没有返回值");
            return new EvalResult(true,
                value.ValueKind == JsonValueKind.String ? value.GetString() : value.GetRawText(), null);
        }
        catch (Exception ex)
        {
            return EvalResult.Fail(ex.Message);
        }
    }

    private static string DescribeException(JsonElement details)
    {
        if (details.TryGetProperty("exception", out var exception)
            && exception.TryGetProperty("description", out var description)
            && description.ValueKind == JsonValueKind.String)
        {
            return description.GetString()!;
        }
        if (details.TryGetProperty("text", out var text) && text.ValueKind == JsonValueKind.String)
        {
            return text.GetString()!;
        }
        return "页面脚本出错";
    }

    public void Dispose()
    {
        WebViewEnv = null;
    }
}

/// <summary>
/// 账号密码的保管箱。用的是 Windows 自己的凭据管理器（控制面板 → 凭据管理器 → Windows 凭据，
/// 名字叫 YangShanSchedule/bistu），所以：不进任何项目文件、用户随时能自己删掉。
/// </summary>
internal static class CredStore
{
    private const string Target = "YangShanSchedule/bistu";
    private const uint CredTypeGeneric = 1;
    private const uint CredPersistLocalMachine = 2;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential
    {
        public uint Flags;
        public uint Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWriteW(ref Credential credential, uint flags);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredDeleteW(string target, uint type, uint flags);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern void CredFree(IntPtr buffer);

    public static bool Save(string username, string password)
    {
        var blob = Encoding.Unicode.GetBytes(password);
        var handle = GCHandle.Alloc(blob, GCHandleType.Pinned);
        try
        {
            var credential = new Credential
            {
                Type = CredTypeGeneric,
                TargetName = Target,
                Comment = "仰山课表·自动刷新用",
                CredentialBlobSize = (uint)blob.Length,
                CredentialBlob = handle.AddrOfPinnedObject(),
                Persist = CredPersistLocalMachine,
                UserName = username,
            };
            return CredWriteW(ref credential, 0);
        }
        catch
        {
            return false;
        }
        finally
        {
            handle.Free();
        }
    }

    public static (string User, string Password)? Load()
    {
        if (!CredReadW(Target, CredTypeGeneric, 0, out var pointer) || pointer == IntPtr.Zero) return null;
        try
        {
            var credential = Marshal.PtrToStructure<Credential>(pointer);
            var password = "";
            if (credential.CredentialBlobSize > 0 && credential.CredentialBlob != IntPtr.Zero)
            {
                var bytes = new byte[credential.CredentialBlobSize];
                Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);
                password = Encoding.Unicode.GetString(bytes);
            }
            return (credential.UserName ?? "", password);
        }
        catch
        {
            return null;
        }
        finally
        {
            CredFree(pointer);
        }
    }

    public static void Forget()
    {
        try
        {
            CredDeleteW(Target, CredTypeGeneric, 0);
        }
        catch
        {
        }
    }
}
