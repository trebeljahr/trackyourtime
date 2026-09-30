#if !targetEnvironment(simulator)
#error("UI QA must only run in Simulator")
#endif
import XCTest

final class IPadUITests: XCTestCase {
    let app = XCUIApplication(bundleIdentifier: "com.ricoslabs.trackyourtime.simulatorqa")
    var config: [String: String] = [:]
    var lastState: [String: Any] = [:]

    override func setUpWithError() throws {
        continueAfterFailure = false
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "qa-config", withExtension: "json"))
        config = try JSONDecoder().decode([String: String].self, from: Data(contentsOf: url))
        XCUIDevice.shared.orientation = .portrait
        app.launchEnvironment["QA_UI_TESTS"] = "1"
        app.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()
        try waitState("login or existing session", timeout: 45) {
            ($0["url"] as? String ?? "").hasPrefix("/login") || self.element("tracker-toggle", in: $0) != nil
        }
        if (lastState["url"] as? String)?.hasPrefix("/login") == true {
            try tap("server-picker-toggle")
            try tap("server-picker-own")
            try enter("server-picker-address", config["origin"]!)
            hideKeyboard()
            try tap("server-picker-save")
            try waitState("local server selected") { state in
                self.element("server-picker-current", in: state)?["text"] as? String == self.config["origin"]?.replacingOccurrences(of: "http://", with: "") ||
                (self.element("server-picker-current", in: state)?["text"] as? String ?? "").contains("127.0.0.1")
            }
            try enter("login-email", config["email"]!)
            try enter("login-password", config["password"]!)
            hideKeyboard()
            try tap("login-submit")
        }
        try waitState("signed-in tracker", timeout: 45) { self.element("tracker-toggle", in: $0) != nil }
        try assertLayout("signed-in-portrait")
        // Keep tests independent when a previous scenario failed with a timer running.
        if element("tracker-toggle", in: lastState)?["state"] as? String == "running" {
            try tap("tracker-toggle")
            try waitState("reset previous timer") { self.element("tracker-toggle", in: $0)?["state"] as? String == "idle" }
        }
    }

    override func tearDownWithError() throws {
        attach("final-state")
        app.terminate()
        XCUIDevice.shared.orientation = .portrait
    }

    func state() -> [String: Any]? {
        let element = app.descendants(matching: .any).matching(identifier: "qa-state").firstMatch
        guard element.exists, let text = element.value as? String,
              let data = text.data(using: .utf8),
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        lastState = value
        return value
    }

    func waitState(_ description: String, timeout: TimeInterval = 20, _ condition: @escaping ([String: Any]) -> Bool) throws {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            guard let value = self.state() else { return false }
            return condition(value)
        }, object: nil)
        let result = XCTWaiter.wait(for: [expectation], timeout: timeout)
        if result != .completed { attach("failed-" + description) }
        XCTAssertEqual(result, .completed, description)
        if result != .completed { throw NSError(domain: description, code: 1) }
    }

    func element(_ id: String, in state: [String: Any]) -> [String: Any]? {
        (state["elements"] as? [[String: Any]])?.first {
            ($0["id"] as? String ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/")) == id.trimmingCharacters(in: CharacterSet(charactersIn: "/")) && ($0["width"] as? Double ?? 0) > 0 && ($0["height"] as? Double ?? 0) > 0
        }
    }

    func tap(_ id: String) throws {
        try waitState("hittable " + id) { state in
            guard let e = self.element(id, in: state) else { return false }
            let y = e["y"] as? Double ?? -1
            return e["disabled"] as? Bool != true && y >= 0 && y + (e["height"] as? Double ?? 0) <= (state["height"] as? Double ?? 0)
        }
        let e = try XCTUnwrap(element(id, in: lastState))
        let web = app.webViews.firstMatch
        let scale = web.frame.width / (lastState["width"] as! Double)
        let x = ((e["x"] as! Double) + (e["width"] as! Double) / 2) * scale
        let y = ((e["y"] as! Double) + (e["height"] as! Double) / 2) * scale
        web.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y)).tap()
    }

    func navigate(_ name: String) throws {
        let choices = ["tab-" + name, "nav-" + name]
        try waitState("visible navigation to " + name) { state in
            choices.contains { self.element($0, in: state) != nil }
        }
        let id = try XCTUnwrap(choices.first { element($0, in: lastState) != nil })
        try tap(id)
    }

    func enter(_ id: String, _ text: String) throws {
        try tap(id)
        app.typeText(text)
    }

    func hideKeyboard() {
        let hide = app.keyboards.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'Hide keyboard'")).firstMatch
        if hide.waitForExistence(timeout: 2) { hide.tap() }
    }

    func attach(_ name: String) {
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = name
        screenshot.lifetime = .keepAlways
        add(screenshot)
        if let data = try? JSONSerialization.data(withJSONObject: lastState, options: [.prettyPrinted, .sortedKeys]) {
            let evidence = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
            evidence.name = name + ".json"
            evidence.lifetime = .keepAlways
            add(evidence)
        }
        let tree = XCTAttachment(string: app.debugDescription)
        tree.name = name + "-accessibility"
        tree.lifetime = .keepAlways
        add(tree)
    }

    func assertLayout(_ name: String) throws {
        try waitState("settled layout") { ($0["width"] as? Double ?? 0) > 0 }
        XCTAssertLessThanOrEqual(lastState["scrollWidth"] as! Double, (lastState["width"] as! Double) + 1)
        XCTAssertEqual((lastState["errors"] as? [String]) ?? ["missing errors"], [])
        XCTAssertEqual(lastState["scale"] as? Double, 1)
        attach(name)
    }

    func testLandscapeNavigationAndTimer() throws {
        XCUIDevice.shared.orientation = .landscapeLeft
        try waitState("landscape viewport") { ($0["width"] as? Double ?? 0) > ($0["height"] as? Double ?? 0) }
        try assertLayout("landscape-tracker")
        try enter("tracker-description", "XCUITest landscape timer")
        hideKeyboard()
        try tap("tracker-toggle")
        try waitState("running timer") { self.element("tracker-toggle", in: $0)?["state"] as? String == "running" }
        try navigate("reports")
        try waitState("reports navigation") { ($0["url"] as? String ?? "").hasPrefix("/app/reports") }
        try assertLayout("landscape-reports")
        try navigate("track")
        try waitState("timer survives navigation") { self.element("tracker-toggle", in: $0)?["state"] as? String == "running" }
        app.terminate()
        app.launch()
        try waitState("timer survives relaunch", timeout: 45) { self.element("tracker-toggle", in: $0)?["state"] as? String == "running" }
        try tap("tracker-toggle")
        try waitState("stopped timer") { self.element("tracker-toggle", in: $0)?["state"] as? String == "idle" }
        try assertLayout("landscape-stopped")
    }

    func testWindowResizingPreservesTimer() throws {
        XCUIDevice.shared.orientation = .landscapeLeft
        try waitState("landscape viewport") { ($0["width"] as? Double ?? 0) > ($0["height"] as? Double ?? 0) }
        try enter("tracker-description", "XCUITest resized timer")
        hideKeyboard()
        try tap("tracker-toggle")
        try waitState("running before resize") { self.element("tracker-toggle", in: $0)?["state"] as? String == "running" }
        let originalWidth = lastState["width"] as! Double
        let originalHeight = lastState["height"] as! Double
        attach("before-window-resize")
        // iPadOS window handle, not the host Simulator window or CSS viewport.
        let window = app.windows.firstMatch
        window.coordinate(withNormalizedOffset: CGVector(dx: 0.985, dy: 0.985))
            .press(forDuration: 0.2, thenDragTo: window.coordinate(withNormalizedOffset: CGVector(dx: 0.65, dy: 0.7)))
        try waitState("native window must change viewport dimensions") { state in
            abs((state["width"] as? Double ?? originalWidth) - originalWidth) > 60 ||
            abs((state["height"] as? Double ?? originalHeight) - originalHeight) > 60
        }
        XCTAssertEqual(element("tracker-toggle", in: lastState)?["state"] as? String, "running")
        try assertLayout("resized-running")
        try tap("tracker-toggle")
        try waitState("stopped in resized window") { self.element("tracker-toggle", in: $0)?["state"] as? String == "idle" }
        try assertLayout("resized-stopped")
        let narrowWidth = lastState["width"] as! Double
        let narrowHeight = lastState["height"] as! Double
        let desktop = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        window.coordinate(withNormalizedOffset: CGVector(dx: 0.985, dy: 0.985))
            .press(forDuration: 0.2, thenDragTo: desktop.coordinate(withNormalizedOffset: CGVector(dx: 0.985, dy: 0.985)))
        try waitState("expand native window") {
            ($0["width"] as? Double ?? 0) > narrowWidth + 60 || ($0["height"] as? Double ?? 0) > narrowHeight + 60
        }
        try assertLayout("expanded-stopped")
    }
}
