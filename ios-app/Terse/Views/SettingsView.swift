import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var settings: TerseSettings
    @EnvironmentObject var auth: TerseAuth
    @Binding var showKeyboardSetup: Bool

    var theme: TerseTheme { settings.currentTheme }

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                // Header
                HStack {
                    Text("SETTINGS")
                        .font(.system(size: 13, weight: .heavy))
                        .tracking(1.2)
                        .foregroundColor(theme.t2)
                    Spacer()
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)

                // ── Account ──
                VStack(alignment: .leading, spacing: 10) {
                    sectionTitle("ACCOUNT")

                    if auth.isSignedIn {
                        VStack(spacing: 0) {
                            // User info
                            HStack(spacing: 12) {
                                Circle()
                                    .fill(theme.accent)
                                    .frame(width: 36, height: 36)
                                    .overlay(
                                        Text(String(auth.firstName?.prefix(1) ?? "?"))
                                            .font(.system(size: 14, weight: .bold))
                                            .foregroundColor(.white)
                                    )

                                VStack(alignment: .leading, spacing: 2) {
                                    Text(auth.firstName ?? "User")
                                        .font(.system(size: 14, weight: .bold))
                                        .foregroundColor(theme.t1)
                                    Text(auth.email ?? "")
                                        .font(.system(size: 11))
                                        .foregroundColor(theme.t3)
                                }

                                Spacer()

                                // Plan badge
                                Text(auth.tierLabel)
                                    .font(.system(size: 11, weight: .bold))
                                    .foregroundColor(.white)
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 4)
                                    .background(
                                        auth.tier == "free" ? Color.gray :
                                        auth.tier == "pro" ? theme.accent :
                                        Color.purple
                                    )
                                    .cornerRadius(10)
                            }
                            .padding(14)

                            Divider().background(theme.border).padding(.leading, 14)

                            // Usage
                            HStack {
                                Image(systemName: "chart.bar.fill")
                                    .font(.system(size: 14))
                                    .foregroundColor(theme.t3)
                                Text("Weekly Usage")
                                    .font(.system(size: 13, weight: .medium))
                                    .foregroundColor(theme.t1)
                                Spacer()
                                Text(auth.usageText)
                                    .font(.system(size: 12, weight: .semibold, design: .monospaced))
                                    .foregroundColor(auth.remaining <= 10 && !auth.isUnlimited ? .orange : theme.accent)
                            }
                            .padding(14)

                            // Upgrade button for free users
                            if auth.tier == "free" {
                                Divider().background(theme.border).padding(.leading, 14)

                                Button {
                                    if let url = URL(string: "https://www.terseai.org/#pricing") {
                                        UIApplication.shared.open(url)
                                    }
                                } label: {
                                    HStack {
                                        Image(systemName: "arrow.up.circle.fill")
                                            .font(.system(size: 14))
                                        Text("Upgrade to Pro")
                                            .font(.system(size: 13, weight: .bold))
                                        Spacer()
                                        Text("$7.99/mo")
                                            .font(.system(size: 12, weight: .medium))
                                            .foregroundColor(theme.t3)
                                    }
                                    .foregroundColor(theme.accent)
                                    .padding(14)
                                }
                            }

                            Divider().background(theme.border).padding(.leading, 14)

                            // Sign Out
                            Button {
                                auth.signOut()
                            } label: {
                                HStack {
                                    Image(systemName: "rectangle.portrait.and.arrow.right")
                                        .font(.system(size: 14))
                                    Text("Sign Out")
                                        .font(.system(size: 13, weight: .medium))
                                    Spacer()
                                }
                                .foregroundColor(.red)
                                .padding(14)
                            }
                        }
                        .background(theme.sf)
                        .clipShape(RoundedRectangle(cornerRadius: 14))
                    } else {
                        Button {
                            auth.startSignIn { url in
                                if let url = url {
                                    UIApplication.shared.open(url)
                                }
                            }
                        } label: {
                            HStack {
                                Image(systemName: "person.circle.fill")
                                    .font(.system(size: 16))
                                    .foregroundColor(theme.t3)
                                Text("Sign In")
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundColor(theme.t1)
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 12, weight: .semibold))
                                    .foregroundColor(theme.t3)
                            }
                            .padding(14)
                            .background(theme.sf)
                            .clipShape(RoundedRectangle(cornerRadius: 14))
                        }
                    }
                }
                .padding(.horizontal, 16)

                // ── Aggressiveness ──
                VStack(alignment: .leading, spacing: 10) {
                    sectionTitle("AGGRESSIVENESS")

                    ToggleGroup(
                        options: AggressivenessMode.allCases.map { $0.label },
                        selected: settings.aggressiveness.label,
                        theme: theme
                    ) { label in
                        if let mode = AggressivenessMode.allCases.first(where: { $0.label == label }) {
                            settings.aggressiveness = mode
                        }
                    }

                    Text(settings.aggressiveness.description)
                        .font(.system(size: 10))
                        .foregroundColor(theme.t3)
                }
                .padding(.horizontal, 16)

                // ── Optimization Toggles ──
                VStack(alignment: .leading, spacing: 6) {
                    sectionTitle("OPTIMIZATION FEATURES")

                    VStack(spacing: 0) {
                        settingsToggle("Remove filler words", isOn: $settings.removeFillerWords)
                        settingsDivider
                        settingsToggle("Remove politeness", isOn: $settings.removePoliteness)
                        settingsDivider
                        settingsToggle("Remove hedging", isOn: $settings.removeHedging)
                        settingsDivider
                        settingsToggle("Remove meta-language", isOn: $settings.removeMetaLanguage)
                        settingsDivider
                        settingsToggle("Shorten phrases", isOn: $settings.shortenPhrases)
                        settingsDivider
                        settingsToggle("Simplify vocabulary", isOn: $settings.simplifyInstructions)
                        settingsDivider
                        settingsToggle("Remove redundancy", isOn: $settings.removeRedundancy)
                        settingsDivider
                        settingsToggle("Compress whitespace", isOn: $settings.compressWhitespace)
                        settingsDivider
                        settingsToggle("Compress code", isOn: $settings.compressCodeBlocks)
                    }
                    .glassCard(cornerRadius: 14)
                }
                .padding(.horizontal, 16)

                // ── Theme ──
                VStack(alignment: .leading, spacing: 10) {
                    sectionTitle("THEME")

                    ThemePicker(
                        selected: settings.theme.rawValue,
                        theme: theme
                    ) { name in
                        settings.theme = TerseThemeName(rawValue: name) ?? .lime
                    }
                }
                .padding(.horizontal, 16)

                // Version
                Text("Terse v1.0.0")
                    .font(.system(size: 10))
                    .foregroundColor(theme.t3.opacity(0.5))
                    .padding(.top, 8)

                Spacer(minLength: 40)
            }
        }
        .background(Color.clear)
    }

    // MARK: - Helpers

    private func sectionTitle(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 10, weight: .bold))
            .tracking(0.5)
            .foregroundColor(theme.t3)
    }

    private func settingsToggle(_ label: String, isOn: Binding<Bool>) -> some View {
        Toggle(isOn: isOn) {
            Text(label)
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(theme.t1)
        }
        .tint(theme.accent)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private var settingsDivider: some View {
        Divider()
            .background(theme.border)
            .padding(.leading, 14)
    }
}

#Preview {
    SettingsView(showKeyboardSetup: .constant(false))
        .environmentObject(TerseSettings.shared)
        .environmentObject(TerseAuth.shared)
}
