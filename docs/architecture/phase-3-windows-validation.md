# Phase 3 Windows Desktop Validation Report

**Date:** 2026-11-27  
**Authoring Workstation:** macOS 26.7.3 (`arm64`), Node.js `v24.15.0`, `.NET SDK 8.0.130`

> Per Master Prompt V5 and Phase 3 Windows Runtime Validation Rules, no technology is marked `PROVEN` from compilation or mocked transport checks alone.

---

## 1. Independent Validation Status Matrix

| Technology / Capability | Status | Evidence / Test Coverage | Remaining Gate |
|---|---|---|---|
| **JSON-RPC stdio Transport (`src/transports/`)** | `PROVEN` | `tests/unit/transport.test.ts` verified handshake, protocol version mismatch, timeout + `$/cancelRequest`, stderr redaction, crash detection, and graceful shutdown. | — |
| **Windows UIA Adapter & Brain Integration (`src/adapters/windows/`)** | `PARTIALLY_PROVEN` | `tests/contract/windows.contract.test.ts` and `tests/safety/windows-safety.test.ts` verified UIA3 default, explicit UIA2 opt-in, process boundary check, `BLOCKED_ENVIRONMENT`, foreground/UAC refusal, helper crash attribution, and unchanged shared brain/reports against a fake stdio helper. | Live execution against real `WindowsHelper.exe` on Windows. |
| **`.NET 8` FlaUI Helper (`native/windows-helper/`)** | `UNPROVEN` | Implemented `DesktopSessionProbe.cs`, `UiaEngine.cs`, `Program.cs`, and `.github/workflows/ci-windows.yml`. | Must compile on `windows-latest` CI and execute in an interactive Windows desktop session. |
| **Win32 Fixture (`fixtures/windows/Win32Fixture`)** | `UNPROVEN` | Fixture implemented; integration test in `tests/integration/windows.integration.test.ts`. | Requires interactive Windows runner (`ci-windows-interactive.yml`). |
| **WinForms Fixture (`fixtures/windows/WinFormsFixture`)** | `UNPROVEN` | Fixture implemented (buttons, delete guard, disabled control, checkbox, modal dialog, menu strip). | Requires interactive Windows runner (`ci-windows-interactive.yml`). |
| **WPF Fixture (`fixtures/windows/WpfFixture`)** | `UNPROVEN` | Fixture implemented (`AutomationId`s, safe/delete/disabled/toggle controls). | Requires interactive Windows runner (`ci-windows-interactive.yml`). |
| **WinUI 3 Packaged (MSIX) & Unpackaged (`fixtures/windows/WinUi3Fixture`)** | `UNPROVEN` | Dedicated fixture implemented with pinned `.NET 8` + `Microsoft.WindowsAppSDK 1.6.250108002` covering all required controls (`NavigationView`, `ContentDialog`, `ScrollViewer`, `MenuBar`, `MenuFlyout`, `ToggleSwitch`, `ComboBox`, `ListView`, unnamed/disabled/collapsed/dynamic controls). | Requires provisioned Windows 11 environment with Windows App SDK runtime; packaged MSIX, unpackaged, framework-dependent, and self-contained modes must be validated separately. |

---

## 2. CI & Interactive Runner Separation

- **Non-interactive compilation & unit checks:** `.github/workflows/ci-windows.yml` (`windows-latest`) compiles `native/windows-helper/` and Win32/WinForms/WPF fixtures, runs TypeScript/unit/safety/contract tests, and probes `DesktopSessionProbe` (`BLOCKED_ENVIRONMENT` expected when headless).
- **Interactive desktop validation:** `.github/workflows/ci-windows-interactive.yml` (`workflow_dispatch`, `[self-hosted, windows, interactive]`, `concurrency: windows-interactive-desktop-session`) runs live UIA tests inside an unlocked logged-in Windows user session with max 1 concurrent job and no untrusted PR triggers.
