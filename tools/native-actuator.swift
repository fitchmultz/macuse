import AppKit
import ApplicationServices
import Darwin
import Foundation
import ScreenCaptureKit

// Experimental AX-only actuator. No global input events, app activation, clipboard, or vendor runtime.
let null = NSNull()
struct Failure: Error { let message: String }
func ax(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
    var result: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, attribute as CFString, &result) == .success ? result : nil
}
func string(_ element: AXUIElement, _ attribute: String) -> String? { ax(element, attribute) as? String }
func frame(_ element: AXUIElement) -> [String: Double]? {
    guard let position = ax(element, kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID(),
          let size = ax(element, kAXSizeAttribute), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero; var dimensions = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &point), AXValueGetValue(size as! AXValue, .cgSize, &dimensions) else { return nil }
    return ["x": point.x, "y": point.y, "width": dimensions.width, "height": dimensions.height]
}
func focus() -> [String: Any] {
    let point = NSEvent.mouseLocation
    return ["frontmostPid": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0,
            "cursor": ["x": point.x, "y": point.y], "cursorCoordinateSpace": "AppKit-screen-points",
            "inputAttribution": false]
}
func canonical(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) }
var identities: [(AXUIElement, String)] = []
func token(_ element: AXUIElement) -> String {
    if let found = identities.first(where: { CFEqual($0.0, element) }) { return found.1 }
    let value = UUID().uuidString; identities.append((element, value)); return value
}
struct Observation {
    let id: String
    let app: NSRunningApplication
    let state: [String: Any]
    let elements: [String: AXUIElement]
    let windows: [String: AXUIElement]
}
var observed: Observation?
func state(_ app: NSRunningApplication) throws -> ([String: Any], [String: AXUIElement], [String: AXUIElement]) {
    guard AXIsProcessTrusted() else { throw Failure(message: "Accessibility permission is unavailable; use supported System Settings permission flow") }
    let root = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(root, 1)
    var raw: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(root, kAXWindowsAttribute as CFString, &raw)
    guard error == .success, let windows = raw as? [AXUIElement] else { throw Failure(message: "AX windows read failed: \(error.rawValue)") }
    var windowData: [[String: Any]] = []; var elementData: [[String: Any]] = []
    var elements: [String: AXUIElement] = [:]; var refs: [String: AXUIElement] = [:]
    var visited: [AXUIElement] = []
    func walk(_ element: AXUIElement, _ window: String, _ parent: String?, _ depth: Int) throws {
        if visited.contains(where: { CFEqual($0, element) }) { return }
        guard depth <= 40, visited.count < 1500 else { throw Failure(message: "Full AX snapshot exceeds proof limits; no partial observation admitted") }
        visited.append(element)
        let id = token(element); elements[id] = element
        var actions: CFArray?
        let actionError = AXUIElementCopyActionNames(element, &actions)
        guard actionError == .success || actionError == .attributeUnsupported || actionError == .notImplemented else {
            throw Failure(message: "AX action inventory failed: \(actionError.rawValue)")
        }
        var settable = DarwinBoolean(false)
        let valueSettable = AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success && settable.boolValue
        let role = string(element, kAXRoleAttribute)
        let subrole = string(element, kAXSubroleAttribute)
        let secure = role == "AXSecureTextField" || subrole == "AXSecureTextField"
        var value: Any = null
        if !secure, let rawValue = ax(element, kAXValueAttribute) {
            if let text = rawValue as? String { value = text }
            else if let number = rawValue as? NSNumber { value = number }
        }
        let data: [String: Any] = ["token": id, "windowToken": window, "parent": parent ?? null as Any,
            "role": role ?? null as Any, "subrole": subrole ?? null as Any, "secure": secure,
            "title": string(element, kAXTitleAttribute) ?? null as Any,
            "description": string(element, kAXDescriptionAttribute) ?? null as Any,
            "identifier": string(element, kAXIdentifierAttribute) ?? null as Any,
            "value": value, "actions": actions as? [String] ?? [], "valueSettable": valueSettable,
            "frame": frame(element) ?? null as Any]
        elementData.append(data)
        var children: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &children)
        guard result == .success || result == .attributeUnsupported || result == .noValue else {
            throw Failure(message: "AX children read failed: \(result.rawValue)")
        }
        for child in children as? [AXUIElement] ?? [] { try walk(child, window, id, depth + 1) }
    }
    for window in windows {
        let id = token(window); refs[id] = window
        windowData.append(["token": id, "title": string(window, kAXTitleAttribute) ?? null as Any,
            "document": string(window, kAXDocumentAttribute) ?? null as Any, "frame": frame(window) ?? null as Any])
        try walk(window, id, nil, 0)
    }
    let data: [String: Any] = ["app": ["bundleId": app.bundleIdentifier ?? "", "pid": app.processIdentifier,
        "path": app.bundleURL?.path ?? "", "launchDate": app.launchDate?.timeIntervalSince1970 ?? 0],
        "windows": windowData, "elements": elementData]
    guard try canonical(data).count <= 1_000_000 else { throw Failure(message: "Full AX snapshot exceeds one megabyte; no partial observation admitted") }
    identities.removeAll { identity in !visited.contains { CFEqual(identity.0, $0) } }
    return (data, elements, refs)
}
func resolve(_ identifier: String) throws -> NSRunningApplication {
    let matches = NSWorkspace.shared.runningApplications.filter { !$0.isTerminated && $0.bundleIdentifier == identifier }
    guard matches.count == 1 else { throw Failure(message: "Exactly one running app must match the exact bundle ID") }
    return matches[0]
}
func current(_ request: [String: Any]) throws -> Observation {
    guard let saved = observed, request["observationId"] as? String == saved.id,
          request["app"] as? String == saved.app.bundleIdentifier else { throw Failure(message: "Fresh same-app observation is required") }
    let app = try resolve(saved.app.bundleIdentifier!)
    guard app.processIdentifier == saved.app.processIdentifier, app.launchDate == saved.app.launchDate,
          app.bundleURL == saved.app.bundleURL else { throw Failure(message: "Observed app process changed") }
    let (fresh, _, _) = try state(app)
    guard try canonical(fresh["windows"]!) == canonical(saved.state["windows"]!) else {
        observed = nil; throw Failure(message: "Observed window/document identity changed; observe again")
    }
    if request["elementToken"] != nil {
        // The proof has no record-context model. Reject any changed app content rather than guessing
        // whether a sibling label belongs to a reused editor's newly selected record.
        guard try canonical(fresh) == canonical(saved.state) else {
            observed = nil; throw Failure(message: "Observed app context or target changed; observe again")
        }
    }
    return saved
}
func observe(_ request: [String: Any]) throws -> [String: Any] {
    observed = nil
    guard let identifier = request["app"] as? String, !identifier.isEmpty else { throw Failure(message: "Exact app bundle ID is required") }
    let app = try resolve(identifier)
    if request.keys.contains("expectedPid") || request.keys.contains("expectedPath") {
        guard let expectedPid = request["expectedPid"] as? Int32, expectedPid > 0,
              let expectedPath = request["expectedPath"] as? String, expectedPath.hasPrefix("/"),
              app.processIdentifier == expectedPid, app.bundleURL?.path == expectedPath else {
            throw Failure(message: "Trusted app PID/path identity mismatch; no AX content was read")
        }
    }
    let (data, elements, windows) = try state(app)
    let observation = Observation(id: UUID().uuidString, app: app, state: data, elements: elements, windows: windows)
    observed = observation
    return data.merging(["observationId": observation.id, "focus": focus(), "fullSnapshot": true]) { _, new in new }
}
func act(_ request: [String: Any]) throws -> [String: Any] {
    guard request["allowMutating"] as? Bool == true,
          let note = request["safetyNote"] as? String, !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        throw Failure(message: "Mutation requires allowMutating:true and concrete safetyNote; flags are not user permission")
    }
    let saved = try current(request)
    guard let id = request["elementToken"] as? String, let element = saved.elements[id],
          let metadata = (saved.state["elements"] as? [[String: Any]])?.first(where: { $0["token"] as? String == id }),
          let action = request["action"] as? String else { throw Failure(message: "Observed exact element and supported action are required") }
    let before = focus()
    let error: AXError
    switch action {
    case "press":
        guard (metadata["actions"] as? [String] ?? []).contains(kAXPressAction) else { throw Failure(message: "AXPress is not listed for this element") }
        observed = nil
        error = AXUIElementPerformAction(element, kAXPressAction as CFString)
    case "setValue":
        guard metadata["valueSettable"] as? Bool == true, metadata["secure"] as? Bool == false,
              let value = request["value"] as? String else { throw Failure(message: "Observed nonsecure settable field and string value are required") }
        observed = nil
        error = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFString)
    default: throw Failure(message: "Unsupported proof action; only press and setValue are implemented")
    }
    var verified = error == .success
    var verificationError: String?
    if action == "setValue" && verified {
        do {
            var expected = saved.state
            var elements = expected["elements"] as! [[String: Any]]
            let index = elements.firstIndex { $0["token"] as? String == id }!
            elements[index]["value"] = request["value"]
            expected["elements"] = elements
            let (fresh, _, _) = try state(saved.app)
            verified = try canonical(fresh) == canonical(expected)
                && string(element, kAXValueAttribute)?.utf16.elementsEqual((request["value"] as! String).utf16) == true
            if !verified { verificationError = "Post-write app context or exact target readback changed; do not replay" }
        } catch {
            verified = false
            verificationError = "Post-write verification failed: \(error); do not replay"
        }
    }
    var result: [String: Any] = ["status": verified ? "applied" : "unverified", "mutationAttempted": true,
            "verified": action == "setValue" && verified, "nativeAccepted": error == .success,
            "axError": error.rawValue, "focusBefore": before, "focusAfter": focus(),
            "outcome": verified ? (action == "press" ? "requires-fresh-observation" : "verified") : "unknown"]
    if let verificationError { result["verificationError"] = verificationError }
    return result
}
func screenshot(_ request: [String: Any]) async throws -> [String: Any] {
    let saved = try current(request)
    guard CGPreflightScreenCaptureAccess() else { throw Failure(message: "Screen Recording permission is unavailable; no permission prompt was opened") }
    guard let windowToken = request["windowToken"] as? String,
          let window = (saved.state["windows"] as? [[String: Any]])?.first(where: { $0["token"] as? String == windowToken }),
          let bounds = window["frame"] as? [String: Double] else { throw Failure(message: "Observed window token with known frame is required") }
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
    let matches = content.windows.filter { candidate in
        guard candidate.owningApplication?.processID == saved.app.processIdentifier,
              candidate.title == window["title"] as? String else { return false }
        return abs(candidate.frame.minX - bounds["x"]!) < 1 && abs(candidate.frame.minY - bounds["y"]!) < 1
            && abs(candidate.frame.width - bounds["width"]!) < 1 && abs(candidate.frame.height - bounds["height"]!) < 1
    }
    guard matches.count == 1 else { throw Failure(message: "Screenshot window identity is missing or ambiguous; no whole-desktop fallback") }
    let selected = matches[0]
    let filter = SCContentFilter(desktopIndependentWindow: selected)
    let configuration = SCStreamConfiguration()
    configuration.showsCursor = false
    configuration.ignoreShadowsSingleWindow = true
    configuration.width = max(1, Int((filter.contentRect.width * CGFloat(filter.pointPixelScale)).rounded()))
    configuration.height = max(1, Int((filter.contentRect.height * CGFloat(filter.pointPixelScale)).rounded()))
    guard configuration.width <= 8192, configuration.height <= 8192,
          configuration.width * configuration.height <= 16_000_000 else { throw Failure(message: "Screenshot exceeds proof pixel budget; no scaled or desktop fallback") }
    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
    // Capture is asynchronous: revalidate the observed target before returning its bytes.
    _ = try current(request)
    guard let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else { throw Failure(message: "PNG encoding failed") }
    guard data.count <= 12_000_000 else { throw Failure(message: "PNG exceeds twelve megabyte proof budget") }
    return ["windowToken": windowToken, "windowId": selected.windowID, "windowFrame": bounds,
        "captureRect": ["x": filter.contentRect.minX, "y": filter.contentRect.minY, "width": filter.contentRect.width, "height": filter.contentRect.height],
        "pointPixelScale": filter.pointPixelScale, "coordinateSpace": "screenshot-pixels", "cursorIncluded": false,
        "image": ["mimeType": "image/png", "width": image.width, "height": image.height, "data": data.base64EncodedString()]]
}
func emit(_ value: [String: Any]) {
    if let data = try? canonical(value) { FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10])) }
}
// One request at a time. The parent serializes calls; stdin is suspended while capture awaits native completion.
DispatchQueue.global().async {
    func dispatchLine(_ bytes: Data) {
        let done = DispatchSemaphore(value: 0)
        DispatchQueue.main.async {
            Task { @MainActor in
                defer { done.signal() }
                guard let request = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any] else { return }
                do {
                    let result: [String: Any]
                    switch request["method"] as? String {
                    case "observe": result = try observe(request)
                    case "act": result = try act(request)
                    case "screenshot": result = try await screenshot(request)
                    default: throw Failure(message: "Unknown actuator operation")
                    }
                    emit(["id": request["id"] ?? null, "result": result])
                } catch {
                    emit(["id": request["id"] ?? null, "result": ["status": "guard_failed", "mutationAttempted": false,
                        "error": (error as? Failure)?.message ?? String(describing: error)]])
                }
            }
        }
        done.wait()
    }
    var pending = Data()
    var buffer = [UInt8](repeating: 0, count: 65_536)
    while true {
        let count = Darwin.read(STDIN_FILENO, &buffer, buffer.count)
        if count == 0 { break }
        if count < 0 { if errno == EINTR { continue }; exit(1) }
        pending.append(contentsOf: buffer.prefix(count))
        while let newline = pending.firstIndex(of: 10) {
            guard newline <= 1_000_000 else { exit(1) }
            dispatchLine(pending.subdata(in: 0..<newline))
            pending.removeSubrange(0...newline)
        }
        guard pending.count <= 1_000_000 else { exit(1) }
    }
    DispatchQueue.main.async { exit(0) }
}
RunLoop.main.run()
