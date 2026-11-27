using System.Text;
using System.Text.Json;

namespace WindowsHelper;

internal static class Program
{
    private const int MaxFrameBytes = 1024 * 1024;
    private const string ProtocolVersion = "1.0.0";

    private static int Main(string[] args)
    {
        var backendArg = "uia3";
        var idx = Array.IndexOf(args, "--backend");
        if (idx >= 0 && idx + 1 < args.Length)
        {
            backendArg = args[idx + 1];
        }

        using var engine = new UiaEngine(backendArg);

        string? line;
        while ((line = Console.In.ReadLine()) is not null)
        {
            if (Encoding.UTF8.GetByteCount(line) > MaxFrameBytes)
            {
                WriteError(null, -32600, "Frame exceeds 1 MiB limit");
                continue;
            }

            JsonDocument doc;
            try
            {
                doc = JsonDocument.Parse(line);
            }
            catch
            {
                WriteError(null, -32700, "Parse error");
                continue;
            }

            using (doc)
            {
                var root = doc.RootElement;
                JsonElement? id = root.TryGetProperty("id", out var idEl) ? idEl.Clone() : null;
                var method = root.TryGetProperty("method", out var mEl) ? mEl.GetString() : null;
                var hasParams = root.TryGetProperty("params", out var pEl);

                if (method == "$/cancelRequest")
                {
                    continue;
                }

                try
                {
                    switch (method)
                    {
                        case "initialize":
                            var env = DesktopSessionProbe.Probe(engine.BackendLabel);
                            WriteResult(id, new
                            {
                                protocolVersion = ProtocolVersion,
                                helperName = "dp-crawler-windows-helper",
                                helperVersion = "0.1.0",
                                capabilities = new
                                {
                                    discovery = true,
                                    invoke = true,
                                    setValue = true,
                                    toggle = true,
                                    select = true,
                                    expand = true,
                                    collapse = true,
                                    focus = true,
                                    keyboard = false,
                                    pointer = false,
                                    scrolling = true,
                                    screenshots = env.interactiveDesktop,
                                    accessibilityEvents = true,
                                    stateRestore = false,
                                },
                                environment = env,
                            });
                            break;

                        case "ping":
                            WriteResult(id, new { ok = true });
                            break;

                        case "attachTarget":
                            if (!hasParams)
                            {
                                WriteError(id, -32602, "Missing params");
                                break;
                            }
                            var entryPoint = pEl.GetProperty("entryPoint").GetString() ?? string.Empty;
                            var procId = pEl.TryGetProperty("processIdentity", out var pi) ? pi.GetString() : null;
                            var startCmd = pEl.TryGetProperty("startCommand", out var sc) ? sc.GetString() : null;
                            WriteResult(id, engine.AttachTarget(entryPoint, procId, startCmd));
                            break;

                        case "discover":
                            WriteResult(id, engine.Discover());
                            break;

                        case "resolveNode":
                            if (!hasParams)
                            {
                                WriteError(id, -32602, "Missing params");
                                break;
                            }
                            var autoId = pEl.TryGetProperty("automationId", out var ai) ? ai.GetString() : null;
                            var role = pEl.GetProperty("role").GetString() ?? string.Empty;
                            var name = pEl.GetProperty("name").GetString() ?? string.Empty;
                            var ctx = pEl.GetProperty("context").GetString() ?? string.Empty;
                            WriteResult(id, engine.ResolveNode(autoId, role, name, ctx));
                            break;

                        case "executeAction":
                            if (!hasParams)
                            {
                                WriteError(id, -32602, "Missing params");
                                break;
                            }
                            var dRef = pEl.GetProperty("driverRef").GetString() ?? string.Empty;
                            var eAutoId = pEl.TryGetProperty("automationId", out var eai) ? eai.GetString() : null;
                            var eRole = pEl.GetProperty("role").GetString() ?? string.Empty;
                            var eName = pEl.GetProperty("name").GetString() ?? string.Empty;
                            var action = pEl.GetProperty("action");
                            WriteResult(id, engine.ExecuteAction(dRef, eAutoId, eRole, eName, action));
                            break;

                        case "captureScreenshot":
                            WriteResult(id, engine.CaptureWindowScreenshot());
                            break;

                        case "restoreState":
                            WriteResult(id, new { ok = false, reason = "Desktop stateRestore requires configured restart command" });
                            break;

                        case "shutdown":
                            WriteResult(id, new { shuttingDown = true });
                            return 0;

                        default:
                            WriteError(id, -32601, $"Method not found: {method}");
                            break;
                    }
                }
                catch (Exception ex)
                {
                    WriteError(id, -32000, ex.Message);
                }
            }
        }

        return 0;
    }

    private static void WriteResult(JsonElement? id, object? result)
    {
        var payload = JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            id = id,
            result,
        });
        Console.Out.WriteLine(payload);
        Console.Out.Flush();
    }

    private static void WriteError(JsonElement? id, int code, string message)
    {
        var payload = JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            id = id,
            error = new { code, message },
        });
        Console.Out.WriteLine(payload);
        Console.Out.Flush();
    }
}
