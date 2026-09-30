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
    private let uiState = UIView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
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
        if ProcessInfo.processInfo.environment["QA_UI_TESTS"] == "1" {
            uiState.isAccessibilityElement = true
            uiState.accessibilityIdentifier = "qa-state"
            uiState.accessibilityLabel = "Read-only QA diagnostics"
            uiState.isUserInteractionEnabled = false
            view.addSubview(uiState)
            qaTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in self?.reportUIState() }
            return
        }
        qaTimer = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { [weak self] _ in self?.pollCommand() }
    }
    // Read-only geometry/state for native XCUITest assertions and tap targeting.
    // All input, navigation and window changes are performed by XCUIAutomation.
    private func reportUIState() {
        guard !busy, let webView = webView else { return }
        busy = true
        let script = """
        const elements = [...document.querySelectorAll('[data-testid],a[href]')].map(e => {
          const r=e.getBoundingClientRect();
          return {id:e.dataset.testid || 'link:'+new URL(e.href).pathname,
            x:r.x,y:r.y,width:r.width,height:r.height,disabled:!!e.disabled,
            state:e.dataset.state || '',text:e.innerText || '',
            value:e.type==='password' ? '[redacted]' : (e.value || '')};
        });
        return {url:location.pathname,width:innerWidth,height:innerHeight,
          scrollWidth:document.documentElement.scrollWidth,scale:visualViewport.scale,
          errors:window.__qaErrors || [],elements};
        """
        webView.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { [weak self] result in
            defer { self?.busy = false }
            guard case .success(let value) = result, var state = value as? [String: Any] else { return }
            let frame = webView.convert(webView.bounds, to: nil)
            state["webView"] = ["x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height]
            if let json = try? JSONSerialization.data(withJSONObject: state, options: [.sortedKeys]),
               let text = String(data: json, encoding: .utf8) {
                self?.uiState.accessibilityValue = text
            }
        }
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
