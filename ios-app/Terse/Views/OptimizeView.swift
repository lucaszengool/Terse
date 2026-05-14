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
                // Mode selector — underline style
                HStack(spacing: 20) {
                    ForEach(AggressivenessMode.allCases, id: \.self) { mode in
                        Button {
                            settings.aggressiveness = mode
                        } label: {
                            VStack(spacing: 4) {
                                Text(mode.label)
                                    .font(.system(size: 13, weight: settings.aggressiveness == mode ? .bold : .medium))
                                    .foregroundColor(settings.aggressiveness == mode ? theme.t1 : theme.t3)
                                Rectangle()
                                    .fill(settings.aggressiveness == mode ? theme.accent : Color.clear)
                                    .frame(height: 2)
                            }
                        }
                    }
                    Spacer()
                }
                .padding(.horizontal, 20)
                .padding(.top, 8)

                // Input area — clean bordered rectangle
                VStack(alignment: .leading, spacing: 12) {
                    ZStack(alignment: .topLeading) {
                        if inputText.isEmpty {
                            Text(TL.s("optimize.placeholder"))
                                .font(.system(size: 15))
                                .foregroundColor(theme.t3.opacity(0.5))
                                .padding(.horizontal, 16)
                                .padding(.vertical, 16)
                        }

                        TextEditor(text: $inputText)
                            .font(.system(size: 15))
                            .foregroundColor(theme.t1)
                            .scrollContentBackground(.hidden)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .frame(minHeight: 140, maxHeight: 220)
                    }
                    .background(theme.sf)
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .stroke(theme.border, lineWidth: 0.5)
                    )

                    // Optimize button
                    Button {
                        optimize()
                    } label: {
                        Text(isOptimizing ? TL.s("optimize.optimizing") : TL.s("optimize.button"))
                            .font(.system(size: 15, weight: .bold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 15)
                            .background(theme.accent)
                            .foregroundColor(.white)
                            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                    }
                    .disabled(inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isOptimizing)
                    .opacity(inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.4 : 1)
                }
                .padding(.horizontal, 20)

                // Results
                if hasResult {
                    VStack(spacing: 16) {
                        // Big savings number
                        VStack(alignment: .leading, spacing: 4) {
                            Text("-\(savedPercent)%")
                                .font(.system(size: 44, weight: .bold, design: .rounded))
                                .foregroundColor(theme.t1)
                            Text("\(beforeTokens) → \(afterTokens) tokens")
                                .font(.system(size: 14, weight: .regular))
                                .foregroundColor(theme.t3)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 20)

                        // Optimized output
                        VStack(alignment: .leading, spacing: 8) {
                            Text(optimizedText)
                                .font(.system(size: 14))
                                .foregroundColor(theme.t1)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(14)
                                .background(theme.sf)
                                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                                        .stroke(theme.border, lineWidth: 0.5)
                                )
                                .textSelection(.enabled)

                            // Copy button
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
                                        RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.white.opacity(0.25))
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
