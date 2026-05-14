import SwiftUI
import AuthenticationServices
import StoreKit

struct ContentView: View {
    @EnvironmentObject var settings: TerseSettings
    @EnvironmentObject var auth: TerseAuth
    @StateObject private var store = TerseStore.shared
    @State private var selectedTab: Tab = .optimize
    @State private var showKeyboardSetup = false
    @State private var showSubscription = false
    @State private var keyboardInstalled = false

    enum Tab: String, CaseIterable {
        case optimize = "Optimize"
        case stats = "Stats"
        case settings = "Settings"

        var icon: String {
            switch self {
            case .optimize: return "sparkles"
            case .stats: return "chart.line.uptrend.xyaxis"
            case .settings: return "slider.horizontal.3"
            }
        }
    }

    var theme: TerseTheme { settings.currentTheme }

    var body: some View {
        ZStack {
            theme.bg.ignoresSafeArea()

            if !auth.isSignedIn {
                signInView
            } else {
                mainView
            }
        }
        .sheet(isPresented: $showKeyboardSetup) {
            KeyboardSetupView()
                .environmentObject(settings)
        }
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
        .onAppear {
            if auth.isSignedIn {
                auth.verifyLicense()
                checkKeyboardAndPrompt()
            }
        }
        .onChange(of: auth.isSignedIn) { signedIn in
            if signedIn {
                auth.verifyLicense()
                checkKeyboardAndPrompt()
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.willEnterForegroundNotification)) { _ in
            if auth.isSignedIn {
                auth.reloadUsage()
                settings.reload()
                auth.verifyLicense()
                checkKeyboardAndPrompt()
            } else {
                auth.checkPendingAuth()
            }
        }
    }

    // MARK: - Sign In View

    @ViewBuilder
    private var signInView: some View {
        VStack(spacing: 0) {
            Spacer()

            // Clean logo mark
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(theme.accent)
                .frame(width: 64, height: 64)
                .overlay(
                    Text("P")
                        .font(.system(size: 32, weight: .bold, design: .rounded))
                        .foregroundColor(.white)
                )
                .padding(.bottom, 20)

            Text(TL.s("app.name"))
                .font(.system(size: 34, weight: .bold))
                .foregroundColor(theme.t1)

            Text("Smart prompt compression")
                .font(.system(size: 15))
                .foregroundColor(theme.t3)
                .padding(.bottom, 48)

            // Features
            VStack(spacing: 20) {
                featureRow(icon: "bolt.fill", title: "Save up to 70%", detail: "on every AI prompt")
                featureRow(icon: "globe", title: "11 languages", detail: "works everywhere you type")
                featureRow(icon: "lock.fill", title: "100% on-device", detail: "your words never leave")
            }
            .padding(.bottom, 48)

            // Sign in with Apple
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
            .signInWithAppleButtonStyle(.black)
            .frame(height: 52)
            .cornerRadius(12)
            .padding(.horizontal, 32)

            if let error = auth.signInError {
                Text(error)
                    .font(.system(size: 13))
                    .foregroundColor(.red)
                    .padding(.top, 12)
            }

            Text("500 free optimizations per week")
                .font(.system(size: 12))
                .foregroundColor(theme.t3)
                .padding(.top, 16)

            Spacer()
            Spacer()
        }
    }

    private func featureRow(icon: String, text: String) -> some View {
        featureRow(icon: icon, title: text, detail: "")
    }

    private func featureRow(icon: String, title: String, detail: String) -> some View {
        HStack(spacing: 14) {
            Image(systemName: icon)
                .font(.system(size: 14))
                .foregroundColor(theme.accent)
                .frame(width: 32, height: 32)
                .background(theme.accent.opacity(0.1))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(theme.t1)
                if !detail.isEmpty {
                    Text(detail)
                        .font(.system(size: 13))
                        .foregroundColor(theme.t3)
                }
            }
            Spacer()
        }
        .padding(.horizontal, 32)
    }

    // MARK: - Main View (after sign in)

    @ViewBuilder
    private var mainView: some View {
        ZStack {
            GlassAppBackground(theme: theme)

            VStack(spacing: 0) {
                // Hero header
                heroHeader
                    .padding(.horizontal, 20)
                    .padding(.top, 8)
                    .padding(.bottom, 12)

                // Content Tabs
                TabView(selection: $selectedTab) {
                    OptimizeView()
                        .tag(Tab.optimize)

                    StatsView()
                        .tag(Tab.stats)

                    SettingsView(showKeyboardSetup: .constant(false))
                        .tag(Tab.settings)
                }
                .tabViewStyle(.page(indexDisplayMode: .never))

                // Minimal tab bar
                HStack(spacing: 0) {
                    ForEach(Tab.allCases, id: \.self) { tab in
                        Button {
                            withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                                selectedTab = tab
                            }
                        } label: {
                            VStack(spacing: 3) {
                                Image(systemName: tab.icon)
                                    .font(.system(size: 17, weight: selectedTab == tab ? .bold : .regular))
                                    .foregroundColor(selectedTab == tab ? theme.accent : theme.t3.opacity(0.5))
                                    .scaleEffect(selectedTab == tab ? 1.1 : 1.0)

                                Circle()
                                    .fill(selectedTab == tab ? theme.accent : .clear)
                                    .frame(width: 4, height: 4)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 10)
                        }
                    }
                }
                .padding(.horizontal, 40)
                .padding(.bottom, 6)
            }
        }
    }

    // MARK: - Hero Header

    @ViewBuilder
    private var heroHeader: some View {
        VStack(spacing: 12) {
            // Top row
            HStack(alignment: .center) {
                // App icon + name
                HStack(spacing: 10) {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(theme.accent)
                        .frame(width: 28, height: 28)
                        .overlay(
                            Text("P")
                                .font(.system(size: 16, weight: .bold, design: .rounded))
                                .foregroundColor(.white)
                        )
                    Text(TL.s("app.name"))
                        .font(.system(size: 20, weight: .bold))
                        .foregroundColor(theme.t1)
                }

                Spacer()

                // Status dot
                if !keyboardInstalled {
                    Circle()
                        .fill(Color.orange)
                        .frame(width: 8, height: 8)
                }

                // Pro pill
                if auth.tier == "free" && !store.isPro {
                    Button {
                        showSubscription = true
                    } label: {
                        Text("PRO")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundColor(.white)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 5)
                            .background(theme.accent)
                            .clipShape(Capsule())
                    }
                }
            }

            // Stats
            if settings.totalOptimizations > 0 {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text("\(settings.totalOptimizations)")
                        .font(.system(size: 32, weight: .bold, design: .rounded))
                        .foregroundColor(theme.t1)
                    Text(TL.s("header.saved"))
                        .font(.system(size: 13))
                        .foregroundColor(theme.t3)
                    Spacer()
                }
            }

            // Quota
            Text(auth.usageText)
                .font(.system(size: 12))
                .foregroundColor(theme.t3)
                .frame(maxWidth: .infinity, alignment: .leading)

            // Keyboard setup
            if !keyboardInstalled {
                Button {
                    showKeyboardSetup = true
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "keyboard")
                            .font(.system(size: 13))
                        Text(TL.s("header.setupKeyboard"))
                            .font(.system(size: 13, weight: .medium))
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.system(size: 11))
                    }
                    .foregroundColor(theme.accent)
                    .padding(12)
                    .background(theme.accent.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                }
            }
        }
    }

    // MARK: - Keyboard Check

    private func checkKeyboardAndPrompt() {
        let installed = isKeyboardExtensionEnabled()
        withAnimation(.spring(response: 0.3)) {
            keyboardInstalled = installed
        }
        // Always keep Terse active — keyboard optimizes automatically
        UserDefaults(suiteName: "group.com.pruneai.shared")?.set(true, forKey: "terseActive")

        if !installed && !settings.hasSeenSetup {
            showKeyboardSetup = true
        }

    }

    private func isKeyboardExtensionEnabled() -> Bool {
        let inputModes = UITextInputMode.activeInputModes
        for mode in inputModes {
            if let identifier = mode.value(forKey: "identifier") as? String {
                if identifier.contains("com.pruneai.ios") { return true }
            }
        }
        if let keyboards = UserDefaults.standard.object(forKey: "AppleKeyboards") as? [String] {
            if keyboards.contains(where: { $0.contains("com.pruneai.ios") }) { return true }
        }
        return false
    }

}

#Preview {
    ContentView()
        .environmentObject(TerseSettings.shared)
        .environmentObject(TerseAuth.shared)
}
