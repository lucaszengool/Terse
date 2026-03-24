import UIKit
import UniformTypeIdentifiers

class ActionViewController: UIViewController {

    private let optimizer = TerseOptimizer()
    private let auth = TerseAuth.shared
    private var originalText = ""
    private var optimizedText = ""

    private var textView: UITextView!
    private var statsLabel: UILabel!
    private var doneButton: UIButton!

    private var currentTheme: TerseTheme {
        let name = UserDefaults(suiteName: "group.com.terse.shared")?.string(forKey: "theme") ?? "lime"
        return TerseTheme.theme(for: TerseThemeName(rawValue: name) ?? .lime)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        loadOptimizerSettings()
        setupUI()

        // Check auth & quota
        if !auth.isSignedIn {
            showError("Please sign in to Terse first")
            return
        }
        if !auth.canOptimize {
            showError("Weekly limit reached (\(auth.optimizationsPerWeek) optimizations). Upgrade to Pro for unlimited.")
            return
        }

        loadInputText()
    }

    private func showError(_ message: String) {
        textView.text = message
        textView.textColor = .systemOrange
        statsLabel.text = ""
        doneButton.isEnabled = false
        doneButton.alpha = 0.3
    }

    private func loadOptimizerSettings() {
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
        optimizer.correctTypos = d?.object(forKey: "correctTypos") as? Bool ?? true
    }

    private func setupUI() {
        let theme = currentTheme
        view.backgroundColor = UIColor(theme.bg)

        // Title bar
        let titleBar = UIView()
        titleBar.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(titleBar)

        let titleLabel = UILabel()
        titleLabel.text = "Terse Optimize"
        titleLabel.font = .systemFont(ofSize: 15, weight: .bold)
        titleLabel.textColor = UIColor(theme.t1)
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        titleBar.addSubview(titleLabel)

        let cancelBtn = UIButton(type: .system)
        cancelBtn.setTitle("Cancel", for: .normal)
        cancelBtn.titleLabel?.font = .systemFont(ofSize: 14)
        cancelBtn.setTitleColor(UIColor(theme.t3), for: .normal)
        cancelBtn.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
        cancelBtn.translatesAutoresizingMaskIntoConstraints = false
        titleBar.addSubview(cancelBtn)

        doneButton = UIButton(type: .system)
        doneButton.setTitle("Done", for: .normal)
        doneButton.titleLabel?.font = .systemFont(ofSize: 14, weight: .bold)
        doneButton.setTitleColor(UIColor(theme.accent), for: .normal)
        doneButton.addTarget(self, action: #selector(doneTapped), for: .touchUpInside)
        doneButton.translatesAutoresizingMaskIntoConstraints = false
        titleBar.addSubview(doneButton)

        NSLayoutConstraint.activate([
            titleBar.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            titleBar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            titleBar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            titleBar.heightAnchor.constraint(equalToConstant: 44),
            cancelBtn.leadingAnchor.constraint(equalTo: titleBar.leadingAnchor, constant: 16),
            cancelBtn.centerYAnchor.constraint(equalTo: titleBar.centerYAnchor),
            titleLabel.centerXAnchor.constraint(equalTo: titleBar.centerXAnchor),
            titleLabel.centerYAnchor.constraint(equalTo: titleBar.centerYAnchor),
            doneButton.trailingAnchor.constraint(equalTo: titleBar.trailingAnchor, constant: -16),
            doneButton.centerYAnchor.constraint(equalTo: titleBar.centerYAnchor),
        ])

        // Stats
        statsLabel = UILabel()
        statsLabel.font = .monospacedDigitSystemFont(ofSize: 12, weight: .semibold)
        statsLabel.textColor = UIColor(theme.accent)
        statsLabel.textAlignment = .center
        statsLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(statsLabel)

        NSLayoutConstraint.activate([
            statsLabel.topAnchor.constraint(equalTo: titleBar.bottomAnchor, constant: 8),
            statsLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            statsLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
        ])

        // Text view
        textView = UITextView()
        textView.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        textView.textColor = UIColor(theme.t1)
        textView.backgroundColor = UIColor(theme.surface)
        textView.layer.cornerRadius = 14
        textView.isEditable = false
        textView.textContainerInset = UIEdgeInsets(top: 12, left: 10, bottom: 12, right: 10)
        textView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(textView)

        NSLayoutConstraint.activate([
            textView.topAnchor.constraint(equalTo: statsLabel.bottomAnchor, constant: 12),
            textView.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            textView.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            textView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -16),
        ])
    }

    private func loadInputText() {
        guard let items = extensionContext?.inputItems as? [NSExtensionItem] else { return }
        for item in items {
            guard let attachments = item.attachments else { continue }
            for provider in attachments {
                if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                    provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) { [weak self] data, _ in
                        guard let text = data as? String else { return }
                        DispatchQueue.main.async {
                            self?.processText(text)
                        }
                    }
                    return
                }
            }
        }
    }

    private func processText(_ text: String) {
        originalText = text
        let result = optimizer.optimize(text)
        optimizedText = result.optimized

        textView.text = result.optimized
        statsLabel.text = "\(result.stats.originalTokens) \u{2192} \(result.stats.optimizedTokens) tokens (\(result.stats.percentSaved)% saved)"

        // Record stats
        let d = UserDefaults(suiteName: "group.com.terse.shared")
        let prev = d?.integer(forKey: "totalTokensOptimized") ?? 0
        d?.set(prev + result.stats.originalTokens, forKey: "totalTokensOptimized")
        let prevSaved = d?.integer(forKey: "totalTokensSaved") ?? 0
        d?.set(prevSaved + result.stats.tokensSaved, forKey: "totalTokensSaved")
        let prevCount = d?.integer(forKey: "totalOptimizations") ?? 0
        d?.set(prevCount + 1, forKey: "totalOptimizations")

        // Record quota usage
        auth.recordOptimization()
    }

    @objc private func cancelTapped() {
        extensionContext?.completeRequest(returningItems: nil)
    }

    @objc private func doneTapped() {
        let item = NSExtensionItem()
        item.attachments = [NSItemProvider(item: optimizedText as NSString, typeIdentifier: UTType.plainText.identifier)]
        extensionContext?.completeRequest(returningItems: [item])
    }
}
