import Foundation
import ApplicationServices
import AppKit

struct AxBounds: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct AxNodeSummary: Codable {
    let role: String
    let title: String?
    let identifier: String?
    let enabled: Bool?
    let bounds: AxBounds?
    let actions: [String]
    let childCount: Int
}

struct AxProbeResult: Codable {
    let trusted: Bool
    let targetPid: Int32?
    let targetBundleId: String?
    let windowCount: Int
    let sampleNodes: [AxNodeSummary]
    let performedPressOn: String?
    let pressStatus: Int32?
    let error: String?
}

func copyStringAttribute(_ element: AXUIElement, _ attr: CFString) -> String? {
    var value: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(element, attr, &value)
    guard err == .success, let str = value as? String, !str.isEmpty else {
        return nil
    }
    return str
}

func copyBoolAttribute(_ element: AXUIElement, _ attr: CFString) -> Bool? {
    var value: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(element, attr, &value)
    guard err == .success, let num = value as? NSNumber else {
        return nil
    }
    return num.boolValue
}

func copyBounds(_ element: AXUIElement) -> AxBounds? {
    var posRef: CFTypeRef?
    var sizeRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &posRef) == .success,
          AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeRef) == .success,
          let posVal = posRef,
          let sizeVal = sizeRef,
          CFGetTypeID(posVal) == AXValueGetTypeID(),
          CFGetTypeID(sizeVal) == AXValueGetTypeID() else {
        return nil
    }
    var pt = CGPoint.zero
    var sz = CGSize.zero
    guard AXValueGetValue(posVal as! AXValue, .cgPoint, &pt),
          AXValueGetValue(sizeVal as! AXValue, .cgSize, &sz) else {
        return nil
    }
    return AxBounds(x: pt.x, y: pt.y, width: sz.width, height: sz.height)
}

func copyChildren(_ element: AXUIElement) -> [AXUIElement] {
    var value: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value)
    guard err == .success, let arr = value as? [AXUIElement] else {
        return []
    }
    return arr
}

func copyActionNames(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    let err = AXUIElementCopyActionNames(element, &names)
    guard err == .success, let list = names as? [String] else {
        return []
    }
    return list
}

func collectSample(
    _ element: AXUIElement,
    depth: Int,
    maxDepth: Int,
    pressIdentifier: String?,
    pressTitle: String?,
    pressedOut: inout String?,
    pressStatusOut: inout Int32?,
    out: inout [AxNodeSummary]
) {
    if out.count >= 40 || depth > maxDepth { return }
    let role = copyStringAttribute(element, kAXRoleAttribute as CFString) ?? "unknown"
    let title = copyStringAttribute(element, kAXTitleAttribute as CFString)
        ?? copyStringAttribute(element, kAXDescriptionAttribute as CFString)
        ?? copyStringAttribute(element, kAXValueAttribute as CFString)
    let identifier = copyStringAttribute(element, kAXIdentifierAttribute as CFString)
    let enabled = copyBoolAttribute(element, kAXEnabledAttribute as CFString)
    let bounds = copyBounds(element)
    let actions = copyActionNames(element)
    let children = copyChildren(element)

    let idMatch = (pressIdentifier != nil && identifier == pressIdentifier)
    let titleMatch = (pressTitle != nil && title == pressTitle)
    if (idMatch || titleMatch), pressedOut == nil, actions.contains(kAXPressAction as String) {
        let status = AXUIElementPerformAction(element, kAXPressAction as CFString)
        pressedOut = identifier ?? title
        pressStatusOut = status.rawValue
    }

    out.append(AxNodeSummary(
        role: role,
        title: title,
        identifier: identifier,
        enabled: enabled,
        bounds: bounds,
        actions: actions,
        childCount: children.count
    ))

    for child in children.prefix(15) {
        collectSample(
            child,
            depth: depth + 1,
            maxDepth: maxDepth,
            pressIdentifier: pressIdentifier,
            pressTitle: pressTitle,
            pressedOut: &pressedOut,
            pressStatusOut: &pressStatusOut,
            out: &out
        )
    }
}

let trusted = AXIsProcessTrusted()
let args = CommandLine.arguments
var targetApp: NSRunningApplication? = nil

if let idx = args.firstIndex(of: "--pid"), idx + 1 < args.count, let pid = Int32(args[idx + 1]) {
    targetApp = NSRunningApplication(processIdentifier: pid)
} else if let idx = args.firstIndex(of: "--bundle"), idx + 1 < args.count {
    let bundleId = args[idx + 1]
    targetApp = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first
} else {
    targetApp = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.finder").first
}

var pressId: String? = nil
if let idx = args.firstIndex(of: "--press-id"), idx + 1 < args.count {
    pressId = args[idx + 1]
}
var pressTitle: String? = nil
if let idx = args.firstIndex(of: "--press-title"), idx + 1 < args.count {
    pressTitle = args[idx + 1]
}
let enableEnhancedAx = args.contains("--enhanced-ax")

let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .sortedKeys]

guard trusted else {
    let res = AxProbeResult(
        trusted: false,
        targetPid: targetApp?.processIdentifier,
        targetBundleId: targetApp?.bundleIdentifier,
        windowCount: 0,
        sampleNodes: [],
        performedPressOn: nil,
        pressStatus: nil,
        error: "Accessibility permission not granted (AXIsProcessTrusted == false). Grant Accessibility permission manually in System Settings > Privacy & Security > Accessibility."
    )
    if let data = try? encoder.encode(res), let str = String(data: data, encoding: .utf8) {
        print(str)
    }
    exit(0)
}

guard let app = targetApp else {
    let res = AxProbeResult(
        trusted: true,
        targetPid: nil,
        targetBundleId: nil,
        windowCount: 0,
        sampleNodes: [],
        performedPressOn: nil,
        pressStatus: nil,
        error: "Target application not running."
    )
    if let data = try? encoder.encode(res), let str = String(data: data, encoding: .utf8) {
        print(str)
    }
    exit(0)
}

let appElement = AXUIElementCreateApplication(app.processIdentifier)
if enableEnhancedAx {
    AXUIElementSetAttributeValue(appElement, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    AXUIElementSetAttributeValue(appElement, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    Thread.sleep(forTimeInterval: 0.25)
}
var windowsRef: CFTypeRef?
let winErr = AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &windowsRef)
let windows = (winErr == .success ? (windowsRef as? [AXUIElement]) : nil) ?? []

var samples: [AxNodeSummary] = []
var performedPressOn: String? = nil
var pressStatus: Int32? = nil

if let firstWindow = windows.first {
    collectSample(
        firstWindow,
        depth: 0,
        maxDepth: 5,
        pressIdentifier: pressId,
        pressTitle: pressTitle,
        pressedOut: &performedPressOn,
        pressStatusOut: &pressStatus,
        out: &samples
    )
} else {
    collectSample(
        appElement,
        depth: 0,
        maxDepth: 3,
        pressIdentifier: pressId,
        pressTitle: pressTitle,
        pressedOut: &performedPressOn,
        pressStatusOut: &pressStatus,
        out: &samples
    )
}

let res = AxProbeResult(
    trusted: true,
    targetPid: app.processIdentifier,
    targetBundleId: app.bundleIdentifier,
    windowCount: windows.count,
    sampleNodes: samples,
    performedPressOn: performedPressOn,
    pressStatus: pressStatus,
    error: winErr == .success ? nil : "AXWindows error code: \(winErr.rawValue)"
)

if let data = try? encoder.encode(res), let str = String(data: data, encoding: .utf8) {
    print(str)
}
