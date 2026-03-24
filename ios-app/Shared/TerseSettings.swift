import Foundation
import Combine

enum AggressivenessMode: String, CaseIterable {
    case light, balanced, aggressive
    var label: String {
        switch self {
        case .light: return "Light"
        case .balanced: return "Balanced"
        case .aggressive: return "Aggressive"
        }
    }
    var description: String {
        switch self {
        case .light: return "Typo correction and whitespace only."
        case .balanced: return "Removes filler, politeness, hedging."
        case .aggressive: return "Maximum compression."
        }
    }
}

class TerseSettings: ObservableObject {
    static let shared = TerseSettings()

    private let defaults: UserDefaults

    // MARK: - Core Settings

    @Published var aggressiveness: AggressivenessMode {
        didSet { defaults.set(aggressiveness.rawValue, forKey: "aggressiveness") }
    }

    @Published var theme: TerseThemeName {
        didSet { defaults.set(theme.rawValue, forKey: "theme") }
    }

    @Published var autoMode: String { // "off", "send", "auto"
        didSet { defaults.set(autoMode, forKey: "autoMode") }
    }

    // MARK: - Optimization Toggles

    @Published var removeFillerWords: Bool {
        didSet { defaults.set(removeFillerWords, forKey: "removeFillerWords") }
    }

    @Published var removePoliteness: Bool {
        didSet { defaults.set(removePoliteness, forKey: "removePoliteness") }
    }

    @Published var removeHedging: Bool {
        didSet { defaults.set(removeHedging, forKey: "removeHedging") }
    }

    @Published var removeMetaLanguage: Bool {
        didSet { defaults.set(removeMetaLanguage, forKey: "removeMetaLanguage") }
    }

    @Published var shortenPhrases: Bool {
        didSet { defaults.set(shortenPhrases, forKey: "shortenPhrases") }
    }

    @Published var simplifyInstructions: Bool {
        didSet { defaults.set(simplifyInstructions, forKey: "simplifyInstructions") }
    }

    @Published var removeRedundancy: Bool {
        didSet { defaults.set(removeRedundancy, forKey: "removeRedundancy") }
    }

    @Published var compressWhitespace: Bool {
        didSet { defaults.set(compressWhitespace, forKey: "compressWhitespace") }
    }

    @Published var compressCodeBlocks: Bool {
        didSet { defaults.set(compressCodeBlocks, forKey: "compressCodeBlocks") }
    }

    @Published var useAbbreviations: Bool {
        didSet { defaults.set(useAbbreviations, forKey: "useAbbreviations") }
    }

    @Published var deduplicateContent: Bool {
        didSet { defaults.set(deduplicateContent, forKey: "deduplicateContent") }
    }

    @Published var compressLists: Bool {
        didSet { defaults.set(compressLists, forKey: "compressLists") }
    }

    @Published var correctTypos: Bool {
        didSet { defaults.set(correctTypos, forKey: "correctTypos") }
    }

    // MARK: - Keyboard Extension Settings

    @Published var hapticFeedback: Bool {
        didSet { defaults.set(hapticFeedback, forKey: "hapticFeedback") }
    }

    @Published var showTokenCount: Bool {
        didSet { defaults.set(showTokenCount, forKey: "showTokenCount") }
    }

    @Published var autoOptimizeOnPaste: Bool {
        didSet { defaults.set(autoOptimizeOnPaste, forKey: "autoOptimizeOnPaste") }
    }

    @Published var hasSeenSetup: Bool {
        didSet { defaults.set(hasSeenSetup, forKey: "hasSeenSetup") }
    }

    // MARK: - Stats (shared with keyboard extension)

    var totalTokensOptimized: Int {
        get { defaults.integer(forKey: "totalTokensOptimized") }
        set { defaults.set(newValue, forKey: "totalTokensOptimized") }
    }

    var totalTokensSaved: Int {
        get { defaults.integer(forKey: "totalTokensSaved") }
        set { defaults.set(newValue, forKey: "totalTokensSaved") }
    }

    var totalOptimizations: Int {
        get { defaults.integer(forKey: "totalOptimizations") }
        set { defaults.set(newValue, forKey: "totalOptimizations") }
    }

    // MARK: - Computed

    var currentTheme: TerseTheme {
        TerseTheme.theme(for: theme)
    }

    // MARK: - Init

    init() {
        let d = UserDefaults(suiteName: "group.com.terse.shared") ?? .standard
        self.defaults = d

        self.aggressiveness = AggressivenessMode(rawValue: d.string(forKey: "aggressiveness") ?? "balanced") ?? .balanced
        self.theme = TerseThemeName(rawValue: d.string(forKey: "theme") ?? "lime") ?? .lime
        self.autoMode = d.string(forKey: "autoMode") ?? "send"

        self.removeFillerWords = d.object(forKey: "removeFillerWords") as? Bool ?? true
        self.removePoliteness = d.object(forKey: "removePoliteness") as? Bool ?? true
        self.removeHedging = d.object(forKey: "removeHedging") as? Bool ?? true
        self.removeMetaLanguage = d.object(forKey: "removeMetaLanguage") as? Bool ?? true
        self.shortenPhrases = d.object(forKey: "shortenPhrases") as? Bool ?? true
        self.simplifyInstructions = d.object(forKey: "simplifyInstructions") as? Bool ?? true
        self.removeRedundancy = d.object(forKey: "removeRedundancy") as? Bool ?? true
        self.compressWhitespace = d.object(forKey: "compressWhitespace") as? Bool ?? true
        self.compressCodeBlocks = d.object(forKey: "compressCodeBlocks") as? Bool ?? true
        self.useAbbreviations = d.object(forKey: "useAbbreviations") as? Bool ?? true
        self.deduplicateContent = d.object(forKey: "deduplicateContent") as? Bool ?? true
        self.compressLists = d.object(forKey: "compressLists") as? Bool ?? true
        self.correctTypos = d.object(forKey: "correctTypos") as? Bool ?? true

        self.hapticFeedback = d.object(forKey: "hapticFeedback") as? Bool ?? true
        self.showTokenCount = d.object(forKey: "showTokenCount") as? Bool ?? true
        self.autoOptimizeOnPaste = d.object(forKey: "autoOptimizeOnPaste") as? Bool ?? false
        self.hasSeenSetup = d.bool(forKey: "hasSeenSetup")
    }

    // MARK: - Apply Settings to Optimizer

    func applyTo(_ optimizer: TerseOptimizer) {
        optimizer.aggressiveness = aggressiveness.rawValue
        optimizer.removeFillerWords = removeFillerWords
        optimizer.removePoliteness = removePoliteness
        optimizer.removeHedging = removeHedging
        optimizer.removeMetaLanguage = removeMetaLanguage
        optimizer.shortenPhrases = shortenPhrases
        optimizer.simplifyInstructions = simplifyInstructions
        optimizer.removeRedundancy = removeRedundancy
        optimizer.compressWhitespace = compressWhitespace
        optimizer.compressCodeBlocks = compressCodeBlocks
        optimizer.useAbbreviations = useAbbreviations
        optimizer.deduplicateContent = deduplicateContent
        optimizer.compressLists = compressLists
        optimizer.correctTypos = correctTypos
    }

    // MARK: - Reload from Disk

    func reload() {
        defaults.synchronize()
        aggressiveness = AggressivenessMode(rawValue: defaults.string(forKey: "aggressiveness") ?? "balanced") ?? .balanced
        theme = TerseThemeName(rawValue: defaults.string(forKey: "theme") ?? "lime") ?? .lime
        autoMode = defaults.string(forKey: "autoMode") ?? "send"
        removeFillerWords = defaults.object(forKey: "removeFillerWords") as? Bool ?? true
        removePoliteness = defaults.object(forKey: "removePoliteness") as? Bool ?? true
        removeHedging = defaults.object(forKey: "removeHedging") as? Bool ?? true
        removeMetaLanguage = defaults.object(forKey: "removeMetaLanguage") as? Bool ?? true
        shortenPhrases = defaults.object(forKey: "shortenPhrases") as? Bool ?? true
        simplifyInstructions = defaults.object(forKey: "simplifyInstructions") as? Bool ?? true
        removeRedundancy = defaults.object(forKey: "removeRedundancy") as? Bool ?? true
        compressWhitespace = defaults.object(forKey: "compressWhitespace") as? Bool ?? true
        compressCodeBlocks = defaults.object(forKey: "compressCodeBlocks") as? Bool ?? true
        useAbbreviations = defaults.object(forKey: "useAbbreviations") as? Bool ?? true
        deduplicateContent = defaults.object(forKey: "deduplicateContent") as? Bool ?? true
        compressLists = defaults.object(forKey: "compressLists") as? Bool ?? true
        correctTypos = defaults.object(forKey: "correctTypos") as? Bool ?? true
        hapticFeedback = defaults.object(forKey: "hapticFeedback") as? Bool ?? true
        showTokenCount = defaults.object(forKey: "showTokenCount") as? Bool ?? true
        autoOptimizeOnPaste = defaults.object(forKey: "autoOptimizeOnPaste") as? Bool ?? false
    }

    // MARK: - Record Stats

    func recordOptimization(tokensBefore: Int, tokensAfter: Int) {
        totalTokensOptimized += tokensBefore
        totalTokensSaved += max(0, tokensBefore - tokensAfter)
        totalOptimizations += 1
    }

    // MARK: - Reset

    func resetToDefaults() {
        aggressiveness = .balanced
        theme = .lime
        autoMode = "send"
        removeFillerWords = true
        removePoliteness = true
        removeHedging = true
        removeMetaLanguage = true
        shortenPhrases = true
        simplifyInstructions = true
        removeRedundancy = true
        compressWhitespace = true
        compressCodeBlocks = true
        useAbbreviations = true
        deduplicateContent = true
        compressLists = true
        correctTypos = true
        hapticFeedback = true
        showTokenCount = true
        autoOptimizeOnPaste = false
    }
}
