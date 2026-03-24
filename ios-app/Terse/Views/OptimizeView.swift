import SwiftUI

struct OptimizeView: View {
    @EnvironmentObject var settings: TerseSettings
    @EnvironmentObject var auth: TerseAuth
    @State private var inputText: String = ""
    @State private var optimizedText: String = ""
    @State private var beforeTokens: Int = 0
    @State private var afterTokens: Int = 0
    @State private var techniques: [String] = []
    @State private var hasResult: Bool = false
    @State private var copied: Bool = false
    @State private var isOptimizing: Bool = false

    var theme: TerseTheme { settings.currentTheme }

    var savedPercent: Int {
        guard beforeTokens > 0 else { return 0 }
        return Int(round(Double(beforeTokens - afterTokens) / Double(beforeTokens) * 100))
    }

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: 20) {
                // Mode selector — minimal
                HStack {
                    ToggleGroup(
                        options: AggressivenessMode.allCases.map { $0.label },
                        selected: settings.aggressiveness.label,
                        theme: theme
                    ) { label in
                        if let mode = AggressivenessMode.allCases.first(where: { $0.label == label }) {
                            settings.aggressiveness = mode
                        }
                    }
                    Spacer()
                }
                .padding(.horizontal, 20)
                .padding(.top, 4)

                // Input area — clean glass card
                VStack(alignment: .leading, spacing: 12) {
                    ZStack(alignment: .topLeading) {
                        if inputText.isEmpty {
                            Text(TL.s("optimize.placeholder"))
                                .font(.system(size: 15, weight: .regular))
                                .foregroundColor(theme.t3.opacity(0.5))
                                .padding(.horizontal, 14)
                                .padding(.vertical, 14)
                        }

                        TextEditor(text: $inputText)
                            .font(.system(size: 15))
                            .foregroundColor(theme.t1)
                            .scrollContentBackground(.hidden)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .frame(minHeight: 130, maxHeight: 200)
                    }
                    .glassCard(cornerRadius: 14)

                    // Optimize button — prominent
                    Button {
                        optimize()
                    } label: {
                        Text(isOptimizing ? TL.s("optimize.optimizing") : TL.s("optimize.button"))
                            .font(.system(size: 15, weight: .bold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 15)
                            .background(theme.accent)
                            .foregroundColor(.white)
                            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                            .shadow(color: theme.accent.opacity(0.35), radius: 12, y: 5)
                    }
                    .disabled(inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isOptimizing)
                    .opacity(inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.4 : 1)
                    .scaleEffect(isOptimizing ? 0.97 : 1.0)
                    .animation(.spring(response: 0.3), value: isOptimizing)
                }
                .padding(.horizontal, 20)

                // Results
                if hasResult {
                    VStack(spacing: 16) {
                        // Big savings number
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text("-\(savedPercent)%")
                                .font(.system(size: 42, weight: .black, design: .rounded))
                                .foregroundColor(theme.accent)

                            VStack(alignment: .leading, spacing: 2) {
                                Text("\(beforeTokens) → \(afterTokens) tokens")
                                    .font(.system(size: 12, weight: .medium, design: .monospaced))
                                    .foregroundColor(theme.t3)
                            }
                            Spacer()
                        }
                        .padding(.horizontal, 20)

                        // Technique pills
                        if !techniques.isEmpty {
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 6) {
                                    ForEach(techniques, id: \.self) { t in
                                        Text(t)
                                            .font(.system(size: 10, weight: .semibold))
                                            .foregroundColor(theme.t2)
                                            .padding(.horizontal, 10)
                                            .padding(.vertical, 5)
                                            .background(.ultraThinMaterial, in: Capsule())
                                    }
                                }
                                .padding(.horizontal, 20)
                            }
                        }

                        // Optimized output
                        VStack(alignment: .leading, spacing: 8) {
                            Text(optimizedText)
                                .font(.system(size: 14))
                                .foregroundColor(theme.t1)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(14)
                                .glassCard(cornerRadius: 12)
                                .textSelection(.enabled)

                            // Copy button — minimal
                            Button {
                                UIPasteboard.general.string = optimizedText
                                withAnimation(.spring(response: 0.3)) { copied = true }
                                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                                    withAnimation { copied = false }
                                }
                            } label: {
                                HStack(spacing: 6) {
                                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                                        .font(.system(size: 11, weight: .semibold))
                                    Text(copied ? TL.s("optimize.copied") : TL.s("optimize.copy"))
                                        .font(.system(size: 13, weight: .semibold))
                                }
                                .foregroundColor(copied ? .white : theme.t2)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 12)
                                .background {
                                    if copied {
                                        RoundedRectangle(cornerRadius: 12, style: .continuous).fill(theme.accent)
                                    } else {
                                        RoundedRectangle(cornerRadius: 12, style: .continuous).fill(.ultraThinMaterial)
                                    }
                                }
                            }
                        }
                        .padding(.horizontal, 20)
                    }
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
                }

                Spacer(minLength: 30)
            }
        }
        .background(Color.clear)
    }

    private func optimize() {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        isOptimizing = true

        DispatchQueue.global(qos: .userInitiated).async {
            let optimizer = TerseOptimizer()
            settings.applyTo(optimizer)
            let result = optimizer.optimize(text)

            DispatchQueue.main.async {
                withAnimation(.spring(response: 0.4, dampingFraction: 0.8)) {
                    beforeTokens = result.stats.originalTokens
                    afterTokens = result.stats.optimizedTokens
                    optimizedText = result.optimized
                    techniques = result.stats.techniquesApplied
                    hasResult = true
                    isOptimizing = false
                }
                TerseStats.shared.record(
                    tokensIn: result.stats.originalTokens,
                    tokensSaved: result.stats.tokensSaved,
                    source: "manual"
                )
                auth.recordOptimization()
            }
        }
    }
}

#Preview {
    OptimizeView()
        .environmentObject(TerseSettings.shared)
}
