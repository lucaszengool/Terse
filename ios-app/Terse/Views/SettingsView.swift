import SwiftUI
import AuthenticationServices
import StoreKit

struct SettingsView: View {
    @EnvironmentObject var settings: TerseSettings
    @EnvironmentObject var auth: TerseAuth
    @StateObject private var store = TerseStore.shared
    @Binding var showKeyboardSetup: Bool
    @State private var showSubscription = false
    @State private var showDeleteConfirm = false

    var theme: TerseTheme { settings.currentTheme }

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                // Header
                HStack {
                    Text("Settings")
                        .font(.system(size: 24, weight: .semibold))
                        .foregroundColor(theme.t1)
                    Spacer()
                }
                .padding(.horizontal, 20)
                .padding(.top, 12)

                // ── Account ──
                VStack(alignment: .leading, spacing: 10) {
                    sectionTitle("ACCOUNT")

                    if auth.isSignedIn {
                        VStack(spacing: 0) {
                            // User info
                            HStack(spacing: 12) {
                                RoundedRectangle(cornerRadius: 10, style: .continuous)
                                    .fill(theme.sf)
                                    .frame(width: 36, height: 36)
                                    .overlay(
                                        Text(String(auth.firstName?.prefix(1) ?? "?"))
                                            .font(.system(size: 14, weight: .bold))
                                            .foregroundColor(theme.t1)
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
                                    .font(.system(size: 11, weight: .semibold))
                                    .foregroundColor(.white)
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 4)
                                    .background(
                                        auth.tier == "free" ? Color.gray :
                                        auth.tier == "pro" ? theme.accent :
                                        Color.purple
                                    )
                                    .clipShape(Capsule())
                            }
                            .padding(16)

                            Divider().background(theme.border)

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
                            .padding(16)

                            // Upgrade button for free users
                            if auth.tier == "free" && !store.isPro {
                                Divider().background(theme.border)

                                Button {
                                    showSubscription = true
                                } label: {
                                    HStack {
                                        Image(systemName: "arrow.up.circle.fill")
                                            .font(.system(size: 14))
                                        Text("Upgrade to Pro")
                                            .font(.system(size: 13, weight: .bold))
                                        Spacer()
                                        Image(systemName: "chevron.right")
                                            .font(.system(size: 12, weight: .semibold))
                                            .foregroundColor(theme.t3)
                                    }
                                    .foregroundColor(theme.accent)
                                    .padding(16)
                                }

                                // Restore purchases
                                Divider().background(theme.border)

                                Button {
                                    Task { await store.restore() }
                                } label: {
                                    HStack {
                                        Image(systemName: "arrow.clockwise")
                                            .font(.system(size: 14))
                                        Text("Restore Purchases")
                                            .font(.system(size: 13, weight: .medium))
                                        Spacer()
                                    }
                                    .foregroundColor(theme.t2)
                                    .padding(16)
                                }
                            }

                            Divider().background(theme.border)

                            // Terms & Privacy
                            HStack(spacing: 16) {
                                Link("Terms of Use", destination: URL(string: "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/")!)
                                    .font(.system(size: 11))
                                Link("Privacy Policy", destination: URL(string: "https://www.pruneai.com/privacy")!)
                                    .font(.system(size: 11))
                            }
                            .foregroundColor(theme.t3)
                            .padding(16)

                            Divider().background(theme.border)

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
                                .padding(16)
                            }

                            Divider().background(theme.border)

                            // Delete Account
                            Button {
                                showDeleteConfirm = true
                            } label: {
                                HStack {
                                    Image(systemName: "trash")
                                        .font(.system(size: 14))
                                    Text("Delete Account")
                                        .font(.system(size: 13, weight: .medium))
                                    Spacer()
                                }
                                .foregroundColor(.red.opacity(0.7))
                                .padding(16)
                            }
                        }
                        .background(theme.sf)
                        .clipShape(RoundedRectangle(cornerRadius: 16))
                    } else {
                        SignInWithAppleButton(.signIn) { request in
                            request.requestedScopes = [.email, .fullName]
                        } onCompletion: { result in
                            switch result {
                            case .success(let authorization):
                                if let credential = authorization.credential as? ASAuthorizationAppleIDCredential {
                                    auth.signInWithApple(credential: credential)
                                }
                            case .failure(let error):
                                print("[Apple Sign In] Error: \(error.localizedDescription)")
                            }
                        }
                        .signInWithAppleButtonStyle(.white)
                        .frame(height: 44)
                        .cornerRadius(16)
                    }
                }
                .padding(.horizontal, 20)

                // ── Mode ──
                VStack(alignment: .leading, spacing: 10) {
                    sectionTitle("MODE")

                    HStack(spacing: 20) {
                        ForEach(AggressivenessMode.allCases, id: \.self) { mode in
                            Button {
                                if let m = AggressivenessMode.allCases.first(where: { $0.label == mode.label }) {
                                    settings.aggressiveness = m
                                }
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

                    Text(settings.aggressiveness.description)
                        .font(.system(size: 11))
                        .foregroundColor(theme.t3)
                }
                .padding(.horizontal, 20)

                // ── Optimization Toggles ──
                VStack(alignment: .leading, spacing: 8) {
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
                    .background(theme.sf)
                    .clipShape(RoundedRectangle(cornerRadius: 16))
                }
                .padding(.horizontal, 20)

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
                .padding(.horizontal, 20)

                // Version
                Text("PruneAI v1.0")
                    .font(.system(size: 10))
                    .foregroundColor(theme.t3.opacity(0.5))
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.top, 8)

                Spacer(minLength: 40)
            }
        }
        .background(Color.clear)
        .sheet(isPresented: $showSubscription) {
            if #available(iOS 17.0, *) {
                SubscriptionStoreView(productIDs: ["com.pruneai.pro.monthly"])
                    .subscriptionStoreControlStyle(.prominentPicker)
                    .storeButton(.visible, for: .redeemCode)
                    .onInAppPurchaseCompletion { _, result in
                        if case .success(.success) = result {
                            Task {
                                await store.updatePurchasedProducts()
                                await store.syncLatestTransaction()
                                TerseAuth.shared.verifyLicense()
                            }
                            showSubscription = false
                        }
                    }
            } else {
                Text("Please update to iOS 17 or later to subscribe.")
                    .padding()
            }
        }
        .alert("Delete Account", isPresented: $showDeleteConfirm) {
            Button("Cancel", role: .cancel) { }
            Button("Delete", role: .destructive) {
                auth.deleteAccount()
            }
        } message: {
            Text("This will permanently delete your account and all associated data. This action cannot be undone. If you have an active subscription, please cancel it in Settings > Subscriptions before deleting.")
        }
    }

    // MARK: - Helpers

    private func sectionTitle(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 11, weight: .medium))
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
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private var settingsDivider: some View {
        Divider()
            .background(theme.border)
    }
}

#Preview {
    SettingsView(showKeyboardSetup: .constant(false))
        .environmentObject(TerseSettings.shared)
        .environmentObject(TerseAuth.shared)
}
