using System.Diagnostics;
using System.Runtime.InteropServices;

namespace WindowsHelper;

public sealed record EnvironmentTelemetryDto(
    string osVersion,
    string architecture,
    bool interactiveDesktop,
    string sessionStatus,
    string? sessionReason,
    string? displaySummary,
    int? dpi,
    string runtimeVersion,
    string backend
);

internal static class DesktopSessionProbe
{
    private const uint DesktopReadObjects = 0x0001;

    private static readonly HashSet<string> ProtectedSystemProcesses = new(StringComparer.OrdinalIgnoreCase)
    {
        "consent",
        "credentialuibroker",
        "lockapp",
        "logonui",
        "winlogon",
    };

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool CloseDesktop(IntPtr hDesktop);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    private static extern uint GetDpiForSystem();

    public static EnvironmentTelemetryDto Probe(string backendLabel)
    {
        var osVersion = Environment.OSVersion.VersionString;
        var arch = RuntimeInformation.OSArchitecture.ToString();
        var runtimeVer = $".NET {Environment.Version}";

        if (!OperatingSystem.IsWindows())
        {
            return new EnvironmentTelemetryDto(
                osVersion,
                arch,
                false,
                "BLOCKED_ENVIRONMENT",
                "Windows helper requires Windows OS.",
                null,
                null,
                runtimeVer,
                backendLabel
            );
        }

        if (!Environment.UserInteractive)
        {
            return new EnvironmentTelemetryDto(
                osVersion,
                arch,
                false,
                "BLOCKED_ENVIRONMENT",
                "Process is not running in an interactive Windows user session.",
                null,
                null,
                runtimeVer,
                backendLabel
            );
        }

        var desktopHandle = OpenInputDesktop(0, false, DesktopReadObjects);
        if (desktopHandle == IntPtr.Zero)
        {
            var err = Marshal.GetLastWin32Error();
            return new EnvironmentTelemetryDto(
                osVersion,
                arch,
                false,
                "BLOCKED_ENVIRONMENT",
                $"Interactive input desktop unavailable (Win32 error {err}); session may be locked or headless.",
                null,
                null,
                runtimeVer,
                backendLabel
            );
        }
        CloseDesktop(desktopHandle);

        var bounds = System.Windows.Forms.Screen.PrimaryScreen?.Bounds;
        var displaySummary = bounds is not null ? $"{bounds.Value.Width}x{bounds.Value.Height}" : "unknown";
        int? dpi = null;
        try
        {
            dpi = (int)GetDpiForSystem();
        }
        catch
        {
            dpi = 96;
        }

        return new EnvironmentTelemetryDto(
            osVersion,
            arch,
            true,
            "OK",
            null,
            displaySummary,
            dpi,
            runtimeVer,
            backendLabel
        );
    }

    public static bool IsForegroundBlockedOrUnrelated(int targetPid, out string? reason)
    {
        reason = null;
        var hwnd = GetForegroundWindow();
        if (hwnd == IntPtr.Zero)
        {
            reason = "No active foreground window";
            return true;
        }

        _ = GetWindowThreadProcessId(hwnd, out var fgPid);
        if (fgPid == 0)
        {
            reason = "Unable to determine foreground process ID";
            return true;
        }

        if ((int)fgPid == targetPid)
        {
            return false;
        }

        try
        {
            using var proc = Process.GetProcessById((int)fgPid);
            if (ProtectedSystemProcesses.Contains(proc.ProcessName))
            {
                reason = $"Protected system/UAC prompt in foreground ({proc.ProcessName}); interaction refused";
                return true;
            }
            reason = $"Unrelated application in foreground ({proc.ProcessName}, PID={fgPid})";
            return true;
        }
        catch
        {
            reason = $"Foreground window PID={fgPid} differs from target PID={targetPid}";
            return true;
        }
    }
}
