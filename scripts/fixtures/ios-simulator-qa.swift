// Appended only to a temporary simulator project by ios-simulator-smoke.mjs.
// The shipping project never compiles this file or links this fake store.
#if !targetEnvironment(simulator)
#error("The QA bridge must never be built for a physical device")
#endif
import WebKit

@objc(QASecureStorage)
class QASecureStorage: CAPPlugin, CAPBridgedPlugin {
    let identifier = "QASecureStorage"
    let jsName = "SecureStorage"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setSynchronizeKeychain", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "internalGetItem", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "internalSetItem", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "internalRemoveItem", returnType: CAPPluginReturnPromise)
    ]
    // Test values only, inside this throwaway app's container. No Security API.
    private let defaults = UserDefaults.standard
    private func key(_ call: CAPPluginCall) -> String { "qa.fake." + (call.getString("prefixedKey") ?? "") }
    @objc func setSynchronizeKeychain(_ call: CAPPluginCall) { call.resolve() }
    @objc func internalGetItem(_ call: CAPPluginCall) { call.resolve(["data": defaults.string(forKey: key(call)) as Any? ?? NSNull()]) }
    @objc func internalSetItem(_ call: CAPPluginCall) {
        defaults.set(call.getString("data"), forKey: key(call))
        call.resolve()
    }
    @objc func internalRemoveItem(_ call: CAPPluginCall) {
        defaults.removeObject(forKey: key(call))
        call.resolve(["success": true])
    }
}

@objc(QABridgeViewController)
class QABridgeViewController: CAPBridgeViewController {
    private var qaTimer: Timer?
    private var busy = false
    private var lastID = ""
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(QASecureStorage())
        let source = """
        window.__qaErrors = [];
        addEventListener('error', e => window.__qaErrors.push(e.message));
        addEventListener('unhandledrejection', e => window.__qaErrors.push(String(e.reason)));
        addEventListener('securitypolicyviolation', e => window.__qaErrors.push('CSP: '+e.violatedDirective));
        """
        webView?.configuration.userContentController.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        qaTimer = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { [weak self] _ in self?.pollCommand() }
    }
    private func pollCommand() {
        guard !busy, let webView = webView else { return }
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        guard let data = try? Data(contentsOf: dir.appendingPathComponent("qa-command.json")),
              let command = (try? JSONSerialization.jsonObject(with: data)) as? [String: String],
              let id = command["id"], let script = command["script"], id != lastID else { return }
        try? FileManager.default.removeItem(at: dir.appendingPathComponent("qa-command.json"))
        lastID = id
        busy = true
        webView.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { [weak self] result in
            let response: [String: Any]
            switch result {
            case .success(let value): response = ["id": id, "value": value ?? NSNull()]
            case .failure(let error): response = ["id": id, "error": error.localizedDescription]
            }
            if let json = try? JSONSerialization.data(withJSONObject: response, options: [.sortedKeys]) {
                try? json.write(to: dir.appendingPathComponent("qa-result.json"), options: .atomic)
            }
            self?.busy = false
        }
    }
}
