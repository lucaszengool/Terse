import SwiftUI

struct KeyboardSetupView: View {
    @EnvironmentObject var settings: TerseSettings
    @Environment(\.dismiss) private var dismiss
    @State private var completedSteps: Set<Int> = []
    @State private var keyboardEnabled = false
    @State private var fullAccessEnabled = false
    @State private var checkingStatus = false
    @State private var showSuccess = false

    var theme: TerseTheme { settings.currentTheme }

    var body: some View {
        ZStack {
            theme.bg.ignoresSafeArea()

            VStack(spacing: 0) {
                // Header
                HStack {
                    Spacer()
                    Button {
                        settings.hasSeenSetup = true
                        dismiss()
                    } label: {
                        Text("Done")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundColor(theme.t2)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 16)

                ScrollView {
                    VStack(spacing: 24) {
                        // Title
                        VStack(spacing: 8) {
                            Text("T")
                                .font(.system(size: 40, weight: .heavy, design: .rounded))
                                .foregroundColor(theme.t1)

                            Text("Enable Terse Keyboard")
                                .font(.system(size: 20, weight: .bold))
                                .foregroundColor(theme.t1)

                            Text("Just tap each step — we'll take you right there.")
                                .font(.system(size: 13))
                                .foregroundColor(theme.t3)
                                .multilineTextAlignment(.center)
                        }
                        .padding(.top, 12)

                        // Steps — each one is tappable and opens the right place
                        VStack(spacing: 0) {
                            // Step 1: Open Terse in Settings
                            stepButton(
                                index: 0,
                                icon: "gearshape",
                                title: "Open Terse in Settings",
                                detail: "Tap below to go to Terse's settings page. Then tap \"Keyboards\".",
                                actionLabel: "Open Settings",
                                action: {
                                    completedSteps.insert(0)
                                    openKeyboardSettings()
                                }
                            )

                            connector()

                            // Step 2: Enable Terse Keyboard + Full Access
                            stepButton(
                                index: 1,
                                icon: "keyboard",
                                title: "Enable Terse & Full Access",
                                detail: "Toggle on \"Terse\" keyboard, then tap it and enable \"Allow Full Access\" so it can read and optimize your text.",
                                actionLabel: "Open Settings",
                                action: {
                                    completedSteps.insert(1)
                                    openTerseKeyboardSettings()
                                }
                            )

                            connector()

                            // Step 3: Switch to Terse
                            stepButton(
                                index: 2,
                                icon: "globe",
                                title: "Switch to Terse",
                                detail: "In any app, tap the globe key on your keyboard to switch to Terse. It will optimize on every Send.",
                                actionLabel: "Done",
                                action: {
                                    completedSteps.insert(2)
                                }
                            )

                            connector()

                            // Step 4: Verify
                            stepButton(
                                index: 3,
                                icon: "checkmark.seal",
                                title: "Verify Setup",
                                detail: "We'll check if Terse keyboard is ready.",
                                actionLabel: keyboardEnabled ? "All Set!" : "Check Now",
                                isSuccess: keyboardEnabled,
                                action: {
                                    checkSetup()
                                }
                            )
                        }
                        .padding(.horizontal, 20)

                        // One-tap setup button
                        VStack(spacing: 10) {
                            Button {
                                openKeyboardSettings()
                                completedSteps = [0, 1]
                            } label: {
                                HStack(spacing: 8) {
                                    Image(systemName: "bolt.fill")
                                        .font(.system(size: 14, weight: .semibold))
                                    Text("Quick Setup — Open Settings")
                                        .font(.system(size: 15, weight: .bold))
                                }
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 14)
                                .background(theme.btn)
                                .foregroundColor(theme.btnText)
                                .clipShape(Capsule())
                            }

                            Text("After adding the keyboard, come back and tap \"Check Now\"")
                                .font(.system(size: 11))
                                .foregroundColor(theme.t3)
                                .multilineTextAlignment(.center)
                        }
                        .padding(.horizontal, 20)

                        // Success state
                        if showSuccess {
                            VStack(spacing: 8) {
                                Image(systemName: "checkmark.circle.fill")
                                    .font(.system(size: 40))
                                    .foregroundColor(theme.accent)

                                Text("Terse Keyboard is Ready!")
                                    .font(.system(size: 16, weight: .bold))
                                    .foregroundColor(theme.t1)

                                Text("Switch to Terse by tapping the globe key on any keyboard. Your prompts will be optimized automatically.")
                                    .font(.system(size: 12))
                                    .foregroundColor(theme.t3)
                                    .multilineTextAlignment(.center)

                                Button {
                                    settings.hasSeenSetup = true
                                    dismiss()
                                } label: {
                                    Text("Get Started")
                                        .font(.system(size: 15, weight: .bold))
                                        .frame(maxWidth: .infinity)
                                        .padding(.vertical, 14)
                                        .background(theme.accent)
                                        .foregroundColor(.white)
                                        .clipShape(Capsule())
                                }
                                .padding(.top, 4)
                            }
                            .padding(20)
                            .background(theme.sf)
                            .clipShape(RoundedRectangle(cornerRadius: 16))
                            .padding(.horizontal, 20)
                            .transition(.scale.combined(with: .opacity))
                        }

                        // Privacy note
                        VStack(spacing: 6) {
                            HStack(spacing: 4) {
                                Image(systemName: "lock.shield.fill")
                                    .font(.system(size: 10))
                                Text("Privacy Note")
                                    .font(.system(size: 10, weight: .bold))
                            }
                            .foregroundColor(theme.t3)

                            Text("Full Access is required so Terse can read and optimize your text. All processing happens on-device. No data is sent to any server.")
                                .font(.system(size: 10))
                                .foregroundColor(theme.t3)
                                .multilineTextAlignment(.center)
                        }
                        .padding(.horizontal, 32)
                        .padding(.bottom, 40)
                    }
                }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.willEnterForegroundNotification)) { _ in
            // Auto-check when user returns from Settings
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                checkSetup()
            }
        }
        .animation(.easeInOut(duration: 0.3), value: showSuccess)
        .animation(.easeInOut(duration: 0.2), value: completedSteps)
        .animation(.easeInOut(duration: 0.2), value: keyboardEnabled)
    }

    // MARK: - Step Button

    private func stepButton(
        index: Int,
        icon: String,
        title: String,
        detail: String,
        actionLabel: String,
        isSuccess: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(alignment: .center, spacing: 12) {
                // Step number
                ZStack {
                    Circle()
                        .fill(completedSteps.contains(index) || isSuccess ? theme.accent : theme.btn)
                        .frame(width: 32, height: 32)

                    if completedSteps.contains(index) || isSuccess {
                        Image(systemName: "checkmark")
                            .font(.system(size: 13, weight: .bold))
                            .foregroundColor(.white)
                    } else {
                        Text("\(index + 1)")
                            .font(.system(size: 14, weight: .bold))
                            .foregroundColor(theme.btnText)
                    }
                }

                // Content
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Image(systemName: icon)
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundColor(completedSteps.contains(index) ? theme.accent : theme.t2)
                        Text(title)
                            .font(.system(size: 14, weight: .bold))
                            .foregroundColor(theme.t1)
                    }
                    Text(detail)
                        .font(.system(size: 11))
                        .foregroundColor(theme.t3)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer()

                // Action arrow/button
                if !isSuccess {
                    HStack(spacing: 4) {
                        Text(actionLabel)
                            .font(.system(size: 11, weight: .semibold))
                        Image(systemName: "arrow.up.right")
                            .font(.system(size: 9, weight: .bold))
                    }
                    .foregroundColor(theme.accent)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(theme.accent.opacity(0.12))
                    .clipShape(Capsule())
                } else {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 20))
                        .foregroundColor(theme.accent)
                }
            }
            .padding(12)
            .background(theme.sf)
            .clipShape(RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.plain)
    }

    private func connector() -> some View {
        HStack {
            Spacer().frame(width: 35)
            Rectangle()
                .fill(theme.border)
                .frame(width: 2, height: 16)
            Spacer()
        }
    }

    // MARK: - Deep Link Actions

    private func openKeyboardSettings() {
        // Open the Terse app's own Settings page — shows "Keyboards" section
        // where user can enable the keyboard and toggle Full Access
        if let url = URL(string: UIApplication.openSettingsURLString) {
            UIApplication.shared.open(url)
        }
    }

    private func openTerseKeyboardSettings() {
        // Same destination — app's Settings page has the keyboard toggle
        openKeyboardSettings()
    }

    // MARK: - Check Setup

    private func checkSetup() {
        checkingStatus = true

        let enabled = isKeyboardExtensionEnabled()
        withAnimation {
            keyboardEnabled = enabled
            if enabled {
                completedSteps = [0, 1, 2, 3]
                showSuccess = true
                settings.hasSeenSetup = true
            }
            checkingStatus = false
        }
    }

    private func isKeyboardExtensionEnabled() -> Bool {
        // Check active input modes
        let inputModes = UITextInputMode.activeInputModes
        for mode in inputModes {
            if let identifier = mode.value(forKey: "identifier") as? String {
                if identifier.contains("com.terse.ios") {
                    return true
                }
            }
        }
        // Check registered keyboards
        if let keyboards = UserDefaults.standard.object(forKey: "AppleKeyboards") as? [String] {
            if keyboards.contains(where: { $0.contains("com.terse.ios") }) {
                return true
            }
        }
        return false
    }
}

#Preview {
    KeyboardSetupView()
        .environmentObject(TerseSettings.shared)
}
