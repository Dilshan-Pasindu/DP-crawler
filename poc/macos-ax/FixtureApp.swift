import Cocoa

class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var label: NSTextField!

    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(
            contentRect: NSRect(x: 200, y: 200, width: 320, height: 180),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "DP Crawler macOS AX Fixture"

        let content = NSView(frame: window.contentRect(forFrameRect: window.frame))
        let button = NSButton(frame: NSRect(x: 60, y: 95, width: 200, height: 32))
        button.title = "Safe Native Action"
        button.setAccessibilityIdentifier("safe-native-btn")
        button.target = self
        button.action = #selector(onSafeButton)

        label = NSTextField(labelWithString: "idle")
        label.frame = NSRect(x: 60, y: 50, width: 200, height: 24)
        label.setAccessibilityIdentifier("native-status")

        content.addSubview(button)
        content.addSubview(label)
        window.contentView = content
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            print("FIXTURE_READY pid=\(ProcessInfo.processInfo.processIdentifier)")
            fflush(stdout)
        }
    }

    @objc func onSafeButton() {
        label.stringValue = "clicked"
        print("FIXTURE_CLICKED")
        fflush(stdout)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
