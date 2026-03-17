import Cocoa
import ApplicationServices

// MARK: - Terse AX Helper
// check            — is accessibility trusted?
// pick             — wait for user to click another app, return element info
// read-at X Y      — read element at screen coords
// read-pid PID     — read focused element of app
// write-pid PID    — set focused element value (text from stdin)

let args = CommandLine.arguments

func json(_ d: [String: Any]) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: d),
          let s = String(data: data, encoding: .utf8) else { return "{\"ok\":false}" }
    return s
}

func elementInfo(_ el: AXUIElement) -> [String: Any] {
    var info: [String: Any] = [:]
    var r: CFTypeRef?
    if AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &r) == .success {
        info["role"] = r as? String ?? ""
    }
    var v: CFTypeRef?
    if AXUIElementCopyAttributeValue(el, kAXValueAttribute as CFString, &v) == .success {
        info["value"] = v as? String ?? ""
    }
    var pos: CFTypeRef?
    if AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &pos) == .success, let pv = pos {
        var p = CGPoint.zero; AXValueGetValue(pv as! AXValue, .cgPoint, &p)
        info["x"] = p.x; info["y"] = p.y
    }
    var sz: CFTypeRef?
    if AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &sz) == .success, let sv = sz {
        var s = CGSize.zero; AXValueGetValue(sv as! AXValue, .cgSize, &s)
        info["width"] = s.width; info["height"] = s.height
    }
    return info
}

func findTextElement(_ el: AXUIElement, depth: Int = 0) -> AXUIElement? {
    if depth > 10 { return nil }
    var r: CFTypeRef?
    AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &r)
    let role = r as? String ?? ""
    if ["AXTextArea", "AXTextField", "AXTextView"].contains(role) { return el }
    // For AXWebArea, look deeper for actual text inputs inside it
    var ch: CFTypeRef?
    if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &ch) == .success,
       let kids = ch as? [AXUIElement] {
        for kid in kids {
            if let found = findTextElement(kid, depth: depth + 1) { return found }
        }
    }
    return nil
}

/// Find the best text element: prefer one with non-empty AXValue
func findBestTextElement(_ el: AXUIElement, depth: Int = 0) -> AXUIElement? {
    if depth > 10 { return nil }
    var r: CFTypeRef?
    AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &r)
    let role = r as? String ?? ""
    if ["AXTextArea", "AXTextField", "AXTextView"].contains(role) {
        var v: CFTypeRef?
        if AXUIElementCopyAttributeValue(el, kAXValueAttribute as CFString, &v) == .success,
           let s = v as? String, !s.isEmpty {
            return el
        }
        return el // return even if empty — it's a text element
    }
    var ch: CFTypeRef?
    if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &ch) == .success,
       let kids = ch as? [AXUIElement] {
        var fallback: AXUIElement? = nil
        for kid in kids {
            if let found = findBestTextElement(kid, depth: depth + 1) {
                // Check if it has content
                var v: CFTypeRef?
                if AXUIElementCopyAttributeValue(found, kAXValueAttribute as CFString, &v) == .success,
                   let s = v as? String, !s.isEmpty {
                    return found
                }
                if fallback == nil { fallback = found }
            }
        }
        return fallback
    }
    return nil
}

func elAtPoint(_ x: Float, _ y: Float) -> AXUIElement? {
    let sys = AXUIElementCreateSystemWide()
    var el: AXUIElement?
    return AXUIElementCopyElementAtPosition(sys, x, y, &el) == .success ? el : nil
}

func focusedOf(_ pid: pid_t) -> AXUIElement? {
    let app = AXUIElementCreateApplication(pid)
    var f: CFTypeRef?
    if AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute as CFString, &f) == .success {
        return (f as! AXUIElement)
    }
    let sys = AXUIElementCreateSystemWide()
    var sf: CFTypeRef?
    if AXUIElementCopyAttributeValue(sys, kAXFocusedUIElementAttribute as CFString, &sf) == .success {
        return (sf as! AXUIElement)
    }
    return nil
}

guard args.count >= 2 else { print(json(["error":"usage"])); exit(1) }

switch args[1] {

case "check":
    let t = AXIsProcessTrusted()
    if !t {
        let opts = [kAXTrustedCheckOptionPrompt.takeRetainedValue(): true] as CFDictionary
        AXIsProcessTrustedWithOptions(opts)
    }
    print(json(["trusted": t]))

case "pick":
    guard AXIsProcessTrusted() else { print(json(["ok":false,"error":"not_trusted"])); exit(0) }
    let startPID = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
    fputs("{\"status\":\"waiting\"}\n", stdout)
    fflush(stdout)

    var waited = 0.0
    while waited < 30.0 {
        Thread.sleep(forTimeInterval: 0.12)
        waited += 0.12
        guard let cur = NSWorkspace.shared.frontmostApplication else { continue }
        if cur.processIdentifier != startPID {
            Thread.sleep(forTimeInterval: 0.4)
            let m = NSEvent.mouseLocation
            let h = NSScreen.main!.frame.height
            let ax = Float(m.x), ay = Float(h - m.y)

            if let el = elAtPoint(ax, ay) {
                let textEl = findTextElement(el) ?? el
                var info = elementInfo(textEl)
                info["ok"] = true
                info["app"] = cur.localizedName ?? "?"
                info["pid"] = cur.processIdentifier
                if info["x"] == nil { info["x"] = Double(ax) }
                if info["y"] == nil { info["y"] = Double(ay) }
                print(json(info))
            } else {
                print(json(["ok":true, "app": cur.localizedName ?? "?", "pid": cur.processIdentifier,
                           "value":"", "role":"unknown", "x":Double(ax), "y":Double(ay), "width":600, "height":200]))
            }
            exit(0)
        }
    }
    print(json(["ok":false, "error":"timeout"]))

case "read-at":
    guard AXIsProcessTrusted(), args.count >= 4,
          let x = Float(args[2]), let y = Float(args[3]) else {
        print(json(["ok":false, "error":"bad_args"])); exit(0)
    }
    let app = NSWorkspace.shared.frontmostApplication
    if let el = elAtPoint(x, y) {
        let textEl = findTextElement(el) ?? el
        var info = elementInfo(textEl)
        info["ok"] = true
        info["app"] = app?.localizedName ?? "?"
        info["pid"] = app?.processIdentifier ?? 0
        print(json(info))
    } else {
        print(json(["ok":false, "error":"no_element"]))
    }

case "read-pid":
    guard AXIsProcessTrusted(), args.count >= 3, let pid = Int32(args[2]) else {
        print(json(["ok":false, "error":"bad_args"])); exit(0)
    }
    if let el = focusedOf(pid) {
        var info = elementInfo(el)
        info["ok"] = true
        print(json(info))
    } else {
        print(json(["ok":false, "error":"no_focused"]))
    }

case "read-app":
    // Read the best text element from an app — tries focused element first,
    // then walks the window tree. Optionally takes x,y hint for position-based lookup.
    guard AXIsProcessTrusted(), args.count >= 3, let pid = Int32(args[2]) else {
        print(json(["ok":false, "error":"bad_args"])); exit(0)
    }
    // Strategy 1: focused element
    if let el = focusedOf(pid) {
        var r: CFTypeRef?
        AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &r)
        let role = r as? String ?? ""
        if ["AXTextArea", "AXTextField", "AXTextView"].contains(role) {
            var info = elementInfo(el)
            info["ok"] = true
            info["strategy"] = "focused"
            print(json(info)); exit(0)
        }
        // Maybe focused element contains a text child
        if let textEl = findBestTextElement(el) {
            var info = elementInfo(textEl)
            info["ok"] = true
            info["strategy"] = "focused-child"
            print(json(info)); exit(0)
        }
    }
    // Strategy 2: position-based (if x,y provided)
    if args.count >= 5, let x = Float(args[3]), let y = Float(args[4]) {
        if let el = elAtPoint(x, y) {
            if let textEl = findBestTextElement(el) {
                var info = elementInfo(textEl)
                info["ok"] = true
                info["strategy"] = "position"
                print(json(info)); exit(0)
            }
        }
    }
    // Strategy 3: walk the app's window tree — prefer AXTextArea over AXTextField
    let appEl = AXUIElementCreateApplication(pid)
    var wins: CFTypeRef?
    if AXUIElementCopyAttributeValue(appEl, kAXWindowsAttribute as CFString, &wins) == .success,
       let winList = wins as? [AXUIElement] {
        var bestTextField: AXUIElement? = nil
        for win in winList.prefix(3) {
            if let textEl = findBestTextElement(win) {
                var r: CFTypeRef?
                AXUIElementCopyAttributeValue(textEl, kAXRoleAttribute as CFString, &r)
                let role = r as? String ?? ""
                if role == "AXTextArea" || role == "AXTextView" {
                    var info = elementInfo(textEl)
                    info["ok"] = true
                    info["strategy"] = "window-walk"
                    print(json(info)); exit(0)
                }
                if bestTextField == nil { bestTextField = textEl }
            }
        }
        if let tf = bestTextField {
            var info = elementInfo(tf)
            info["ok"] = true
            info["strategy"] = "window-walk"
            print(json(info)); exit(0)
        }
    }
    print(json(["ok":false, "error":"no_text_element"]))

case "write-pid":
    guard AXIsProcessTrusted(), args.count >= 3, let pid = Int32(args[2]) else {
        print(json(["ok":false, "error":"bad_args"])); exit(0)
    }
    var text = ""
    while let line = readLine(strippingNewline: false) { text += line }

    if let el = focusedOf(pid) {
        let r = AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, text as CFTypeRef)
        if r == .success {
            print(json(["ok":true, "method":"AXValue"]))
            exit(0)
        }
    }
    // Fallback: activate app, Cmd+A, Cmd+V
    if let app = NSRunningApplication(processIdentifier: pid) {
        app.activate(options: .activateIgnoringOtherApps)
        Thread.sleep(forTimeInterval: 0.3)
    }
    let pb = NSPasteboard.general; pb.clearContents(); pb.setString(text, forType: .string)
    let src = CGEventSource(stateID: .hidSystemState)
    // Cmd+A
    let ad = CGEvent(keyboardEventSource: src, virtualKey: 0x00, keyDown: true)!; ad.flags = .maskCommand
    let au = CGEvent(keyboardEventSource: src, virtualKey: 0x00, keyDown: false)!; au.flags = .maskCommand
    ad.post(tap: .cghidEventTap); au.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.1)
    // Cmd+V
    let vd = CGEvent(keyboardEventSource: src, virtualKey: 0x09, keyDown: true)!; vd.flags = .maskCommand
    let vu = CGEvent(keyboardEventSource: src, virtualKey: 0x09, keyDown: false)!; vu.flags = .maskCommand
    vd.post(tap: .cghidEventTap); vu.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.1)
    print(json(["ok":true, "method":"paste"]))

case "spellcheck":
    // Read text from stdin, correct all misspellings using macOS NSSpellChecker
    var text = ""
    while let line = readLine(strippingNewline: false) { text += line }

    let checker = NSSpellChecker.shared
    let corrected = NSMutableString(string: text)
    var searchRange = NSRange(location: 0, length: corrected.length)
    var corrections: [[String: Any]] = []

    while searchRange.location < corrected.length {
        let misspelled = checker.checkSpelling(
            of: corrected as String,
            startingAt: searchRange.location,
            language: nil,  // auto-detect language
            wrap: false,
            inSpellDocumentWithTag: 0,
            wordCount: nil
        )
        if misspelled.location == NSNotFound { break }

        let word = corrected.substring(with: misspelled)
        if let correction = checker.correction(
            forWordRange: misspelled,
            in: corrected as String,
            language: checker.language(),
            inSpellDocumentWithTag: 0
        ) {
            corrections.append(["from": word, "to": correction, "at": misspelled.location])
            corrected.replaceCharacters(in: misspelled, with: correction)
            // Adjust search range for the replacement length difference
            let diff = correction.count - word.count
            searchRange = NSRange(location: misspelled.location + correction.count, length: corrected.length - misspelled.location - correction.count)
        } else {
            // No correction available, skip this word
            searchRange = NSRange(location: misspelled.location + misspelled.length, length: corrected.length - misspelled.location - misspelled.length)
        }
    }

    print(json(["ok": true, "corrected": corrected as String, "count": corrections.count]))

case "focus-check":
    // Fast check: is the focused element a text input? Returns role only, no text reading.
    guard AXIsProcessTrusted(), args.count >= 3, let pid = Int32(args[2]) else {
        print(json(["ok":false, "error":"bad_args"])); exit(0)
    }
    if let el = focusedOf(pid) {
        var r: CFTypeRef?
        AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &r)
        let role = r as? String ?? ""
        let isText = ["AXTextArea", "AXTextField", "AXTextView", "AXComboBox"].contains(role)
        if isText {
            print(json(["ok":true, "isTextInput":true, "role":role]))
            exit(0)
        }
        // Check if focused element CONTAINS a text child (e.g. AXWebArea with a focused textarea inside)
        if let textChild = findTextElement(el) {
            var cr: CFTypeRef?
            AXUIElementCopyAttributeValue(textChild, kAXRoleAttribute as CFString, &cr)
            let childRole = cr as? String ?? ""
            print(json(["ok":true, "isTextInput":true, "role":childRole, "strategy":"child"]))
            exit(0)
        }
        // Check if this is AXWebArea or AXGroup — might have a focused text element we missed
        // Try the system-wide focused element as backup
        let sys = AXUIElementCreateSystemWide()
        var sf: CFTypeRef?
        if AXUIElementCopyAttributeValue(sys, kAXFocusedUIElementAttribute as CFString, &sf) == .success {
            let sysEl = sf as! AXUIElement
            var sr: CFTypeRef?
            AXUIElementCopyAttributeValue(sysEl, kAXRoleAttribute as CFString, &sr)
            let sysRole = sr as? String ?? ""
            if ["AXTextArea", "AXTextField", "AXTextView", "AXComboBox"].contains(sysRole) {
                print(json(["ok":true, "isTextInput":true, "role":sysRole, "strategy":"system"]))
                exit(0)
            }
        }
        print(json(["ok":true, "isTextInput":false, "role":role]))
    } else {
        print(json(["ok":false, "isTextInput":false, "error":"no_focused"]))
    }

case "dump-text":
    // Dump all text elements in an app's window tree (for debugging)
    guard AXIsProcessTrusted(), args.count >= 3, let pid = Int32(args[2]) else {
        print(json(["ok":false, "error":"bad_args"])); exit(0)
    }
    let dumpApp = AXUIElementCreateApplication(pid)
    var dumpWins: CFTypeRef?
    var found: [[String: Any]] = []
    func dumpWalk(_ el: AXUIElement, _ depth: Int, _ path: String) {
        if depth > 15 { return }
        var r: CFTypeRef?
        AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &r)
        let role = r as? String ?? ""
        if ["AXTextArea", "AXTextField", "AXTextView", "AXWebArea", "AXStaticText"].contains(role) {
            var entry: [String: Any] = ["role": role, "depth": depth, "path": path]
            var v: CFTypeRef?
            if AXUIElementCopyAttributeValue(el, kAXValueAttribute as CFString, &v) == .success {
                let val = v as? String ?? ""
                entry["value"] = String(val.prefix(200))
                entry["valueLen"] = val.count
            }
            var pos: CFTypeRef?
            if AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &pos) == .success, let pv = pos {
                var p = CGPoint.zero; AXValueGetValue(pv as! AXValue, .cgPoint, &p)
                entry["x"] = p.x; entry["y"] = p.y
            }
            var sz: CFTypeRef?
            if AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &sz) == .success, let sv = sz {
                var s = CGSize.zero; AXValueGetValue(sv as! AXValue, .cgSize, &s)
                entry["w"] = s.width; entry["h"] = s.height
            }
            found.append(entry)
        }
        var ch: CFTypeRef?
        if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &ch) == .success,
           let kids = ch as? [AXUIElement] {
            for (i, kid) in kids.enumerated() {
                dumpWalk(kid, depth + 1, "\(path)/\(role)[\(i)]")
            }
        }
    }
    if AXUIElementCopyAttributeValue(dumpApp, kAXWindowsAttribute as CFString, &dumpWins) == .success,
       let winList = dumpWins as? [AXUIElement] {
        for (wi, win) in winList.prefix(3).enumerated() {
            dumpWalk(win, 0, "win[\(wi)]")
        }
    }
    print(json(["ok": true, "count": found.count, "elements": found]))

case "key-monitor":
    // Monitor keystrokes for a target app using CGEventTap.
    // Builds a text buffer — zero flash, zero clipboard, zero osascript.
    // Outputs JSON lines on stdout every 300ms when buffer changes.
    // Buffer resets on Enter (prompt submitted) or Escape.
    //
    // ACTIVE TAP: can suppress user keystrokes during writes.
    // Accepts stdin commands:
    //   {"cmd":"write","text":"..."} — atomically clear input + paste via CGEvents,
    //     suppressing user keystrokes and replaying them after.
    guard AXIsProcessTrusted(), args.count >= 3, let monPid = Int32(args[2]) else {
        print(json(["ok":false, "error":"bad_args"])); exit(0)
    }

    final class KMState {
        var buffer = ""
        var changed = false
        var targetPid: Int32
        var suppressing = false
        var suppressStart: Date?
        var pendingChars = ""
        var sendMode = false // "Send" mode: intercept Enter, let JS optimize first
        let lock = NSLock()
        static let magic: Int64 = 0x54455253 // "TERS" — tags our synthetic events
        init(pid: Int32) { self.targetPid = pid }
    }
    let kmState = KMState(pid: monPid)
    let kmPtr = Unmanaged.passRetained(kmState).toOpaque()

    // Key codes
    let kVK_E: UInt16      = 0x0E
    let kVK_U: UInt16      = 0x20
    let kVK_V: UInt16      = 0x09
    let kVK_Delete: UInt16 = 0x33
    let kVK_Return: UInt16 = 0x24

    let kmMask: CGEventMask = (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.keyUp.rawValue)
    guard let kmTap = CGEvent.tapCreate(
        tap: .cgSessionEventTap,
        place: .tailAppendEventTap,
        options: .defaultTap,
        eventsOfInterest: kmMask,
        callback: { (_, eventType, event, refcon) -> Unmanaged<CGEvent>? in
            guard let refcon = refcon else { return Unmanaged.passUnretained(event) }
            let st = Unmanaged<KMState>.fromOpaque(refcon).takeUnretainedValue()

            // Our own synthetic events — always pass through, never modify buffer
            if event.getIntegerValueField(.eventSourceUserData) == KMState.magic {
                return Unmanaged.passUnretained(event)
            }

            // Only track when target app is frontmost
            guard let front = NSWorkspace.shared.frontmostApplication,
                  front.processIdentifier == st.targetPid else {
                return Unmanaged.passUnretained(event)
            }

            // Safety: auto-disable suppression after 500ms
            st.lock.lock()
            let isSuppressing = st.suppressing
            if isSuppressing, let start = st.suppressStart, Date().timeIntervalSince(start) > 0.5 {
                st.suppressing = false
                st.lock.unlock()
                return Unmanaged.passUnretained(event)
            }
            st.lock.unlock()

            // During suppress: eat user keystrokes, buffer printable chars
            if isSuppressing {
                if eventType == .keyDown {
                    let flags = event.flags
                    var len = 0
                    var chars = [UniChar](repeating: 0, count: 4)
                    event.keyboardGetUnicodeString(maxStringLength: 4, actualStringLength: &len, unicodeString: &chars)
                    if len > 0 && !flags.contains(.maskControl) && !flags.contains(.maskCommand) {
                        st.lock.lock()
                        st.pendingChars += String(utf16CodeUnits: chars, count: len)
                        st.lock.unlock()
                    }
                }
                return nil // suppress
            }

            // keyUp in normal mode — pass through, no processing
            if eventType == .keyUp { return Unmanaged.passUnretained(event) }

            let flags = event.flags
            let keyCode = event.getIntegerValueField(.keyboardEventKeycode)

            // Ignore Cmd shortcuts (Cmd+C, Cmd+V, etc)
            if flags.contains(.maskCommand) { return Unmanaged.passUnretained(event) }

            var len = 0
            var chars = [UniChar](repeating: 0, count: 4)
            event.keyboardGetUnicodeString(maxStringLength: 4, actualStringLength: &len, unicodeString: &chars)

            st.lock.lock()
            if keyCode == 51 { // Backspace
                if !st.buffer.isEmpty { st.buffer.removeLast() }
            } else if keyCode == 36 || keyCode == 76 { // Enter/Return
                let inSendMode = st.sendMode
                let text = st.buffer
                st.lock.unlock()

                if inSendMode && !text.isEmpty {
                    // Quick AX check: if focused element is AXTextField (URL bar, search bar),
                    // let Enter through — only suppress for AXTextArea (chat inputs)
                    let sys = AXUIElementCreateSystemWide()
                    var focRef: CFTypeRef?
                    var isTextField = false
                    if AXUIElementCopyAttributeValue(sys, kAXFocusedUIElementAttribute as CFString, &focRef) == .success {
                        let focEl = focRef as! AXUIElement
                        var roleRef: CFTypeRef?
                        AXUIElementCopyAttributeValue(focEl, kAXRoleAttribute as CFString, &roleRef)
                        let role = roleRef as? String ?? ""
                        if role == "AXTextField" || role == "AXComboBox" {
                            isTextField = true
                        }
                    }

                    if isTextField {
                        // URL bar / search bar — clear buffer and let Enter through
                        st.lock.lock()
                        st.buffer = ""
                        st.lock.unlock()
                        st.changed = true
                        return Unmanaged.passUnretained(event)
                    }

                    // Send mode: suppress Enter, report to JS for optimization
                    let escaped = text.replacingOccurrences(of: "\\", with: "\\\\")
                        .replacingOccurrences(of: "\"", with: "\\\"")
                        .replacingOccurrences(of: "\n", with: "\\n")
                    DispatchQueue.global().async {
                        fputs("{\"enter\":true,\"text\":\"\(escaped)\"}\n", stdout)
                        fflush(stdout)
                    }
                    return nil // suppress Enter
                }
                // Normal mode: clear buffer, pass through
                st.lock.lock()
                st.buffer = ""
                st.lock.unlock()
                st.changed = true
                return Unmanaged.passUnretained(event)
            } else if keyCode == 53 { // Escape
                st.buffer = ""
            } else if len > 0 && !flags.contains(.maskControl) {
                st.buffer += String(utf16CodeUnits: chars, count: len)
            }
            st.lock.unlock()
            st.changed = true

            return Unmanaged.passUnretained(event)
        },
        userInfo: kmPtr
    ) else {
        print(json(["ok":false, "error":"tap_failed"]))
        exit(1)
    }

    let kmSrc = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, kmTap, 0)
    CFRunLoopAddSource(CFRunLoopGetCurrent(), kmSrc, .commonModes)
    CGEvent.tapEnable(tap: kmTap, enable: true)

    fputs("{\"ok\":true,\"monitoring\":true}\n", stdout)
    fflush(stdout)

    // Helper: post a tagged key event (our magic userData so tap passes it through)
    func postKey(_ code: UInt16, down: Bool, ctrl: Bool = false, cmd: Bool = false) {
        let src = CGEventSource(stateID: .combinedSessionState)
        guard let ev = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down) else { return }
        var f = CGEventFlags()
        if ctrl { f.insert(.maskControl) }
        if cmd  { f.insert(.maskCommand) }
        ev.flags = f
        ev.setIntegerValueField(.eventSourceUserData, value: KMState.magic)
        ev.post(tap: .cghidEventTap)
    }

    // Read commands from stdin (write commands for atomic replace)
    DispatchQueue.global().async {
        while let line = readLine() {
            guard !line.isEmpty,
                  let data = line.data(using: .utf8),
                  let cmd = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let action = cmd["cmd"] as? String else { continue }

            if action == "set-send-mode" {
                let on = cmd["on"] as? Bool ?? false
                kmState.lock.lock()
                kmState.sendMode = on
                kmState.lock.unlock()
                fputs("{\"sendMode\":\(on)}\n", stdout)
                fflush(stdout)
                continue
            }

            if action == "enter" {
                // Post a tagged Enter keypress
                postKey(kVK_Return, down: true)
                postKey(kVK_Return, down: false)
                // Clear buffer (prompt submitted)
                kmState.lock.lock()
                kmState.buffer = ""
                kmState.changed = true
                kmState.lock.unlock()
                fputs("{\"enterSent\":true}\n", stdout)
                fflush(stdout)
                continue
            }

            if action == "write", let text = cmd["text"] as? String {
                // Clipboard is managed by the JS side (save/restore).
                // We just set it to the new text, clear input, and paste.
                let pb = NSPasteboard.general

                // Start suppressing user keystrokes
                kmState.lock.lock()
                kmState.suppressing = true
                kmState.suppressStart = Date()
                kmState.pendingChars = ""
                kmState.lock.unlock()

                // Set clipboard to new text
                pb.clearContents()
                pb.setString(text, forType: .string)
                // Small delay to ensure clipboard is ready
                Thread.sleep(forTimeInterval: 0.01)

                // Clear input: Ctrl+E (end), then (Ctrl+U + Backspace) × 4, Ctrl+U, Cmd+V
                // All events tagged with magic — tap passes them through
                postKey(kVK_E, down: true, ctrl: true)
                postKey(kVK_E, down: false, ctrl: true)
                Thread.sleep(forTimeInterval: 0.005)
                for _ in 0..<4 {
                    postKey(kVK_U, down: true, ctrl: true)
                    postKey(kVK_U, down: false, ctrl: true)
                    Thread.sleep(forTimeInterval: 0.003)
                    postKey(kVK_Delete, down: true)
                    postKey(kVK_Delete, down: false)
                    Thread.sleep(forTimeInterval: 0.003)
                }
                postKey(kVK_U, down: true, ctrl: true)
                postKey(kVK_U, down: false, ctrl: true)
                Thread.sleep(forTimeInterval: 0.005)
                // Paste
                postKey(kVK_V, down: true, cmd: true)
                postKey(kVK_V, down: false, cmd: true)
                // Wait for terminal to read clipboard and process paste
                Thread.sleep(forTimeInterval: 0.3)

                // Stop suppressing, collect pending chars
                kmState.lock.lock()
                kmState.suppressing = false
                kmState.suppressStart = nil
                let pending = kmState.pendingChars
                kmState.pendingChars = ""
                kmState.buffer = text + pending
                kmState.changed = true
                kmState.lock.unlock()

                // Type pending chars (what user typed during write) back into the app
                if !pending.isEmpty {
                    let src = CGEventSource(stateID: .combinedSessionState)
                    let arr = Array(pending.utf16)
                    if let pkd = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true) {
                        pkd.keyboardSetUnicodeString(stringLength: arr.count, unicodeString: arr)
                        pkd.setIntegerValueField(.eventSourceUserData, value: KMState.magic)
                        pkd.post(tap: .cghidEventTap)
                    }
                    if let pku = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false) {
                        pku.setIntegerValueField(.eventSourceUserData, value: KMState.magic)
                        pku.post(tap: .cghidEventTap)
                    }
                    Thread.sleep(forTimeInterval: 0.02)
                }

                // Emit result — JS side restores clipboard
                let pe = pending.replacingOccurrences(of: "\\", with: "\\\\")
                    .replacingOccurrences(of: "\"", with: "\\\"")
                    .replacingOccurrences(of: "\n", with: "\\n")
                fputs("{\"wrote\":true,\"pending\":\"\(pe)\",\"len\":\(text.count)}\n", stdout)
                fflush(stdout)
            }
        }
    }

    // Emit buffer every 300ms when changed
    DispatchQueue.global().async {
        while true {
            Thread.sleep(forTimeInterval: 0.3)
            if kmState.changed {
                kmState.changed = false
                kmState.lock.lock()
                let t = kmState.buffer
                kmState.lock.unlock()
                let e = t.replacingOccurrences(of: "\\", with: "\\\\")
                    .replacingOccurrences(of: "\"", with: "\\\"")
                    .replacingOccurrences(of: "\n", with: "\\n")
                fputs("{\"text\":\"\(e)\",\"len\":\(t.count)}\n", stdout)
                fflush(stdout)
            }
        }
    }
    CFRunLoopRun()

case "enable-ax":
    // Force an Electron app (VS Code, Cursor) to expose its accessibility tree
    // by setting the AXManualAccessibility attribute on its AXApplication element.
    // This makes webview content (like Claude Code's input) visible to AX APIs.
    guard AXIsProcessTrusted(), args.count >= 3, let pid = Int32(args[2]) else {
        print(json(["ok":false, "error":"bad_args"])); exit(0)
    }
    let appEl = AXUIElementCreateApplication(pid)
    let attr = "AXManualAccessibility" as CFString
    let result = AXUIElementSetAttributeValue(appEl, attr, kCFBooleanTrue)
    // success/attributeUnsupported/cannotComplete — all may work in practice with Electron
    // cannotComplete (-25204) often means the app is still processing but AX tree gets exposed
    let softOk = result == .success || result == .attributeUnsupported || result == .cannotComplete
    if softOk {
        Thread.sleep(forTimeInterval: 0.3)
        print(json(["ok":true, "result":String(describing: result)]))
    } else {
        print(json(["ok":false, "error":"ax_set_failed", "code":result.rawValue]))
    }

default:
    print(json(["error":"unknown"]))
}
