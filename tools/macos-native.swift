import AppKit
import ApplicationServices
import Foundation

// Public AX/NSWorkspace APIs only. Never activates apps, writes the clipboard, or posts input events.
let null = NSNull()
func readAX(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func elementAX(_ element: AXUIElement, _ name: String) -> AXUIElement? {
    guard let value = readAX(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}
func appAX(_ pid: pid_t) -> AXUIElement {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 1)
    return app
}
var identities: [(AXUIElement, String)] = []
let session = UUID().uuidString
func token(_ element: AXUIElement) -> String {
    if let match = identities.first(where: { CFEqual($0.0, element) }) { return match.1 }
    let id = "\(session):\(identities.count)"
    identities.append((element, id))
    return id
}
func windowInfo(_ window: AXUIElement, details: Bool = true) -> [String: Any] {
    if !details { return ["token": token(window), "title": null, "document": null] }
    return ["token": token(window), "title": readAX(window, kAXTitleAttribute) as? String ?? null as Any,
            "document": readAX(window, kAXDocumentAttribute) as? String ?? null as Any]
}
func appInfo(_ app: NSRunningApplication) -> [String: Any] {
    return ["pid": app.processIdentifier, "name": app.localizedName ?? "<unknown>",
            "bundleId": app.bundleIdentifier ?? null as Any, "path": app.bundleURL?.path ?? null as Any]
}
func resolveApp(_ identifier: String) -> [String: Any] {
    let matches = NSWorkspace.shared.runningApplications.filter {
        !$0.isTerminated && ($0.bundleIdentifier == identifier || $0.bundleURL?.path == identifier || $0.localizedName == identifier)
    }
    guard matches.count == 1 else {
        return ["error": matches.isEmpty ? "No running app exactly matches \(identifier). Open the intended app yourself, then observe it."
            : "Ambiguous running app \(identifier). Use an exact bundle ID or app path identifying one running process."]
    }
    return appInfo(matches[0])
}
func snapshot(detailsFor targets: Set<pid_t>? = nil) -> [String: Any] {
    guard let app = NSWorkspace.shared.frontmostApplication else { return ["frontmost": null, "focusedWindow": null] }
    let window = AXIsProcessTrusted() ? elementAX(appAX(app.processIdentifier), kAXFocusedWindowAttribute) : nil
    return ["frontmost": appInfo(app), "focusedWindow": window.map { windowInfo($0, details: targets?.contains(app.processIdentifier) ?? true) } ?? null as Any]
}
func focused(_ pid: pid_t) -> (AXUIElement, AXUIElement)? {
    let app = appAX(pid)
    guard let window = elementAX(app, kAXFocusedWindowAttribute),
          let element = elementAX(app, kAXFocusedUIElementAttribute),
          let owner = elementAX(element, kAXWindowAttribute), CFEqual(owner, window) else { return nil }
    return (window, element)
}
func inspect(_ pid: pid_t) -> [String: Any] {
    let app = appAX(pid)
    var raw: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &raw)
    let windows = error == .success ? raw as? [AXUIElement] : nil
    var result: [String: Any] = ["pid": pid, "accessibilityTrusted": AXIsProcessTrusted(),
        "app": NSRunningApplication(processIdentifier: pid).map(appInfo) ?? null as Any,
        "windowsCount": windows?.count ?? null as Any, "windowsError": error.rawValue,
        "windows": windows?.map { windowInfo($0) } ?? null as Any, "focusedWindow": null, "focusedElement": null]
    if let (window, element) = focused(pid) {
        result["focusedWindow"] = windowInfo(window)
        result["focusedElement"] = ["token": token(element), "role": readAX(element, kAXRoleAttribute) as? String ?? null as Any,
            "identifier": readAX(element, kAXIdentifierAttribute) as? String ?? null as Any,
            "roleDescription": readAX(element, kAXRoleDescriptionAttribute) as? String ?? null as Any,
            "title": readAX(element, kAXTitleAttribute) as? String ?? null as Any,
            "description": readAX(element, kAXDescriptionAttribute) as? String ?? null as Any,
            "value": readAX(element, kAXValueAttribute) as? String ?? null as Any]
    } else if let window = elementAX(app, kAXFocusedWindowAttribute) { result["focusedWindow"] = windowInfo(window) }
    return result
}
struct Observation {
    let before: [String: Any]
    let targets: Set<pid_t>
    var transitions: [[String: Any]] = []
    var windows: [String: Int32] = [:]
    var truncated = false
}
var observations: [String: Observation] = [:]
var observers: [pid_t: AXObserver] = [:]
var windowStatus: [pid_t: Int32] = [:]
func record(_ event: [String: Any]) {
    for id in Array(observations.keys) {
        var visible = event
        if let pid = event["pid"] as? pid_t, !observations[id]!.targets.contains(pid), let window = event["window"] as? [String: Any] {
            visible["window"] = ["token": window["token"] ?? null, "title": null, "document": null]
        }
        if observations[id]!.transitions.count < 1000 { observations[id]!.transitions.append(visible) }
        else { observations[id]!.truncated = true }
    }
}
func watch(_ pid: pid_t) {
    if windowStatus[pid] == nil {
        var observer: AXObserver?
        let created = AXObserverCreate(pid, { _, element, _, _ in
            var pid: pid_t = 0
            AXUIElementGetPid(element, &pid)
            let window = elementAX(appAX(pid), kAXFocusedWindowAttribute)
            let target = observations.values.contains { $0.targets.contains(pid) }
            record(["kind": "focused_window", "pid": pid, "at": Date().timeIntervalSince1970 * 1000,
                    "window": window.map { windowInfo($0, details: target) } ?? null as Any])
        }, &observer)
        if created == .success, let observer = observer {
            let error = AXObserverAddNotification(observer, appAX(pid), kAXFocusedWindowChangedNotification as CFString, nil)
            windowStatus[pid] = error.rawValue
            if error == .success {
                observers[pid] = observer
                CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode)
            }
        } else { windowStatus[pid] = created.rawValue }
    }
    for id in Array(observations.keys) { observations[id]!.windows[String(pid)] = windowStatus[pid]! }
}
let workspaceObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { notification in
    guard !observations.isEmpty, let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
    record(["kind": "activation", "at": Date().timeIntervalSince1970 * 1000, "app": appInfo(app)])
    watch(app.processIdentifier)
}
func handle(_ request: [String: Any]) -> [String: Any] {
    switch request["method"] as? String {
    case "snapshot": return snapshot()
    case "resolveApp":
        guard let identifier = request["identifier"] as? String, !identifier.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return ["error": "An exact running app name, bundle ID or path is required"]
        }
        return resolveApp(identifier)
    case "beginObservation":
        let id = UUID().uuidString
        let targets = Set((request["pids"] as? [pid_t] ?? []).filter { $0 > 0 })
        observations[id] = Observation(before: snapshot(detailsFor: targets), targets: targets)
        if let app = NSWorkspace.shared.frontmostApplication { watch(app.processIdentifier) }
        for pid in targets { watch(pid) }
        return ["id": id, "before": observations[id]!.before]
    case "endObservation":
        guard let id = request["observationId"] as? String, let observation = observations.removeValue(forKey: id) else { return ["error": "Unknown observation"] }
        let result: [String: Any] = ["before": observation.before, "after": snapshot(detailsFor: observation.targets), "transitions": observation.transitions,
            "coverage": ["applicationActivation": true, "windowDetails": "targetAppsOnly", "focusedWindow": observation.windows, "truncated": observation.truncated,
                         "inputAttribution": false]]
        if observations.isEmpty {
            for observer in observers.values { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode) }
            observers.removeAll(); windowStatus.removeAll()
        }
        return result
    case "inspectApp":
        guard let pid = request["pid"] as? Int32, pid > 0 else { return ["error": "A positive target PID is required"] }
        return inspect(pid)
    default: return ["error": "Unknown method"]
    }
}
func emit(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
    }
}
// Blocking stdin stays off the run loop so native notifications remain live between requests.
DispatchQueue.global().async {
    while let line = readLine() {
        guard let data = line.data(using: .utf8), let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
        DispatchQueue.main.async { emit(["id": request["id"] ?? null, "result": handle(request)]) }
    }
    DispatchQueue.main.async { exit(0) }
}
RunLoop.main.run()
