# Phase 0 Architecture Validation Report

**Date:** 2026-11-27  
**Primary Host:** macOS 26.7.3 (`arm64`)  
**Node.js:** `v24.15.0` | **Corepack:** `0.34.6` | **.NET SDK:** `8.0.130` | **Swift (CLT):** `6.3.3` | **Java:** Eclipse Temurin `21.0.13.1` LTS (plus OpenJDK `26.0.1` & JBR `25.0.2`)

> This report records actual runtime evidence, blockers, limitations, dependency/licence review, and the proposed release sequence from Phase 0 throwaway PoCs in `poc/`. No capability is marked `PROVEN` without actual runtime execution.

---

## 1. Feasibility Matrix

Status definitions:
- `PROVEN`: Actual runtime PoC successfully executed end-to-end.
- `PARTIALLY_PROVEN`: Some capabilities verified at runtime, but critical gaps or environment gates remain.
- `UNPROVEN`: No successful runtime validation executed yet.
- `UNSUPPORTED`: Tested and confirmed unsupported for the intended integration.

| Platform / Technology | Status | PoC Location | Evidence Summary | Key Blockers / Gaps |
|---|---|---|---|---|
| **Web (Playwright Chromium)** | `PROVEN` | `poc/web-cdp/run.mjs` | Launched Chromium `159.0.8154.6`, discovered 3 elements, clicked safe control, captured `sessionStorage`, blocked `GET /api/delete` via `page.route()` (`serverMutatingCalls: 0`). | Sandbox blocks loopback sockets; live browser runs require network/loopback access outside strict sandbox. |
| **JSON-RPC stdio Helper Transport** | `PROVEN` | `poc/rpc-proto/run.mjs` | Verified `initialize` capability negotiation, request IDs, timeout (`80ms`), `$/cancelRequest`, graceful `shutdown`, and unexpected crash detection (`code=42`). | Native helper integration over this transport still needs live wiring per OS helper in Phases 3/5. |
| **macOS Native (`AXUIElement`)** | `PROVEN` | `poc/macos-ax/run-fixture-test.sh` | With Accessibility permission granted (`trusted: true`), `ax-probe` scoped to `fixture-app` (`windowCount: 1`), read roles/titles/identifiers/bounds/enabled/actions, invoked `AXPress` (`pressStatus: 0`), and observed `native-status` update to `"clicked"` (`FIXTURE_CLICKED`). | Requires manual Accessibility permission grant and unlocked interactive desktop session. |
| **Java Swing (macOS, Temurin 21 LTS)** | `PROVEN` | `poc/java-a11y/run-swing-ax-test.sh` | Built & launched Swing `JFrame` on Temurin `21.0.13.1+2-LTS`; external macOS `ax-probe` discovered `AXWindow` & `AXButton` (`Safe Swing Action`), invoked `AXPress` (`pressStatus: 0`), and verified `SWING_BUTTON_CLICKED` + label `"clicked"`. | Also tested on OpenJDK `26.0.1` and JBR `25.0.2`. Windows Java Access Bridge remains separate and `UNPROVEN`. |
| **Electron CDP & IPC Boundary** | `PARTIALLY_PROVEN` | `poc/electron-cdp/run.mjs` | Launched real `electron@35.0.0`, attached via `chromium.connectOverCDP(wsEndpoint)`, clicked renderer DOM button (`rendererOut: "renderer-clicked"`), and verified `ipcRenderer.invoke()` bypassed `page.route()` (`ipcBypassedPlaywrightRouteGuard: true`, `blockedHttpCount: 0`). | Renderer CDP & IPC bypass are `PROVEN`; native OS menu/dialog inspection via `AXUIElement` on a visible Electron window remains to be verified in Phase 4. |
| **Tauri on macOS (`AXUIElement` / WKWebView)** | `PARTIALLY_PROVEN` | `poc/macos-ax/run-webkit-test.sh` | Tested embedded `WKWebView` AppKit fixture (`windowCount: 1`, `trusted: true`). `ax-probe` discovered outer `AXWindow` and chrome, but the inner `WKWebView` container appeared as an opaque `AXGroup` (`childCount: 0`) even with `AXEnhancedUserInterface` and `AXManualAccessibility` enabled. | Inner DOM controls inside `WKWebView` were not exposed via standard `kAXChildrenAttribute` in this probe; real Tauri binary & optional Web Inspector remain `UNPROVEN`. |
| **JavaFX (macOS)** | `UNPROVEN` | — | Not executed. | Eclipse Temurin JDK 21 LTS does not bundle OpenJFX modules; OpenJFX runtime not installed locally. |
| **Windows Native (FlaUI UIA3 / UIA2)** | `UNPROVEN` | `poc/windows-flaui/` | Created `.NET 8` C# PoC (`FlaUI.Core`, `FlaUI.UIA3`, `FlaUI.UIA2`) and GitHub Actions workflow `.github/workflows/phase0-windows.yml`. | Not compiled or run on Windows yet; Win32, WinForms, WPF, WinUI, and UIA2 fallback each require interactive Windows runtime validation. |
| **Tauri on Windows (WebView2)** | `UNPROVEN` | — | Not executed. | Requires Windows host with WebView2 runtime and a Tauri fixture app. |
| **Java Access Bridge (Windows)** | `UNPROVEN` | — | Not executed. | Requires Windows host + Temurin JDK 21 LTS + enabled JAB DLL validation. |

---

## 2. PoC Execution Steps & Actual Results

### 2.1 JSON-RPC Helper Protocol (`poc/rpc-proto/run.mjs`)
- **Command:** `node poc/rpc-proto/run.mjs`
- **Result:** Passed (`ok: true`) covering `handshake`, `timeout`, `cancellation`, `graceful_shutdown`, and `crash_detection`.

### 2.2 Playwright Web & CDP (`poc/web-cdp/run.mjs`)
- **Install:** `npm --prefix poc/web-cdp install --no-audit --no-fund` (`playwright@1.58.2`).
- **Execution:** `node poc/web-cdp/run.mjs` (auto-resolved cached `chromium_headless_shell-1255` from `~/Library/Caches/ms-playwright`).
- **Observed limitation:** Inside strict sandbox mode, Chromium navigation to `127.0.0.1` fails with `net::ERR_ACCESS_DENIED`. Outside network sandbox restrictions, `webResult` and `cdpResult` both passed (`serverMutatingCalls: 0`, `cdpAttached: true`).

### 2.3 Real Electron 35 CDP & IPC Probe (`poc/electron-cdp/run.mjs`)
- **Install:** `npm --prefix poc/electron-cdp install --no-audit --no-fund` (`electron@35.0.0`, `playwright@1.58.2`).
- **Execution:** `node poc/electron-cdp/run.mjs`
- **Observed Result:** Passed (`ok: true`, `rendererOut: "renderer-clicked"`, `ipcOut: "ipc-1"`, `ipcBypassedPlaywrightRouteGuard: true`).
- **Key Findings:**
  1. `--remote-debugging-port=0` must be passed **after** the Electron main entrypoint (passing it before causes `Electron: bad option`).
  2. `ELECTRON_RUN_AS_NODE` must be deleted from the spawned child environment when launched from an Electron-hosted IDE/runner; otherwise `require('electron').app` is `undefined`.
  3. Main-process IPC calls (`ipcRenderer.invoke`) bypass Playwright `page.route()` network guards completely.

### 2.4 macOS Accessibility (`poc/macos-ax/run-fixture-test.sh`)
- **Compile:** `/Library/Developer/CommandLineTools/usr/bin/swiftc -sdk /Library/Developer/CommandLineTools/SDKs/MacOSX.sdk -module-cache-path /tmp/swift-module-cache` on `main.swift` and `FixtureApp.swift`.
- **Observed Result:** After Accessibility permission was granted (`trusted: true`), `ax-probe --pid <pid> --press-id safe-native-btn` discovered `AXWindow` (`windowCount: 1`), `AXButton` (`safe-native-btn`), and `AXStaticText`, executed `AXPress` (`pressStatus: 0`), and confirmed `"title": "clicked"` + `FIXTURE_CLICKED`.
- **Timing note:** AppKit requires ~200–300ms after `applicationDidFinishLaunching` (plus window activation) before `kAXWindowsAttribute` returns `windowCount: 1` reliably.

### 2.5 macOS `WKWebView` Probe (`poc/macos-ax/run-webkit-test.sh`)
- **Execution:** `./poc/macos-ax/run-webkit-test.sh` (with `--enhanced-ax` setting `AXEnhancedUserInterface` and `AXManualAccessibility`).
- **Observed Result:** `trusted: true`, `windowCount: 1`, outer `AXWindow` and titlebar buttons discovered, while the `WKWebView` content node appeared as `AXGroup` with `childCount: 0`—inner HTML `<button id="wk-btn">` was not exposed via `kAXChildrenAttribute` in this minimal AppKit embedding.

### 2.6 Java Swing Probe on Eclipse Temurin JDK 21 LTS (`poc/java-a11y/run-swing-ax-test.sh`)
- **Execution:** `./poc/java-a11y/run-swing-ax-test.sh` using `/usr/libexec/java_home -v 21` (`Temurin-21.0.13.1+2-LTS`).
- **Observed Result:** External macOS `ax-probe` inspected `net.java.openjdk.java` (`windowCount: 1`), found `AXButton` (`"Safe Swing Action"`), executed `AXPress` (`pressStatus: 0`), and confirmed `SWING_BUTTON_CLICKED` + `AXStaticText` `"clicked"`.

### 2.7 Windows FlaUI PoC (`poc/windows-flaui/` & `.github/workflows/phase0-windows.yml`)
- **Local macOS NuGet test:** `dotnet restore` failed in sandbox trying to access `~/.nuget/NuGet/NuGet.Config` and cannot run Windows UIA binaries on macOS.
- **CI Readiness:** Added `WindowsHelperPoc.csproj` (`net8.0-windows`, `EnableWindowsTargeting=true`) and manual `workflow_dispatch` GitHub Actions workflow `.github/workflows/phase0-windows.yml`. Compilation on `windows-latest` will verify build only; interactive desktop validation requires a desktop session / self-hosted Windows runner.

---

## 3. Known Limitations & Safety Boundaries

1. **CDP ≠ Process/IPC Safety:** Playwright `page.route()` intercepts HTTP/WebSocket traffic inside renderer targets only. Electron `ipcRenderer` / main-process calls and Tauri `invoke()` Rust bridge commands bypass HTTP interception entirely and must be reported as unprotected by network guards.
2. **Tauri macOS (`WKWebView`) vs. Windows (`WebView2`):** Windows WebView2 can expose CDP (`--remote-debugging-port`), whereas macOS `WKWebView` does not provide standard external CDP attachment and in our Phase 0 probe exposed only an opaque `AXGroup` (`childCount: 0`) to `AXUIElement`. Tauri macOS DOM-level coverage cannot be assumed without validated Web Inspector or targeted WebKit accessibility testing.
3. **OS Permissions & Interactive Desktops:** macOS `AXUIElement` fails closed when `AXIsProcessTrusted() == false` and fails inside strict OS sandboxes (`hiservices-xpcservice` blocked). Windows FlaUI and macOS AX require an unlocked interactive desktop session—headless CI runners without an interactive session cannot validate real UI interaction and must report `UNAVAILABLE`/`UNPROVEN`.
4. **UIA3 Default vs. UIA2:** FlaUI `UIA3` must be default; `UIA2` fallback will only be enabled for reproduced framework bugs (e.g., legacy WinForms/Win32 controls).
5. **AppKit Window Readiness & Electron Env Isolation:** AppKit windows require brief runloop settling before `kAXWindowsAttribute` populates; Electron targets launched from Electron-based IDEs require stripping `ELECTRON_RUN_AS_NODE` and placing Chromium switches after the entrypoint.

---

## 4. Dependency & Licence Review

### Phase 0–2 Core & Web Stack (Minimal)

| Package | Purpose | Licence | Risk / Notes |
|---|---|---|---|
| `typescript` | Strict TS (`noUncheckedIndexedAccess`) | Apache-2.0 | Build-time only |
| `tsdown` | ESM/CLI bundle build | MIT | Build-time only; verify Node 24 output |
| `commander` | CLI commands (`dpcrawl`) | MIT | Mature, zero native deps |
| `zod` | Config & JSON-RPC schema validation | MIT | Pure TS, zero runtime deps |
| `pino` | Structured JSON logging + redaction | MIT | Configure redact paths for secrets/auth |
| `vitest` | Unit, contract, determinism tests | MIT | Dev-only |
| `fast-check` | Property-based testing | MIT | Dev-only |
| `playwright` | Web & CDP automation | Apache-2.0 | Large browser binaries; isolate strictly in `src/adapters/web` & `electron` |
| `escape-html` | HTML report escaping | MIT | Tiny, single-purpose |
| `pngjs` | Pure-JS PNG handling/masking (Phase 2) | MIT | Zero native compilation |

### Phase 3+ Helper Dependencies (Isolated in Native Helpers)
- **Windows (`native/windows-helper`):** `FlaUI.Core`, `FlaUI.UIA3`, `FlaUI.UIA2` (`4.0.0`, MIT). Isolated in `.NET 8` process; no impact on Node core.
- **macOS (`native/macos-helper`):** Apple system frameworks (`ApplicationServices`, `AppKit`). Zero third-party Swift packages required.

### Explicitly Deferred to Phase 8
- `PaddleOCR`, `OpenCV`, `OpenTelemetry` (and `pixelmatch` until visual diffing is needed) are deferred to prevent premature native build complexity and speculative telemetry overhead.

---

## 5. Platform-Specific Risks

- **Windows:** Cannot be runtime-verified on macOS `arm64`; needs `windows-latest` CI for build + interactive Windows runner for Win32/WinForms/WPF/WinUI/JAB fixtures.
- **macOS `WKWebView` / Tauri:** Embedded `WKWebView` did not expose inner DOM elements via `AXUIElement` in Phase 0; Tauri macOS may require Web Inspector / specialized AX investigation in Phase 5 before claiming support.
- **Java:** Swing on Temurin 21 LTS via macOS `AXUIElement` is `PROVEN`, while JavaFX (OpenJFX not bundled in Temurin 21) and Windows JAB remain `UNPROVEN`.
- **pnpm:** `corepack` is installed, but `pnpm` is not yet activated on `PATH` and failed with `EPERM` outside a repo containing `package.json`. Phase 1 initialization must create root `package.json` with `packageManager` pinned before enabling `pnpm`.

---

## 6. Proposed Release Sequence

1. **Phase 1 — Shared Brain, Contracts & Mock Adapter:** Establish strict TypeScript core, `UniversalNode`/capability contracts, rule-based safety engine, canonical finding IDs, baseline diffing, offline HTML/JSON/MD reports, `fast-check` determinism tests, and architecture boundary tests.
2. **Phase 2 — Web Adapter (`playwright`):** Lowest environment friction; validates all 23 web fixtures, network/GET-mutation guard, `sessionStorage` auth replay, portal toast correlation, and redaction end-to-end.
3. **Phase 3 — Windows Native Desktop (`FlaUI.UIA3`):** Uses the proven JSON-RPC stdio transport from Phase 0; validates Win32/WinForms/WPF (and WinUI status) on an interactive Windows runner.
4. **Phase 4 — Electron & Tauri:** Combines Playwright CDP + native helper scoping while enforcing explicit IPC/bridge safety boundaries.
5. **Phase 5 — macOS Native Desktop (`AXUIElement`):** Builds on the proven Swift `AXUIElement` helper and validates Electron/Tauri macOS limits honestly.
6. **Phase 6 — Java Desktop (Swing / JavaFX):** Builds on Temurin JDK 21 LTS + OpenJFX with Windows JAB and macOS AX separately.
7. **Phase 7 — Hardening & Release** → **Phase 8 — OCR, OpenCV, Scenarios, AI Enrichment.**
