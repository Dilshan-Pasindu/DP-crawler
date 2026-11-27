import Cocoa
import WebKit

class WebKitDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var webView: WKWebView!

    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(
            contentRect: NSRect(x: 240, y: 240, width: 420, height: 260),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "DP Crawler macOS WKWebView Fixture"

        let config = WKWebViewConfiguration()
        webView = WKWebView(frame: window.contentRect(forFrameRect: window.frame), configuration: config)
        webView.navigationDelegate = self
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        let html = """
        <!doctype html>
        <html>
          <body>
            <button id="wk-btn" onclick="document.getElementById('wk-out').textContent='wk-clicked'">Safe WebKit Action</button>
            <p id="wk-out">idle</p>
          </body>
        </html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            print("WEBKIT_FIXTURE_READY pid=\(ProcessInfo.processInfo.processIdentifier)")
            fflush(stdout)
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = WebKitDelegate()
app.delegate = delegate
app.run()
