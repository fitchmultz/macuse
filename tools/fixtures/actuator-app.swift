import AppKit
import Foundation

// A real disposable AppKit app, not an Accessibility or screenshot mock.
final class ContextChangingField: NSTextField {
    var onWrite: (() -> Void)?
    override func setAccessibilityValue(_ accessibilityValue: Any?) {
        if let value = accessibilityValue as? String { stringValue = value }
        onWrite?()
    }
}
final class FixtureDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var radios: [NSButton] = []
    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 180, y: 180, width: 480, height: 220),
                          styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "macuse disposable actuator fixture"
        window.isReleasedWhenClosed = false
        let stack = NSStackView()
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        for title in ["CPU", "Memory", "Energy"] {
            let button = NSButton(radioButtonWithTitle: title, target: self, action: #selector(selectTab(_:)))
            button.state = title == "Energy" ? .on : .off
            radios.append(button); stack.addArrangedSubview(button)
        }
        let field = NSTextField(string: "prefix ORIGINAL suffix")
        field.setAccessibilityIdentifier("macuse-fixture-field")
        field.widthAnchor.constraint(equalToConstant: 420).isActive = true
        stack.addArrangedSubview(field)
        let changing = ContextChangingField(string: "postwrite ORIGINAL")
        changing.setAccessibilityIdentifier("macuse-fixture-context-field")
        changing.widthAnchor.constraint(equalToConstant: 420).isActive = true
        changing.onWrite = { [weak self] in
            guard let self, let cpu = self.radios.first else { return }
            self.selectTab(cpu)
        }
        stack.addArrangedSubview(changing)
        window.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 24),
                                     stack.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 20)])
        window.orderFront(nil)
        print("{\"ready\":true,\"pid\":\(ProcessInfo.processInfo.processIdentifier)}")
        fflush(stdout)
    }
    @objc func selectTab(_ sender: NSButton) { for button in radios { button.state = button === sender ? .on : .off } }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
let app = NSApplication.shared
let delegate = FixtureDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
