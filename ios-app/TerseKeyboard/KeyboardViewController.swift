import UIKit
import SwiftUI
import KeyboardKit

class KeyboardViewController: KeyboardInputViewController {

    let optimizer = TerseOptimizer()
    @Published var lastOptResult: OptimizationResult?
    static var shared: KeyboardViewController?

    override func viewDidLoad() {
        Self.shared = self
        super.viewDidLoad()
        loadOptimizerSettings()
        // Default to system language
        let systemLang = Locale.current.language.languageCode?.identifier ?? "en"
        let supportedLocales = ["en", "zh-Hans"]
        let defaultLocale = supportedLocales.contains(systemLang) ? systemLang : "en"
        let savedLocale = UserDefaults(suiteName: "group.com.terse.shared")?.string(forKey: "keyboardLocale") ?? defaultLocale
        let initialLocale = Locale(identifier: savedLocale)

        // Set up autocomplete with pinyin support, synced to current locale
        let acService = TerseAutocompleteService()
        acService.locale = initialLocale
        services.autocompleteService = acService
        services.actionHandler = TerseActionHandler(controller: self)
        services.styleService = TerseStyleService(keyboardContext: state.keyboardContext)
        state.keyboardContext.locale = initialLocale

        // Disable auto-capitalize in Chinese mode
        if savedLocale.hasPrefix("zh") {
            state.keyboardContext.autocapitalizationTypeOverride = .none
        }

        // Clear system background so glass effect shows
        updateViewBackground()
    }

    override func viewWillSetupKeyboardView() {
        super.viewWillSetupKeyboardView()
        setupKeyboardView { [weak self] controller in
            ZStack {
                // Gradient base for the material to blur against
                TerseGlassBackground()

                VStack(spacing: 0) {
                    TerseToolbarView()
                    TerseCandidateBar(
                        autocompleteContext: controller.state.autocompleteContext,
                        actionHandler: controller.services.actionHandler
                    )
                    KeyboardView(
                        state: controller.state,
                        services: controller.services,
                        buttonContent: { $0.view },
                        buttonView: { $0.view },
                        emojiKeyboard: { $0.view },
                        toolbar: { _ in EmptyView() }
                    )
                }
            }
        }
    }

    func updateViewBackground() {
        let t = UserDefaults(suiteName: "group.com.terse.shared")?.string(forKey: "theme") ?? "lime"
        let hex = TerseToolbarView.bgColors[t] ?? 0xd1e847
        let r = CGFloat((hex >> 16) & 0xFF) / 255
        let g = CGFloat((hex >> 8) & 0xFF) / 255
        let b = CGFloat(hex & 0xFF) / 255
        // Solid theme color — no grey can bleed through
        let color = UIColor(red: r, green: g, blue: b, alpha: 1.0)
        view.backgroundColor = color
        inputView?.backgroundColor = color
    }

    func loadOptimizerSettings() {
        let d = UserDefaults(suiteName: "group.com.terse.shared")
        optimizer.aggressiveness = d?.string(forKey: "aggressiveness") ?? "balanced"
        optimizer.removeFillerWords = d?.object(forKey: "removeFillerWords") as? Bool ?? true
        optimizer.removePoliteness = d?.object(forKey: "removePoliteness") as? Bool ?? true
        optimizer.removeHedging = d?.object(forKey: "removeHedging") as? Bool ?? true
        optimizer.removeMetaLanguage = d?.object(forKey: "removeMetaLanguage") as? Bool ?? true
        optimizer.shortenPhrases = d?.object(forKey: "shortenPhrases") as? Bool ?? true
        optimizer.simplifyInstructions = d?.object(forKey: "simplifyInstructions") as? Bool ?? true
        optimizer.removeRedundancy = d?.object(forKey: "removeRedundancy") as? Bool ?? true
        optimizer.compressWhitespace = d?.object(forKey: "compressWhitespace") as? Bool ?? true
        optimizer.compressCodeBlocks = d?.object(forKey: "compressCodeBlocks") as? Bool ?? true
        optimizer.useAbbreviations = d?.object(forKey: "useAbbreviations") as? Bool ?? true
        optimizer.deduplicateContent = d?.object(forKey: "deduplicateContent") as? Bool ?? true
        optimizer.compressLists = d?.object(forKey: "compressLists") as? Bool ?? true
        optimizer.correctTypos = d?.object(forKey: "correctTypos") as? Bool ?? true
    }

    var isOverQuota: Bool {
        let d = UserDefaults(suiteName: "group.com.terse.shared")
        let weeklyLimit = d?.object(forKey: "optimizationsPerWeek") as? Int ?? 50
        if weeklyLimit < 0 { return false } // unlimited
        let currentWeek = Self.currentWeekString()
        let savedWeek = d?.string(forKey: "usageWeek") ?? ""
        if savedWeek != currentWeek { return false } // new week, usage is 0
        let weeklyUsage = d?.integer(forKey: "weeklyUsage") ?? 0
        return weeklyUsage >= weeklyLimit
    }

    func incrementDailyCount() {
        let d = UserDefaults(suiteName: "group.com.terse.shared")

        // Increment weekly usage (same keys as TerseAuth.recordOptimization)
        let currentWeek = Self.currentWeekString()
        let savedWeek = d?.string(forKey: "usageWeek") ?? ""
        if savedWeek != currentWeek {
            d?.set(currentWeek, forKey: "usageWeek")
            d?.set(1, forKey: "weeklyUsage")
        } else {
            d?.set((d?.integer(forKey: "weeklyUsage") ?? 0) + 1, forKey: "weeklyUsage")
        }
    }

    private static func currentWeekString() -> String {
        let cal = Calendar(identifier: .iso8601)
        let comps = cal.dateComponents([.yearForWeekOfYear, .weekOfYear], from: Date())
        return "\(comps.yearForWeekOfYear ?? 0)\(String(format: "%02d", comps.weekOfYear ?? 0))"
    }

    func recordStats(_ result: OptimizationResult) {
        let d = UserDefaults(suiteName: "group.com.terse.shared")
        // Update simple counters (read by header banner)
        d?.set((d?.integer(forKey: "totalTokensOptimized") ?? 0) + result.stats.originalTokens, forKey: "totalTokensOptimized")
        d?.set((d?.integer(forKey: "totalTokensSaved") ?? 0) + result.stats.tokensSaved, forKey: "totalTokensSaved")
        d?.set((d?.integer(forKey: "totalOptimizations") ?? 0) + 1, forKey: "totalOptimizations")

        // Append to stats_entries array (read by Stats tab)
        let fmt = DateFormatter(); fmt.dateFormat = "yyyy-MM-dd"
        var entries = d?.array(forKey: "stats_entries") as? [[String: Any]] ?? []
        entries.append([
            "date": fmt.string(from: Date()),
            "tokensIn": result.stats.originalTokens,
            "tokensSaved": result.stats.tokensSaved,
            "source": "keyboard"
        ])
        d?.set(entries, forKey: "stats_entries")
    }
}

// MARK: - Autocomplete (UITextChecker + Chinese Pinyin)

class TerseAutocompleteService: AutocompleteService {
    var locale: Locale = .current
    var canIgnoreWords: Bool { false }
    var canLearnWords: Bool { false }
    var ignoredWords: [String] { [] }
    var learnedWords: [String] { [] }
    private let checker = UITextChecker()

    func autocompleteSuggestions(for text: String) async throws -> [Autocomplete.Suggestion] {
        return await MainActor.run { suggestionsSync(for: text) }
    }

    func nextCharacterPredictions(forText text: String, suggestions: [Autocomplete.Suggestion]) async throws -> [Character: Double] { [:] }
    func hasIgnoredWord(_ word: String) -> Bool { false }
    func hasLearnedWord(_ word: String) -> Bool { false }
    func ignoreWord(_ word: String) {}
    func learnWord(_ word: String) {}
    func removeIgnoredWord(_ word: String) {}
    func unlearnWord(_ word: String) {}

    private func suggestionsSync(for text: String) -> [Autocomplete.Suggestion] {
        // Always read current locale from UserDefaults (most reliable)
        let savedLocale = UserDefaults(suiteName: "group.com.terse.shared")?.string(forKey: "keyboardLocale") ?? "en"
        let isChinese = savedLocale.hasPrefix("zh")
        let lang = isChinese ? "zh" : (locale.language.languageCode?.identifier ?? "en")

        // Chinese pinyin mode
        if isChinese {
            return pinyinSuggestions(for: text)
        }

        // Latin languages — standard autocorrect
        let word = extractWord(from: text)
        guard word.count >= 2 else { return [] }
        let range = NSRange(location: 0, length: word.utf16.count)
        var results: [Autocomplete.Suggestion] = []

        let misspelled = checker.rangeOfMisspelledWord(in: word, range: range, startingAt: 0, wrap: false, language: lang)
        if misspelled.location != NSNotFound {
            let guesses = checker.guesses(forWordRange: misspelled, in: word, language: lang) ?? []
            if let first = guesses.first {
                results.append(.init(text: first, type: .autocorrect))
            }
            for g in guesses.dropFirst().prefix(2) { results.append(.init(text: g)) }
        } else {
            results.append(.init(text: word, title: "\"\(word)\""))
            let completions = checker.completions(forPartialWordRange: range, in: word, language: lang) ?? []
            for c in completions.prefix(2) { results.append(.init(text: c)) }
        }
        return results
    }

    // MARK: - Chinese Pinyin → Character conversion

    private func pinyinSuggestions(for text: String) -> [Autocomplete.Suggestion] {
        let pinyin = extractWord(from: text).lowercased()
        guard !pinyin.isEmpty else { return [] }

        // Query SQLite database for characters + phrases
        let candidates = PinyinDB.shared.lookup(pinyin: pinyin)
        var results: [Autocomplete.Suggestion] = []

        // First candidate is autocorrect (auto-inserts on space), show up to 20
        for (i, c) in candidates.enumerated() {
            results.append(.init(text: c, type: i == 0 ? .autocorrect : .regular))
        }

        // Show raw pinyin as fallback option
        if !candidates.isEmpty {
            results.append(.init(text: pinyin, title: "\"\(pinyin)\""))
        }

        return results
    }

    private func extractWord(from text: String) -> String {
        var w = ""
        for ch in text.reversed() {
            // For pinyin: only extract ASCII letters (stop at Chinese characters, spaces, punctuation)
            if ch.isASCII && ch.isLetter { w = String(ch) + w }
            else if ch == "'" { w = String(ch) + w }
            else { break }
        }
        return w
    }
}

// MARK: - Action Handler (optimize on Send)

class TerseActionHandler: KeyboardAction.StandardHandler {
    private weak var terseVC: KeyboardViewController?

    init(controller: KeyboardViewController) {
        self.terseVC = controller
        super.init(
            controller: controller,
            keyboardContext: controller.state.keyboardContext,
            keyboardBehavior: controller.services.keyboardBehavior,
            autocompleteContext: controller.state.autocompleteContext,
            autocompleteService: controller.services.autocompleteService,
            feedbackContext: controller.state.feedbackContext,
            feedbackService: controller.services.feedbackService,
            spaceDragGestureHandler: controller.services.spaceDragGestureHandler
        )
    }

    private var isChinese: Bool {
        (UserDefaults(suiteName: "group.com.terse.shared")?.string(forKey: "keyboardLocale") ?? "en").hasPrefix("zh")
    }

    override func handle(_ gesture: Keyboard.Gesture, on action: KeyboardAction, replaced: Bool) {
        // Chinese mode: intercept space to insert first candidate WITHOUT space
        if gesture == .release, case .space = action, isChinese, let vc = terseVC {
            let before = vc.textDocumentProxy.documentContextBeforeInput ?? ""
            let pinyin = extractTrailingPinyin(from: before)
            if !pinyin.isEmpty {
                let candidates = PinyinDB.shared.lookup(pinyin: pinyin)
                if let first = candidates.first {
                    // Only delete the pinyin part, not any previous Chinese text
                    for _ in 0..<pinyin.count { vc.textDocumentProxy.deleteBackward() }
                    vc.textDocumentProxy.insertText(first)
                    return // Skip super entirely — no space, no autocorrect
                }
            }
            // No pinyin typed — insert actual space
            vc.textDocumentProxy.insertText(" ")
            return
        }

        // Send: optimize then send
        if gesture == .release, case .primary = action, let vc = terseVC {
            // In Chinese mode, DON'T convert trailing pinyin — just keep as English letters
            // (same as native pinyin keyboard behavior)
            if !vc.isOverQuota {
                // Only optimize if there's actual Chinese text, not just pinyin
                let before = vc.textDocumentProxy.documentContextBeforeInput ?? ""
                let hasChinese = before.unicodeScalars.contains { (0x4e00...0x9fff).contains($0.value) }
                if hasChinese || !isChinese {
                    optimizeText(vc)
                }
            }
        }

        // For Chinese mode, skip KeyboardKit's built-in autocorrect but keep other behaviors
        if isChinese {
            // Handle shift toggle manually — always go back to lowercase after typing
            if gesture == .release, case .shift = action {
                // Toggle shift
                if case .alphabetic(.uppercased) = keyboardContext.keyboardType {
                    keyboardContext.keyboardType = .alphabetic(.lowercased)
                } else {
                    keyboardContext.keyboardType = .alphabetic(.uppercased)
                }
                return
            }

            let gestureAction = self.action(for: gesture, on: action)
            tryTriggerFeedback(for: gesture, on: action)
            gestureAction?(keyboardController)
            tryChangeKeyboardType(after: gesture, on: action)
            tryPerformAutocomplete(after: gesture, on: action)

            // Always force lowercase after typing a character in Chinese
            if gesture == .release, case .character = action {
                keyboardContext.keyboardType = .alphabetic(.lowercased)
            }
            return
        }

        // English/other: default behavior with autocorrect
        super.handle(gesture, on: action, replaced: replaced)
    }

    /// Override suggestion handling: no space after selection in Chinese
    override func handle(_ suggestion: Autocomplete.Suggestion) {
        guard let vc = terseVC else { super.handle(suggestion); return }

        if isChinese {
            // Delete trailing pinyin, insert selected Chinese character — NO space
            let before = vc.textDocumentProxy.documentContextBeforeInput ?? ""
            let pinyin = extractTrailingPinyin(from: before)
            for _ in 0..<pinyin.count { vc.textDocumentProxy.deleteBackward() }
            vc.textDocumentProxy.insertText(suggestion.text)
            // Clear suggestions
            vc.state.autocompleteContext.suggestions = []
        } else {
            super.handle(suggestion)
        }
    }

    /// Extract only ASCII pinyin letters from end of text (stops at Chinese chars, spaces, punctuation)
    private func extractTrailingPinyin(from text: String) -> String {
        var w = ""
        for ch in text.reversed() {
            if ch.isASCII && ch.isLetter { w = String(ch) + w }
            else { break }
        }
        return w.lowercased()
    }

    private func optimizeText(_ vc: KeyboardViewController) {
        let proxy = vc.textDocumentProxy

        let before = proxy.documentContextBeforeInput ?? ""
        let after = proxy.documentContextAfterInput ?? ""
        let fullText = before + after

        guard fullText.count >= 3 else { return }

        vc.loadOptimizerSettings()
        // Apply database-driven Chinese optimization first (60K+ synonyms, 2K+ stopwords)
        var textToOptimize = fullText
        let lang = TerseMultiLang.detectLanguage(fullText)
        if lang == "zh" {
            textToOptimize = ZhOptimizer.shared.optimize(fullText, aggressiveness: vc.optimizer.aggressiveness)
        }
        let result = vc.optimizer.optimize(textToOptimize)

        if result.stats.tokensSaved > 0 {
            if !after.isEmpty { proxy.adjustTextPosition(byCharacterOffset: after.count) }
            var safety = 0
            while let b = proxy.documentContextBeforeInput, !b.isEmpty, safety < 5000 {
                for _ in 0..<b.count { proxy.deleteBackward() }
                safety += b.count
            }
            proxy.insertText(result.optimized)
            vc.recordStats(result)
            vc.incrementDailyCount()

            NotificationCenter.default.post(
                name: .terseOptimized,
                object: nil,
                userInfo: ["saved": result.stats.tokensSaved, "pct": result.stats.percentSaved]
            )
        }
    }

    private func extractTrailingWord(from text: String) -> String {
        var w = ""
        for ch in text.reversed() {
            if ch.isLetter || ch == "'" { w = String(ch) + w } else { break }
        }
        return w
    }
}

// MARK: - Frosted Glass Style Service

class TerseStyleService: KeyboardStyle.StandardService {

    private var theme: String {
        UserDefaults(suiteName: "group.com.terse.shared")?.string(forKey: "theme") ?? "lime"
    }
    private var themeAccent: Color {
        Color(hex: TerseToolbarView.accentColors[theme] ?? 0x2d8b00)
    }
    private var isDark: Bool { theme == "midnight" }

    // Clear — glass background ZStack handles it
    override var backgroundStyle: Keyboard.Background {
        .init(backgroundColor: .clear)
    }

    // Themed keys
    override func buttonBackgroundColor(for action: KeyboardAction, isPressed: Bool) -> Color {
        switch action {
        case .character, .space:
            return isDark
                ? Color.white.opacity(isPressed ? 0.08 : 0.14)
                : Color.white.opacity(isPressed ? 0.45 : 0.65)
        case .primary:
            return themeAccent.opacity(isPressed ? 0.7 : 1.0)
        case .backspace, .shift, .keyboardType, .nextKeyboard:
            return isDark
                ? Color.white.opacity(isPressed ? 0.06 : 0.10)
                : Color.white.opacity(isPressed ? 0.20 : 0.35)
        case .none, .characterMargin:
            return .clear
        default:
            return isDark
                ? Color.white.opacity(isPressed ? 0.06 : 0.10)
                : Color.white.opacity(isPressed ? 0.20 : 0.35)
        }
    }

    override func buttonForegroundColor(for action: KeyboardAction, isPressed: Bool) -> Color {
        if case .primary = action { return .white }
        if case .none = action { return .clear }
        if case .characterMargin = action { return .clear }
        return isDark ? Color.white.opacity(0.9) : Color.black.opacity(0.8)
    }

    // Ensure button text is visible for bottom row
    override func buttonText(for action: KeyboardAction) -> String? {
        switch action {
        case .space: return "space"
        case .primary: return "Send"
        default: return super.buttonText(for: action)
        }
    }

    // Glass rim — white top edge, slightly darker bottom
    override func buttonBorderStyle(for action: KeyboardAction) -> Keyboard.ButtonBorderStyle {
        switch action {
        case .none, .characterMargin, .emoji: return .noBorder
        default: return .init(color: Color.white.opacity(isDark ? 0.12 : 0.55), size: 0.5)
        }
    }

    // Soft floating shadow
    override func buttonShadowStyle(for action: KeyboardAction) -> Keyboard.ButtonShadowStyle {
        switch action {
        case .characterMargin, .emoji, .none: return .noShadow
        case .primary: return .init(color: themeAccent.opacity(0.3), size: 3)
        default: return .init(color: Color.black.opacity(isDark ? 0.2 : 0.08), size: 1)
        }
    }
}

// MARK: - Glass Background

struct TerseGlassBackground: View {
    @State private var theme = UserDefaults(suiteName: "group.com.terse.shared")?.string(forKey: "theme") ?? "lime"

    var body: some View {
        let bg = Color(hex: TerseToolbarView.bgColors[theme] ?? 0xd1e847)
        let accent = Color(hex: TerseToolbarView.accentColors[theme] ?? 0x2d8b00)
        let isDark = theme == "midnight"

        ZStack {
            // Base theme color
            bg

            // Blurred colorful shapes — the material will blur these for liquid glass depth
            Circle()
                .fill(Color.white.opacity(isDark ? 0.08 : 0.35))
                .frame(width: 250, height: 250)
                .blur(radius: 60)
                .offset(x: -80, y: -60)

            Circle()
                .fill(accent.opacity(0.3))
                .frame(width: 200, height: 200)
                .blur(radius: 50)
                .offset(x: 100, y: 40)

            Ellipse()
                .fill(Color.white.opacity(isDark ? 0.05 : 0.2))
                .frame(width: 300, height: 150)
                .blur(radius: 40)
                .offset(x: 30, y: -100)

            // Frosted glass material — blurs the shapes above for liquid glass
            Rectangle().fill(.ultraThinMaterial)
        }
        .ignoresSafeArea()
        .onReceive(NotificationCenter.default.publisher(for: .terseThemeChanged)) { _ in
            theme = UserDefaults(suiteName: "group.com.terse.shared")?.string(forKey: "theme") ?? "lime"
        }
    }
}

// MARK: - Toolbar (Theme + Mode Selector)

struct TerseToolbarView: View {
    @State private var theme = UserDefaults(suiteName: "group.com.terse.shared")?.string(forKey: "theme") ?? "lime"
    @State private var mode = UserDefaults(suiteName: "group.com.terse.shared")?.string(forKey: "aggressiveness") ?? "balanced"
    @State private var statsText: String = ""
    @State private var currentLang = UserDefaults(suiteName: "group.com.terse.shared")?.string(forKey: "keyboardLocale") ?? (Locale.current.language.languageCode?.identifier ?? "en")

    private static let supportedLangs = ["en", "zh-Hans"]
    private static let langLabels: [String: String] = [
        "en": "EN", "zh-Hans": "中",
    ]

    static let bgColors: [String: UInt] = [
        "lime": 0xd1e847, "lavender": 0xc4b5fd, "coral": 0xff8a80, "teal": 0x5eead4,
        "midnight": 0x1e293b, "rose": 0xfda4af, "sage": 0x86efac, "sand": 0xfde68a,
    ]
    static let accentColors: [String: UInt] = [
        "lime": 0x2d8b00, "lavender": 0x6d28d9, "coral": 0xb91c1c, "teal": 0x0f766e,
        "midnight": 0x38bdf8, "rose": 0xbe123c, "sage": 0x15803d, "sand": 0xb45309,
    ]
    static let names = ["lime", "lavender", "coral", "teal", "midnight", "rose", "sage", "sand"]
    static let darkText: Set<String> = ["lime", "coral", "teal", "rose", "sage", "sand", "lavender"]

    static func currentBgColor() -> Color {
        let t = UserDefaults(suiteName: "group.com.terse.shared")?.string(forKey: "theme") ?? "lime"
        return Color(hex: bgColors[t] ?? 0xd1e847).opacity(0.3)
    }

    var body: some View {
        let bg = Color(hex: Self.bgColors[theme] ?? 0xd1e847)
        let accent = Color(hex: Self.accentColors[theme] ?? 0x2d8b00)
        let fg: Color = Self.darkText.contains(theme) ? Color(hex: 0x0a0a0a) : Color(hex: 0xe2e8f0)

        HStack(spacing: 6) {
            Circle().fill(accent).frame(width: 6, height: 6)
            Text("Terse").font(.system(size: 11, weight: .bold)).foregroundColor(fg)

            Button(action: cycleTheme) {
                Image(systemName: "paintpalette.fill")
                    .font(.system(size: 9)).foregroundColor(.white)
                    .frame(width: 18, height: 18).background(accent).clipShape(Circle())
            }

            Spacer()

            // Mode selector
            HStack(spacing: 1) {
                modeBtn("S", "light", accent, fg)
                modeBtn("N", "balanced", accent, fg)
                modeBtn("A", "aggressive", accent, fg)
            }
            .background(Color.black.opacity(0.12))
            .cornerRadius(10)

            // Language button
            Button(action: cycleLang) {
                Text(Self.langLabels[currentLang] ?? "EN")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundColor(fg)
                    .frame(width: 26, height: 20)
                    .background(Color.white.opacity(0.2))
                    .cornerRadius(6)
            }

            Spacer()

            // Stats display (shows after optimization)
            if !statsText.isEmpty {
                Text(statsText)
                    .font(.system(size: 9, weight: .bold))
                    .foregroundColor(accent)
            } else {
                Text("Send = Optimize")
                    .font(.system(size: 8, weight: .medium))
                    .foregroundColor(fg.opacity(0.5))
            }
        }
        .padding(.horizontal, 10).frame(height: 32)
        .background(.ultraThinMaterial)
        .overlay(
            Rectangle().fill(Color.white.opacity(0.3)).frame(height: 0.5),
            alignment: .bottom
        )
        .onReceive(NotificationCenter.default.publisher(for: .terseOptimized)) { notif in
            if let info = notif.userInfo,
               let saved = info["saved"] as? Int,
               let pct = info["pct"] as? Int {
                statsText = "-\(saved) tok (\(pct)%)"
                // Auto-hide after 3 seconds
                DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                    statsText = ""
                }
            }
        }
    }

    private func modeBtn(_ label: String, _ value: String, _ accent: Color, _ fg: Color) -> some View {
        Button(action: {
            mode = value
            UserDefaults(suiteName: "group.com.terse.shared")?.set(value, forKey: "aggressiveness")
        }) {
            Text(label).font(.system(size: 9, weight: .semibold))
                .foregroundColor(mode == value ? .white : fg.opacity(0.5))
                .frame(width: 24, height: 20)
                .background(mode == value ? accent : Color.clear)
                .cornerRadius(9)
        }
    }

    private func cycleTheme() {
        let idx = Self.names.firstIndex(of: theme) ?? 0
        theme = Self.names[(idx + 1) % Self.names.count]
        UserDefaults(suiteName: "group.com.terse.shared")?.set(theme, forKey: "theme")
        KeyboardViewController.shared?.updateViewBackground()
        NotificationCenter.default.post(name: .terseThemeChanged, object: nil)
    }

    private func cycleLang() {
        let langs = Self.supportedLangs
        let idx = langs.firstIndex(of: currentLang) ?? 0
        let next = langs[(idx + 1) % langs.count]
        currentLang = next
        UserDefaults(suiteName: "group.com.terse.shared")?.set(next, forKey: "keyboardLocale")
        // Update KeyboardKit locale + autocomplete service locale
        let newLocale = Locale(identifier: next)
        KeyboardViewController.shared?.state.keyboardContext.locale = newLocale
        (KeyboardViewController.shared?.services.autocompleteService as? TerseAutocompleteService)?.locale = newLocale
        // Disable auto-capitalize in Chinese, enable in other languages
        if next.hasPrefix("zh") {
            KeyboardViewController.shared?.state.keyboardContext.autocapitalizationTypeOverride = .none
        } else {
            KeyboardViewController.shared?.state.keyboardContext.autocapitalizationTypeOverride = nil
        }
    }
}

// Notification for optimization stats
extension Notification.Name {
    static let terseOptimized = Notification.Name("terseOptimized")
    static let terseThemeChanged = Notification.Name("terseThemeChanged")
}

// MARK: - Expandable Candidate Bar (Chinese pinyin + English autocomplete)

struct TerseCandidateBar: View {
    @ObservedObject var autocompleteContext: AutocompleteContext
    var actionHandler: KeyboardActionHandler

    @State private var expanded = false

    private var isChinese: Bool {
        (UserDefaults(suiteName: "group.com.terse.shared")?.string(forKey: "keyboardLocale") ?? "en").hasPrefix("zh")
    }

    var body: some View {
        let suggestions = autocompleteContext.suggestions
        if suggestions.isEmpty {
            EmptyView()
        } else if expanded {
            expandedView(suggestions)
        } else {
            collapsedView(suggestions)
        }
    }

    // Normal 3-item bar with expand button
    private func collapsedView(_ suggestions: [Autocomplete.Suggestion]) -> some View {
        HStack(spacing: 0) {
            ForEach(Array(suggestions.prefix(3).enumerated()), id: \.offset) { idx, suggestion in
                Button(action: { actionHandler.handle(suggestion) }) {
                    Text(suggestion.title)
                        .font(.system(size: 16, weight: idx == 0 && suggestion.type == .autocorrect ? .bold : .regular))
                        .foregroundColor(Color.primary)
                        .frame(maxWidth: .infinity)
                        .frame(height: 40)
                }
                if idx < min(suggestions.count, 3) - 1 {
                    Divider().frame(height: 20)
                }
            }
            // Expand button (∨) — only show if more than 3 candidates
            if suggestions.count > 3 {
                Button(action: { withAnimation(.easeInOut(duration: 0.2)) { expanded = true } }) {
                    Image(systemName: "chevron.down")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(.secondary)
                        .frame(width: 36, height: 40)
                }
            }
        }
        .background(Color(UIColor.systemBackground).opacity(0.9))
        .frame(height: 40)
    }

    // Expanded grid showing ALL candidates
    private func expandedView(_ suggestions: [Autocomplete.Suggestion]) -> some View {
        VStack(spacing: 0) {
            // Collapse button at top
            HStack {
                Spacer()
                Button(action: { withAnimation(.easeInOut(duration: 0.2)) { expanded = false } }) {
                    Image(systemName: "chevron.up")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(.secondary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                }
            }

            // Scrollable grid of all candidates
            ScrollView {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: isChinese ? 6 : 3), spacing: 4) {
                    ForEach(Array(suggestions.enumerated()), id: \.offset) { idx, suggestion in
                        Button(action: {
                            actionHandler.handle(suggestion)
                            withAnimation { expanded = false }
                        }) {
                            Text(suggestion.title)
                                .font(.system(size: isChinese ? 18 : 15))
                                .foregroundColor(Color.primary)
                                .frame(maxWidth: .infinity)
                                .frame(height: 36)
                                .background(Color(UIColor.systemBackground).opacity(0.8))
                                .cornerRadius(6)
                        }
                    }
                }
                .padding(.horizontal, 8)
            }
            .frame(maxHeight: 160) // Max 4 rows visible
        }
        .background(Color(UIColor.secondarySystemBackground).opacity(0.95))
    }
}

private extension Color {
    init(hex: UInt) {
        self.init(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255, opacity: 1)
    }
}
