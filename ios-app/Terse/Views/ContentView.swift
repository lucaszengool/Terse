import SwiftUI
import ActivityKit

struct ContentView: View {
    @EnvironmentObject var settings: TerseSettings
    @EnvironmentObject var auth: TerseAuth
    @State private var selectedTab: Tab = .optimize
    @State private var currentActivity: Activity<TerseActivityAttributes>?
    @State private var showKeyboardSetup = false
    @State private var keyboardInstalled = false

    enum Tab: String, CaseIterable {
        case optimize = "Optimize"
        case stats = "Stats"
        case settings = "Settings"

        var icon: String {
            switch self {
            case .optimize: return "wand.and.stars"
            case .stats: return "chart.bar.fill"
            case .settings: return "gearshape.fill"
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
        .onAppear {
            if auth.isSignedIn {
                auth.verifyLicense()
                restoreLiveActivity()
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
                auth.verifyLicense()
                settings.reload()
                checkKeyboardAndPrompt()
            } else {
                auth.checkPendingAuth()
            }
        }
    }

    // MARK: - Sign In View

    @ViewBuilder
    private var signInView: some View {
        VStack(spacing: 24) {
            Spacer()

            // Logo
            VStack(spacing: 8) {
                Text(TL.s( "app.name"))
                    .font(.system(size: 42, weight: .black))
                    .foregroundColor(theme.t1)
                Text("Prompt Optimizer")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundColor(theme.t3)
            }

            // Description
            VStack(spacing: 12) {
                featureRow(icon: "bolt.fill", text: "Reduce token usage up to 70%")
                featureRow(icon: "globe", text: "Works with any language")
                featureRow(icon: "square.and.arrow.up", text: "Optimize from any app via Share")
            }
            .padding(.vertical, 20)

            // Sign In Button
            Button {
                auth.startSignIn { url in
                    if let url = url {
                        UIApplication.shared.open(url)
                    }
                }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "person.crop.circle.fill")
                        .font(.system(size: 18))
                    Text("Sign In to Get Started")
                        .font(.system(size: 16, weight: .bold))
                }
                .foregroundColor(theme.btnText)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(theme.btn)
                .cornerRadius(14)
            }
            .padding(.horizontal, 40)

            Text("Free: 500 optimizations/week")
                .font(.system(size: 12))
                .foregroundColor(theme.t3)

            Spacer()
        }
    }

    private func featureRow(icon: String, text: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 14))
                .foregroundColor(theme.accent)
                .frame(width: 24)
            Text(text)
                .font(.system(size: 14))
                .foregroundColor(theme.t2)
            Spacer()
        }
        .padding(.horizontal, 40)
    }

    // MARK: - Main View (after sign in)

    @ViewBuilder
    private var mainView: some View {
        ZStack {
            GlassAppBackground(theme: theme)

            VStack(spacing: 0) {
                // Hero header — compact, one line
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

                // Minimal tab bar — icons only, glass pill
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
                .background(.ultraThinMaterial)
            }
        }
    }

    // MARK: - Hero Header

    @ViewBuilder
    private var heroHeader: some View {
        VStack(spacing: 12) {
            HStack(spacing: 12) {
                // Status dot
                Circle()
                    .fill(keyboardInstalled ? theme.accent : Color.orange)
                    .frame(width: 8, height: 8)
                    .shadow(color: keyboardInstalled ? theme.accent.opacity(0.6) : Color.orange.opacity(0.6), radius: 6)

                // App name
                Text(TL.s( "app.name"))
                    .font(.system(size: 22, weight: .black))
                    .foregroundColor(theme.t1)

                Spacer()

                // Saved count
                if settings.totalTokensSaved > 0 {
                    HStack(spacing: 4) {
                        Text("\(settings.totalTokensSaved)")
                            .font(.system(size: 15, weight: .black, design: .rounded))
                            .foregroundColor(theme.accent)
                        Text(TL.s("header.saved"))
                            .font(.system(size: 10, weight: .medium))
                            .foregroundColor(theme.t3.opacity(0.5))
                    }
                }

                // Upgrade pill (free only)
                if auth.tier == "free" {
                    Button {
                        if let url = URL(string: "https://www.terseai.org/#pricing") {
                            UIApplication.shared.open(url)
                        }
                    } label: {
                        Text(TL.s("header.pro"))
                            .font(.system(size: 10, weight: .black))
                            .foregroundColor(.white)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 5)
                            .background(theme.accent.opacity(0.8))
                            .clipShape(Capsule())
                    }
                }
            }

            // Keyboard not installed banner
            if !keyboardInstalled {
                Button {
                    showKeyboardSetup = true
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "keyboard")
                            .font(.system(size: 13, weight: .semibold))
                        Text(TL.s("header.setupKeyboard"))
                            .font(.system(size: 13, weight: .bold))
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.system(size: 11, weight: .semibold))
                    }
                    .foregroundColor(theme.accent)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 11)
                    .glassCard(cornerRadius: 12)
                }
            }

            // Quota bar
            HStack {
                Text(auth.usageText)
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundColor(theme.t3.opacity(0.6))
                Spacer()
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
        UserDefaults(suiteName: "group.com.terse.shared")?.set(true, forKey: "terseActive")

        if !installed && !settings.hasSeenSetup {
            showKeyboardSetup = true
        }

        // Start/refresh live activity
        startLiveActivity()
    }

    private func isKeyboardExtensionEnabled() -> Bool {
        let inputModes = UITextInputMode.activeInputModes
        for mode in inputModes {
            if let identifier = mode.value(forKey: "identifier") as? String {
                if identifier.contains("com.terse.ios") { return true }
            }
        }
        if let keyboards = UserDefaults.standard.object(forKey: "AppleKeyboards") as? [String] {
            if keyboards.contains(where: { $0.contains("com.terse.ios") }) { return true }
        }
        return false
    }

    private func startLiveActivity() {
        guard #available(iOS 16.2, *) else { return }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }

        let attributes = TerseActivityAttributes(startTime: Date())
        let pct = settings.totalTokensOptimized > 0
            ? Int(Double(settings.totalTokensSaved) / Double(settings.totalTokensOptimized) * 100)
            : 0
        let state = TerseActivityAttributes.ContentState(
            tokensSaved: settings.totalTokensSaved,
            totalOptimizations: settings.totalOptimizations,
            mode: settings.aggressiveness.rawValue,
            autoMode: settings.autoMode,
            percentSaved: pct,
            isActive: true
        )

        do {
            let activity = try Activity.request(
                attributes: attributes,
                content: .init(state: state, staleDate: nil),
                pushType: nil
            )
            currentActivity = activity
        } catch {
            print("Live Activity error: \(error)")
        }
    }

    private func restoreLiveActivity() {
        if #available(iOS 16.2, *) {
            if let existing = Activity<TerseActivityAttributes>.activities.first {
                currentActivity = existing
            }
        }
    }
}

#Preview {
    ContentView()
        .environmentObject(TerseSettings.shared)
        .environmentObject(TerseAuth.shared)
}
