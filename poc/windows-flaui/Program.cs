using System.Diagnostics;
using System.Text.Json;
using FlaUI.Core;
using FlaUI.Core.AutomationElements;
using FlaUI.UIA2;
using FlaUI.UIA3;

internal static class Program
{
    private static int Main(string[] args)
    {
        if (!OperatingSystem.IsWindows())
        {
            Console.Error.WriteLine("WindowsHelperPoc requires a Windows OS runtime.");
            return 2;
        }

        var useUia2 = args.Contains("--uia2");
        var targetPid = ParsePid(args);
        if (targetPid is null)
        {
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                ok = true,
                mode = useUia2 ? "UIA2" : "UIA3",
                message = "Compiled and started on Windows. Pass --pid <pid> to inspect a scoped target process."
            }));
            return 0;
        }

        using AutomationBase automation = useUia2 ? new UIA2Automation() : new UIA3Automation();
        using var app = Application.Attach(targetPid.Value);
        var window = app.GetMainWindow(automation, TimeSpan.FromSeconds(5));
        if (window is null)
        {
            Console.WriteLine(JsonSerializer.Serialize(new { ok = false, error = "Main window not found for target PID" }));
            return 1;
        }

        var descendants = window.FindAllDescendants()
            .Take(20)
            .Select(el => new
            {
                automationId = SafeGet(() => el.AutomationId),
                name = SafeGet(() => el.Name),
                controlType = SafeGet(() => el.ControlType.ToString()),
                isEnabled = SafeGet(() => el.IsEnabled.ToString())
            })
            .ToArray();

        Console.WriteLine(JsonSerializer.Serialize(new
        {
            ok = true,
            mode = useUia2 ? "UIA2" : "UIA3",
            processId = targetPid.Value,
            windowTitle = SafeGet(() => window.Title),
            sampleCount = descendants.Length,
            samples = descendants
        }, new JsonSerializerOptions { WriteIndented = true }));

        return 0;
    }

    private static int? ParsePid(string[] args)
    {
        var idx = Array.IndexOf(args, "--pid");
        if (idx >= 0 && idx + 1 < args.Length && int.TryParse(args[idx + 1], out var pid))
        {
            return pid;
        }
        return null;
    }

    private static string SafeGet(Func<string?> getter)
    {
        try
        {
            return getter() ?? string.Empty;
        }
        catch
        {
            return string.Empty;
        }
    }
}
