using System.Diagnostics;
using System.Drawing.Imaging;
using System.Text.Json;
using FlaUI.Core;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Capturing;
using FlaUI.Core.Conditions;
using FlaUI.Core.Definitions;
using FlaUI.Core.Exceptions;
using FlaUI.UIA2;
using FlaUI.UIA3;

namespace WindowsHelper;

public sealed record BoundsDto(double x, double y, double width, double height);

public sealed record RpcNodeDto(
    string key,
    string role,
    string name,
    string context,
    string? automationId,
    string? title,
    string? tooltip,
    string? value,
    BoundsDto? bounds,
    bool visible,
    bool enabled,
    bool interactive,
    IReadOnlyList<string> supportedActions,
    string identityConfidence,
    string driverRef,
    IReadOnlyList<RpcNodeDto> children
);

internal sealed class UiaEngine : IDisposable
{
    private readonly string _backend;
    private readonly AutomationBase _automation;
    private Application? _app;
    private Window? _mainWindow;
    private int _targetPid;
    private string _executablePath = string.Empty;
    private readonly Dictionary<string, AutomationElement> _sessionRefs = new();
    private int _refCounter;

    public UiaEngine(string backend)
    {
        _backend = string.Equals(backend, "uia2", StringComparison.OrdinalIgnoreCase) ? "uia2" : "uia3";
        _automation = _backend == "uia2" ? new UIA2Automation() : new UIA3Automation();
    }

    public string BackendLabel => $"flaui-{_backend}";

    public object AttachTarget(string entryPoint, string? processIdentity, string? startCommand)
    {
        Process? proc = null;

        if (!string.IsNullOrWhiteSpace(startCommand))
        {
            var psi = new ProcessStartInfo("cmd.exe", $"/c {startCommand}")
            {
                UseShellExecute = false,
                CreateNoWindow = false,
            };
            proc = Process.Start(psi);
        }
        else if (int.TryParse(entryPoint, out var parsedPid))
        {
            proc = Process.GetProcessById(parsedPid);
        }
        else if (File.Exists(entryPoint))
        {
            _app = Application.Launch(entryPoint);
            _targetPid = _app.ProcessId;
            proc = Process.GetProcessById(_targetPid);
        }
        else if (!string.IsNullOrWhiteSpace(processIdentity))
        {
            var baseName = Path.GetFileNameWithoutExtension(processIdentity);
            proc = Process.GetProcessesByName(baseName).FirstOrDefault();
        }

        if (_app is null && proc is not null)
        {
            _app = Application.Attach(proc.Id);
            _targetPid = proc.Id;
        }

        if (_app is null || proc is null)
        {
            return new
            {
                attached = false,
                processId = 0,
                executablePath = string.Empty,
                windowTitle = string.Empty,
                reason = $"Could not launch or attach target \"{entryPoint}\".",
            };
        }

        try
        {
            _executablePath = proc.MainModule?.FileName ?? proc.ProcessName;
        }
        catch
        {
            _executablePath = proc.ProcessName;
        }

        _mainWindow = _app.GetMainWindow(_automation, TimeSpan.FromSeconds(10));
        if (_mainWindow is null)
        {
            return new
            {
                attached = false,
                processId = _targetPid,
                executablePath = _executablePath,
                windowTitle = string.Empty,
                reason = "Target process has no accessible main window.",
            };
        }

        return new
        {
            attached = true,
            processId = _targetPid,
            executablePath = _executablePath,
            windowTitle = SafeGet(() => _mainWindow.Title) ?? string.Empty,
        };
    }

    public object Discover()
    {
        if (_app is null || _mainWindow is null)
        {
            throw new InvalidOperationException("Target application is not attached.");
        }

        _sessionRefs.Clear();
        var windowTitle = SafeGet(() => _mainWindow.Title) ?? "MainWindow";
        var nodes = new List<RpcNodeDto>();

        var windowsToInspect = new List<Window> { _mainWindow };
        try
        {
            var modal = _mainWindow.ModalWindows;
            if (modal is not null)
            {
                windowsToInspect.AddRange(modal);
            }
        }
        catch
        {
            // Ignore transient modal lookup failure
        }

        foreach (var win in windowsToInspect)
        {
            var winTitle = SafeGet(() => win.Title) ?? windowTitle;
            var descendants = win.FindAllDescendants();
            foreach (var el in descendants.Take(400))
            {
                var dto = MapElement(el, winTitle);
                if (dto is not null)
                {
                    nodes.Add(dto);
                }
            }
        }

        var stateHash = Convert.ToHexString(
            System.Security.Cryptography.SHA256.HashData(
                System.Text.Encoding.UTF8.GetBytes($"{windowTitle}:{nodes.Count}:{string.Join(",", nodes.Select(n => n.automationId ?? n.name))}")
            )
        ).Substring(0, 16).ToLowerInvariant();

        return new
        {
            location = windowTitle,
            stateHash,
            nodes,
            scrollLimitReached = false,
        };
    }

    public RpcNodeDto? ResolveNode(string? automationId, string role, string name, string context)
    {
        if (_mainWindow is null) return null;

        var condition = !string.IsNullOrWhiteSpace(automationId)
            ? _automation.ConditionFactory.ByAutomationId(automationId)
            : _automation.ConditionFactory.ByName(name);

        var matches = _mainWindow.FindAllDescendants(condition);
        var match = matches.FirstOrDefault(el =>
        {
            var ct = SafeGet(() => el.ControlType.ToString()) ?? string.Empty;
            var nm = SafeGet(() => el.Name) ?? string.Empty;
            return string.Equals(ct, role, StringComparison.OrdinalIgnoreCase) &&
                   (string.IsNullOrWhiteSpace(name) || string.Equals(nm, name, StringComparison.OrdinalIgnoreCase));
        });

        return match is null ? null : MapElement(match, context);
    }

    public object ExecuteAction(string driverRef, string? automationId, string role, string name, JsonElement actionJson)
    {
        if (DesktopSessionProbe.IsForegroundBlockedOrUnrelated(_targetPid, out var fgReason))
        {
            return new
            {
                attempted = false,
                succeeded = false,
                obscured = true,
                unstable = false,
                dispatchMayHaveHappened = false,
                foregroundProcessMismatch = true,
                unsupportedReason = fgReason,
                signals = Array.Empty<object>(),
            };
        }

        AutomationElement? element = null;
        if (_sessionRefs.TryGetValue(driverRef, out var cached))
        {
            element = cached;
        }
        else if (_mainWindow is not null && !string.IsNullOrWhiteSpace(automationId))
        {
            element = _mainWindow.FindFirstDescendant(_automation.ConditionFactory.ByAutomationId(automationId));
        }

        if (element is null)
        {
            return new
            {
                attempted = false,
                succeeded = false,
                obscured = false,
                unstable = true,
                dispatchMayHaveHappened = false,
                unsupportedReason = "unstable-control",
                signals = Array.Empty<object>(),
            };
        }

        var actionType = actionJson.GetProperty("type").GetString() ?? "invoke";
        var dispatchStarted = false;

        try
        {
            if (SafeGet(() => element.IsOffscreen.ToString()) == "True" || SafeGet(() => element.IsEnabled.ToString()) == "False")
            {
                return new
                {
                    attempted = false,
                    succeeded = false,
                    obscured = false,
                    unstable = true,
                    dispatchMayHaveHappened = false,
                    unsupportedReason = "unstable-control",
                    signals = Array.Empty<object>(),
                };
            }

            dispatchStarted = true;
            switch (actionType)
            {
                case "invoke":
                    if (element.Patterns.Invoke.IsSupported)
                    {
                        element.Patterns.Invoke.Pattern.Invoke();
                    }
                    else
                    {
                        return UnsupportedResult("InvokePattern not supported");
                    }
                    break;

                case "setValue":
                    if (element.Patterns.Value.IsSupported)
                    {
                        var val = actionJson.GetProperty("value").GetString() ?? string.Empty;
                        element.Patterns.Value.Pattern.SetValue(val);
                    }
                    else
                    {
                        return UnsupportedResult("ValuePattern not supported");
                    }
                    break;

                case "toggle":
                    if (element.Patterns.Toggle.IsSupported)
                    {
                        element.Patterns.Toggle.Pattern.Toggle();
                    }
                    else
                    {
                        return UnsupportedResult("TogglePattern not supported");
                    }
                    break;

                case "expand":
                    if (element.Patterns.ExpandCollapse.IsSupported)
                    {
                        element.Patterns.ExpandCollapse.Pattern.Expand();
                    }
                    else
                    {
                        return UnsupportedResult("ExpandCollapsePattern not supported");
                    }
                    break;

                case "collapse":
                    if (element.Patterns.ExpandCollapse.IsSupported)
                    {
                        element.Patterns.ExpandCollapse.Pattern.Collapse();
                    }
                    else
                    {
                        return UnsupportedResult("ExpandCollapsePattern not supported");
                    }
                    break;

                case "focus":
                    element.Focus();
                    break;

                default:
                    return UnsupportedResult($"Unsupported UIA action: {actionType}");
            }

            return new
            {
                attempted = true,
                succeeded = true,
                obscured = false,
                unstable = false,
                dispatchMayHaveHappened = true,
                signals = new[]
                {
                    new
                    {
                        kind = "accessibility-event",
                        detail = $"Executed UIA {actionType} on {role}:{name}",
                        inClickedSubtree = true,
                    },
                },
            };
        }
        catch (ElementNotAvailableException)
        {
            return new
            {
                attempted = dispatchStarted,
                succeeded = false,
                obscured = false,
                unstable = true,
                dispatchMayHaveHappened = dispatchStarted,
                unsupportedReason = "unstable-control",
                signals = Array.Empty<object>(),
            };
        }
    }

    public object? CaptureWindowScreenshot()
    {
        if (_mainWindow is null) return null;
        try
        {
            using var img = Capture.Element(_mainWindow);
            using var ms = new MemoryStream();
            img.Bitmap.Save(ms, ImageFormat.Png);
            return new { pngBase64 = Convert.ToBase64String(ms.ToArray()) };
        }
        catch
        {
            return null;
        }
    }

    private static object UnsupportedResult(string reason) => new
    {
        attempted = false,
        succeeded = false,
        obscured = false,
        unstable = false,
        dispatchMayHaveHappened = false,
        unsupportedReason = reason,
        signals = Array.Empty<object>(),
    };

    private RpcNodeDto? MapElement(AutomationElement el, string context)
    {
        try
        {
            var ct = el.ControlType;
            var interactive = ct is ControlType.Button or ControlType.Edit or ControlType.CheckBox
                or ControlType.ComboBox or ControlType.MenuItem or ControlType.TabItem
                or ControlType.Hyperlink or ControlType.ListItem or ControlType.RadioButton;

            if (!interactive)
            {
                return null;
            }

            var autoId = SafeGet(() => el.AutomationId);
            var name = SafeGet(() => el.Name) ?? string.Empty;
            var enabled = el.IsEnabled;
            var offscreen = el.IsOffscreen;
            var rect = el.BoundingRectangle;
            var bounds = rect.Width > 0 && rect.Height > 0
                ? new BoundsDto(rect.X, rect.Y, rect.Width, rect.Height)
                : null;

            var actions = new List<string>();
            if (el.Patterns.Invoke.IsSupported) actions.Add("invoke");
            if (el.Patterns.Value.IsSupported) actions.Add("setValue");
            if (el.Patterns.Toggle.IsSupported) actions.Add("toggle");
            if (el.Patterns.SelectionItem.IsSupported) actions.Add("select");
            if (el.Patterns.ExpandCollapse.IsSupported)
            {
                actions.Add("expand");
                actions.Add("collapse");
            }
            actions.Add("focus");

            var confidence = !string.IsNullOrWhiteSpace(autoId)
                ? "HIGH"
                : !string.IsNullOrWhiteSpace(name)
                    ? "MEDIUM"
                    : "LOW";

            var refId = $"uia_ref_{++_refCounter}";
            _sessionRefs[refId] = el;

            return new RpcNodeDto(
                key: refId,
                role: ct.ToString(),
                name: name,
                context: context,
                automationId: string.IsNullOrWhiteSpace(autoId) ? null : autoId,
                title: name,
                tooltip: SafeGet(() => el.Properties.HelpText.ValueOrDefault),
                value: el.Patterns.Value.IsSupported ? SafeGet(() => el.Patterns.Value.Pattern.Value.ValueOrDefault) : null,
                bounds: bounds,
                visible: !offscreen,
                enabled: enabled,
                interactive: true,
                supportedActions: actions,
                identityConfidence: confidence,
                driverRef: refId,
                children: Array.Empty<RpcNodeDto>()
            );
        }
        catch
        {
            return null;
        }
    }

    private static string? SafeGet(Func<string?> getter)
    {
        try
        {
            return getter();
        }
        catch
        {
            return null;
        }
    }

    public void Dispose()
    {
        _sessionRefs.Clear();
        _automation.Dispose();
        _app?.Dispose();
    }
}
