import SwiftUI

struct StatsView: View {
    @EnvironmentObject var settings: TerseSettings
    @State private var selectedPeriod: StatsPeriod = .month
    @State private var statsData: StatsData = .empty
    @State private var showShareSheet = false
    @State private var isTapped = false
    @State private var appeared = false
    @State private var showAllThemes = false
    @State private var shopIndex = 0
    @State private var unlockTarget: TerseThemeName? = nil
    @State private var showUnlockConfirm = false
    @State private var selectedCard: TerseThemeName? = nil
    @Environment(\.displayScale) private var displayScale

    var theme: TerseTheme { settings.currentTheme }

    // Tokens as currency (bitcoin-style icon)
    private var totalTokensSaved: Int {
        settings.totalTokensSaved
    }
    private var spentTokens: Int {
        let d = UserDefaults(suiteName: "group.com.terseai.shared")
        return d?.integer(forKey: "spentTokens") ?? 0
    }
    private var availableTokens: Int {
        max(0, totalTokensSaved - spentTokens)
    }

    private static let freeThemes: Set<String> = [
        "lime", "lavender", "coral", "teal", "midnight", "rose", "sage", "sand"
    ]

    private var unlockedThemes: Set<String> {
        let d = UserDefaults(suiteName: "group.com.terseai.shared")
        let unlocked = d?.stringArray(forKey: "unlockedThemes") ?? []
        return Self.freeThemes.union(unlocked)
    }

    // Cost estimate: avg conversation = ~$0.15 (multi-turn, input+output, premium models)
    // Each optimized message saves reduction% of that conversation cost
    private var moneySaved: Double {
        guard statsData.percentSaved > 0, statsData.messagesTotal > 0 else { return 0 }
        return Double(statsData.messagesTotal) * 0.15 * Double(statsData.percentSaved) / 100.0
    }

    private var avgTokensPerMsg: Int {
        guard statsData.messagesTotal > 0 else { return 0 }
        return statsData.tokensSaved / statsData.messagesTotal
    }

    private var bestDay: DayStats? {
        statsData.byDay.max(by: { $0.tokensSaved < $1.tokensSaved })
    }

    private var efficiency: String {
        let pct = statsData.percentSaved
        if pct >= 50 { return "EXCELLENT" }
        if pct >= 30 { return "GREAT" }
        if pct >= 15 { return "GOOD" }
        if pct > 0 { return "FAIR" }
        return "---"
    }

    enum StatsPeriod: String, CaseIterable {
        case day = "Today"
        case week = "Week"
        case month = "Month"
        case all = "All Time"
    }

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: 20) {
                // Period selector
                HStack(spacing: 2) {
                    ForEach(StatsPeriod.allCases, id: \.self) { period in
                        Button {
                            withAnimation(.spring(response: 0.3)) {
                                selectedPeriod = period
                            }
                            loadStats()
                        } label: {
                            Text(period.rawValue)
                                .font(.system(size: 11, weight: selectedPeriod == period ? .bold : .medium))
                                .foregroundColor(selectedPeriod == period ? theme.accent : theme.t3.opacity(0.6))
                                .padding(.horizontal, 14)
                                .padding(.vertical, 8)
                                .background(
                                    selectedPeriod == period
                                        ? AnyShapeStyle(.ultraThinMaterial)
                                        : AnyShapeStyle(.clear)
                                    , in: Capsule()
                                )
                        }
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 4)

                // 3D Receipt card
                receiptCard
                    .padding(.horizontal, 24)
                    .rotation3DEffect(
                        .degrees(isTapped ? 8 : 0),
                        axis: (x: 1, y: 0.2, z: 0),
                        perspective: 0.5
                    )
                    .scaleEffect(isTapped ? 0.97 : 1.0)
                    .shadow(
                        color: Color.black.opacity(isTapped ? 0.2 : 0.1),
                        radius: isTapped ? 20 : 12,
                        y: isTapped ? 16 : 6
                    )
                    .animation(.spring(response: 0.35, dampingFraction: 0.6), value: isTapped)
                    .onTapGesture {
                        isTapped = true
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                            isTapped = false
                        }
                    }
                    // Entrance animation
                    .offset(y: appeared ? 0 : 30)
                    .opacity(appeared ? 1 : 0)

                // Share button
                Button {
                    shareReceipt()
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "square.and.arrow.up")
                            .font(.system(size: 13, weight: .semibold))
                        Text(TL.s("stats.shareReceipt"))
                            .font(.system(size: 14, weight: .bold))
                    }
                    .foregroundColor(theme.accent)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 13)
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .stroke(theme.accent.opacity(0.3), lineWidth: 0.5)
                    )
                }
                .padding(.horizontal, 24)
                .opacity(appeared ? 1 : 0)

                // ── Token Balance ──
                coinBalanceView
                    .padding(.horizontal, 24)
                    .padding(.top, 8)

                // ── Theme Wallet ──
                walletHeader
                    .padding(.horizontal, 24)
                    .padding(.top, 16)

                // Shop button — above cards
                Button { showAllThemes = true } label: {
                    HStack(spacing: 8) {
                        ZStack {
                            Circle()
                                .fill(theme.accent)
                                .frame(width: 28, height: 28)
                            Image(systemName: "plus")
                                .font(.system(size: 13, weight: .bold))
                                .foregroundColor(.white)
                        }
                        VStack(alignment: .leading, spacing: 1) {
                            Text(TL.s("wallet.themeShop"))
                                .font(.system(size: 13, weight: .bold))
                                .foregroundColor(theme.t1)
                            Text(TL.s("wallet.unlockHint"))
                                .font(.system(size: 9, weight: .medium))
                                .foregroundColor(theme.t3.opacity(0.5))
                        }
                        Spacer()
                        Text("₮100")
                            .font(.system(size: 12, weight: .black, design: .rounded))
                            .foregroundColor(Color(hex: 0xf7931a))
                    }
                    .padding(14)
                    .glassCard(cornerRadius: 14)
                }
                .padding(.horizontal, 24)

                walletCardStack
                    .padding(.horizontal, 24)

                Spacer(minLength: 40)
            }
        }
        .background(Color.clear)
        .onAppear {
            loadStats()
            withAnimation(.easeOut(duration: 0.6).delay(0.1)) {
                appeared = true
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.willEnterForegroundNotification)) { _ in
            loadStats()
        }
        .sheet(isPresented: $showShareSheet) {
            if let image = renderReceiptImage() {
                ShareSheetView(image: image)
            }
        }
        .fullScreenCover(isPresented: $showAllThemes) {
            allThemesSheet
        }
        .fullScreenCover(item: $selectedCard) { name in
            cardDetailView(for: name)
        }
        .alert("Unlock Theme", isPresented: $showUnlockConfirm) {
            Button("Unlock (₮100)") { unlockTheme() }
            Button("Cancel", role: .cancel) {}
        } message: {
            if let target = unlockTarget {
                Text("Spend 100 tokens to unlock \(target.rawValue.capitalized)?")
            }
        }
    }

    // MARK: - Coin Balance

    private var coinBalanceView: some View {
        HStack(spacing: 10) {
            // Bitcoin-style token icon
            ZStack {
                Circle()
                    .fill(LinearGradient(colors: [Color(hex: 0xf7931a), Color(hex: 0xe8850a)], startPoint: .topLeading, endPoint: .bottomTrailing))
                    .frame(width: 36, height: 36)
                    .shadow(color: Color(hex: 0xf7931a).opacity(0.5), radius: 8)
                Text("₮")
                    .font(.system(size: 18, weight: .black, design: .rounded))
                    .foregroundColor(.white)
            }

            VStack(alignment: .leading, spacing: 1) {
                Text("\(availableTokens)")
                    .font(.system(size: 18, weight: .black, design: .rounded))
                    .foregroundColor(theme.t1)
                + Text(" tokens")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(theme.t3.opacity(0.7))

                Text(TL.s("wallet.unlockThemes"))
                    .font(.system(size: 9, weight: .medium))
                    .foregroundColor(theme.t3.opacity(0.5))
            }

            Spacer()

            // Total saved
            VStack(alignment: .trailing, spacing: 1) {
                Text("\(totalTokensSaved)")
                    .font(.system(size: 13, weight: .bold, design: .monospaced))
                    .foregroundColor(theme.accent)
                Text("total saved")
                    .font(.system(size: 9, weight: .medium))
                    .foregroundColor(theme.t3.opacity(0.5))
            }
        }
        .padding(14)
        .glassCard(cornerRadius: 14)
    }

    // MARK: - Wallet Header

    private var walletHeader: some View {
        HStack {
            Text(TL.s("wallet.myThemes"))
                .font(.system(size: 16, weight: .black))
                .foregroundColor(theme.t1)

            Text("\(unlockedThemes.count)/\(TerseThemeName.allCases.count)")
                .font(.system(size: 11, weight: .bold, design: .monospaced))
                .foregroundColor(theme.t3.opacity(0.5))

            Spacer()

            // + button at top right of card section
            Button { showAllThemes = true } label: {
                Image(systemName: "plus.circle.fill")
                    .font(.system(size: 24))
                    .foregroundColor(theme.accent)
            }
        }
    }

    // MARK: - Wallet Card Stack (Apple Wallet style)

    private var walletCardStack: some View {
        let owned = TerseThemeName.allCases.filter { unlockedThemes.contains($0.rawValue) }
        return ZStack(alignment: .bottom) {
            ForEach(Array(owned.enumerated()), id: \.element) { index, name in
                let t = TerseTheme.theme(for: name)
                let offset = CGFloat(owned.count - 1 - index) * 28

                themeCard(name: name, theme: t, isActive: settings.theme == name)
                    .offset(y: -offset)
                    .zIndex(Double(index))
                    .onTapGesture {
                        selectedCard = name
                    }
            }
        }
        .frame(height: CGFloat(owned.count) * 28 + 80)
    }

    private func themeCard(name: TerseThemeName, theme t: TerseTheme, isActive: Bool) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text(name.rawValue.uppercased())
                    .font(.system(size: 14, weight: .black, design: .rounded))
                    .tracking(1)

                Text(t.isGradient ? "GRADIENT" : "SOLID")
                    .font(.system(size: 8, weight: .bold))
                    .tracking(0.5)
                    .opacity(0.4)
            }

            Spacer()

            if isActive {
                Text("ACTIVE")
                    .font(.system(size: 9, weight: .black))
                    .tracking(0.5)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Color.white.opacity(0.25))
                    .clipShape(Capsule())
            }
        }
        .foregroundColor(t.t1)
        .padding(.horizontal, 20)
        .padding(.vertical, 16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(height: 80)
        .background(
            ZStack {
                if let grad = t.bgGradient {
                    LinearGradient(colors: grad, startPoint: .topLeading, endPoint: .bottomTrailing)
                } else {
                    t.bg
                }
                // Subtle shine overlay
                LinearGradient(colors: [Color.white.opacity(0.15), Color.clear], startPoint: .topLeading, endPoint: .center)
            }
        )
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .shadow(color: Color.black.opacity(0.12), radius: 6, y: 3)
    }

    // MARK: - Card Detail View

    @State private var showingKeyboardPreview = false

    private func cardDetailView(for name: TerseThemeName) -> some View {
        let t = TerseTheme.theme(for: name)
        let isActive = settings.theme == name

        return VStack(spacing: 0) {
            // Close bar
            HStack {
                Spacer()
                Button { selectedCard = nil } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 24))
                        .foregroundColor(.white.opacity(0.6))
                }
            }
            .padding(20)

            Spacer()

            // Flippable card — tap to toggle between card face & keyboard preview
            VStack(spacing: 20) {
                ZStack {
                    if !showingKeyboardPreview {
                        // Card face
                        ZStack {
                            RoundedRectangle(cornerRadius: 20, style: .continuous)
                                .fill(
                                    t.bgGradient != nil
                                        ? AnyShapeStyle(LinearGradient(colors: t.bgGradient!, startPoint: .topLeading, endPoint: .bottomTrailing))
                                        : AnyShapeStyle(t.bg)
                                )
                                .frame(height: 220)
                                .overlay(
                                    LinearGradient(colors: [Color.white.opacity(0.3), Color.clear, Color.white.opacity(0.1)],
                                                   startPoint: .topLeading, endPoint: .bottomTrailing)
                                        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                                )
                                .overlay(
                                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                                        .stroke(Color.white.opacity(0.3), lineWidth: 1)
                                )
                                .shadow(color: t.bg.opacity(0.4), radius: 20, y: 10)

                            VStack(alignment: .leading, spacing: 8) {
                                HStack {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(name.rawValue.uppercased())
                                            .font(.system(size: 22, weight: .black, design: .rounded))
                                            .tracking(2)
                                        Text(t.isGradient ? "GRADIENT KEYBOARD" : "SOLID KEYBOARD")
                                            .font(.system(size: 10, weight: .bold))
                                            .tracking(1).opacity(0.5)
                                    }
                                    Spacer()
                                    Text("₮").font(.system(size: 28, weight: .black, design: .rounded)).opacity(0.2)
                                }
                                Spacer()
                                HStack {
                                    Text("TAP TO PREVIEW KEYBOARD")
                                        .font(.system(size: 9, weight: .bold, design: .monospaced))
                                        .tracking(1).opacity(0.4)
                                    Spacer()
                                    if isActive {
                                        HStack(spacing: 4) {
                                            Circle().fill(Color.white).frame(width: 6, height: 6)
                                            Text("ACTIVE").font(.system(size: 9, weight: .black))
                                        }.opacity(0.6)
                                    }
                                }
                            }
                            .foregroundColor(t.t1)
                            .padding(24)
                        }
                        .transition(.opacity.combined(with: .scale(scale: 0.95)))
                    } else {
                        // Keyboard preview
                        VStack(spacing: 6) {
                            Text("KEYBOARD PREVIEW")
                                .font(.system(size: 8, weight: .bold, design: .monospaced))
                                .tracking(1)
                                .foregroundColor(.white.opacity(0.4))

                            miniKeyboardPreview(for: name)
                                .frame(height: 190)

                            Text("TAP TO GO BACK")
                                .font(.system(size: 8, weight: .bold, design: .monospaced))
                                .tracking(1)
                                .foregroundColor(.white.opacity(0.3))
                        }
                        .transition(.opacity.combined(with: .scale(scale: 0.95)))
                    }
                }
                .frame(height: 230)
                .onTapGesture {
                    withAnimation(.spring(response: 0.4, dampingFraction: 0.75)) {
                        showingKeyboardPreview.toggle()
                    }
                }
                .padding(.horizontal, 30)

                // Action button
                Button {
                    withAnimation(.spring(response: 0.3)) {
                        settings.theme = name
                    }
                } label: {
                    Text(isActive ? "Currently In Use" : "Use This Keyboard")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundColor(isActive ? .white.opacity(0.5) : .white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 15)
                        .background(isActive ? Color.white.opacity(0.15) : t.accent)
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
                .disabled(isActive)
                .padding(.horizontal, 30)

                // Color swatches
                HStack(spacing: 12) {
                    colorSwatch("BG", color: t.bg)
                    colorSwatch("Accent", color: t.accent)
                    colorSwatch("Text", color: t.t1)
                    colorSwatch("Surface", color: t.surface)
                }
                .padding(.horizontal, 30)
            }

            Spacer()
        }
        .background(
            ZStack {
                Color.black
                if let grad = t.bgGradient {
                    LinearGradient(colors: grad, startPoint: .topLeading, endPoint: .bottomTrailing)
                        .opacity(0.3)
                } else {
                    t.bg.opacity(0.3)
                }
            }
            .ignoresSafeArea()
        )
    }

    // MARK: - Mini Keyboard Preview

    private func miniKeyboardPreview(for name: TerseThemeName) -> some View {
        let t = TerseTheme.theme(for: name)
        let isDark = ["midnight", "indigo", "charcoal", "ocean", "aurora", "neon", "ember", "frost", "velvet", "cosmic"].contains(name.rawValue)
        let keyColor = isDark ? Color.white.opacity(0.13) : Color.white.opacity(0.5)
        let keyText = isDark ? Color.white.opacity(0.8) : Color.black.opacity(0.7)
        let modColor = isDark ? Color.white.opacity(0.07) : Color.white.opacity(0.28)

        let rows = [
            ["Q","W","E","R","T","Y","U","I","O","P"],
            ["A","S","D","F","G","H","J","K","L"],
            ["Z","X","C","V","B","N","M"]
        ]

        return VStack(spacing: 0) {
            // Toolbar
            HStack {
                Circle().fill(t.accent).frame(width: 5, height: 5)
                Text("Terse").font(.system(size: 8, weight: .bold)).foregroundColor(keyText)
                Spacer()
                HStack(spacing: 1) {
                    ForEach(["S","N","A"], id: \.self) { m in
                        Text(m).font(.system(size: 6, weight: .bold))
                            .foregroundColor(m == "N" ? .white : keyText.opacity(0.5))
                            .frame(width: 14, height: 12)
                            .background(m == "N" ? t.accent : Color.clear)
                            .cornerRadius(5)
                    }
                }
                .background(Color.black.opacity(0.1))
                .cornerRadius(6)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)

            // Key rows
            ForEach(rows, id: \.self) { row in
                HStack(spacing: 3) {
                    if row.count == 7 {
                        // Shift key
                        RoundedRectangle(cornerRadius: 3)
                            .fill(modColor)
                            .frame(width: 22, height: 22)
                            .overlay(Image(systemName: "shift").font(.system(size: 7)).foregroundColor(keyText))
                    }
                    ForEach(row, id: \.self) { key in
                        Text(key)
                            .font(.system(size: 9, weight: .medium))
                            .foregroundColor(keyText)
                            .frame(maxWidth: .infinity, minHeight: 22)
                            .background(keyColor)
                            .cornerRadius(3)
                            .overlay(
                                RoundedRectangle(cornerRadius: 3)
                                    .stroke(Color.white.opacity(isDark ? 0.08 : 0.35), lineWidth: 0.3)
                            )
                    }
                    if row.count == 7 {
                        // Backspace
                        RoundedRectangle(cornerRadius: 3)
                            .fill(modColor)
                            .frame(width: 22, height: 22)
                            .overlay(Image(systemName: "delete.left").font(.system(size: 7)).foregroundColor(keyText))
                    }
                }
                .padding(.horizontal, 4)
            }

            // Bottom row
            HStack(spacing: 3) {
                Text("123").font(.system(size: 7, weight: .bold)).foregroundColor(keyText)
                    .frame(width: 28, height: 22).background(modColor).cornerRadius(3)
                RoundedRectangle(cornerRadius: 3)
                    .fill(keyColor)
                    .frame(height: 22)
                    .overlay(Text("space").font(.system(size: 8)).foregroundColor(keyText))
                Text("send").font(.system(size: 7, weight: .bold)).foregroundColor(.white)
                    .frame(width: 38, height: 22).background(t.accent).cornerRadius(3)
            }
            .padding(.horizontal, 4)
            .padding(.bottom, 4)
        }
        .padding(.vertical, 4)
        .background(
            ZStack {
                if let grad = t.bgGradient {
                    LinearGradient(colors: grad, startPoint: .topLeading, endPoint: .bottomTrailing)
                } else {
                    t.bg
                }
            }
        )
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color.white.opacity(0.2), lineWidth: 0.5)
        )
    }

    private func colorSwatch(_ label: String, color: Color) -> some View {
        VStack(spacing: 4) {
            RoundedRectangle(cornerRadius: 6)
                .fill(color)
                .frame(width: 40, height: 40)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.white.opacity(0.2), lineWidth: 0.5))
            Text(label)
                .font(.system(size: 8, weight: .medium))
                .foregroundColor(.white.opacity(0.4))
        }
    }

    // MARK: - All Themes Sheet

    private var allThemesSheet: some View {
        let locked = TerseThemeName.allCases.filter { !unlockedThemes.contains($0.rawValue) }

        return ZStack {
            Color.black.ignoresSafeArea()

            VStack(spacing: 16) {
                // Header
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(TL.s("wallet.themeShop"))
                            .font(.system(size: 20, weight: .black))
                            .foregroundColor(.white)
                        HStack(spacing: 6) {
                            Text("₮")
                                .font(.system(size: 12, weight: .black, design: .rounded))
                                .foregroundColor(Color(hex: 0xf7931a))
                            Text("\(availableTokens) tokens")
                                .font(.system(size: 13, weight: .bold))
                                .foregroundColor(.white.opacity(0.7))
                            Text("·")
                                .foregroundColor(.white.opacity(0.3))
                            Text("\(locked.count) locked")
                                .font(.system(size: 13, weight: .medium))
                                .foregroundColor(.white.opacity(0.5))
                        }
                    }

                    Spacer()

                    Button { showAllThemes = false } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 24))
                            .foregroundColor(.white.opacity(0.5))
                    }
                }
                .padding(.horizontal, 24)
                .padding(.top, 16)

                // Subtitle + swipe hint
                Text(TL.s("wallet.shopSubtitle"))
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(.white.opacity(0.5))
                    .padding(.horizontal, 24)

                Text("← swipe →")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(.white.opacity(0.2))

                // Swipeable card carousel
                if locked.isEmpty {
                    VStack(spacing: 12) {
                        Image(systemName: "checkmark.seal.fill")
                            .font(.system(size: 40))
                            .foregroundColor(Color(hex: 0xf7931a))
                        Text("All keyboards unlocked!")
                            .font(.system(size: 16, weight: .bold))
                            .foregroundColor(.white)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    // Card carousel (swipe area)
                    TabView(selection: $shopIndex) {
                        ForEach(Array(locked.enumerated()), id: \.element) { idx, name in
                            shopCardPreview(for: name)
                                .tag(idx)
                                .padding(.horizontal, 16)
                        }
                    }
                    .tabViewStyle(.page(indexDisplayMode: .automatic))
                    .frame(height: 380)

                    // Unlock button BELOW the swipe area — always tappable
                    let currentName = locked.indices.contains(shopIndex) ? locked[shopIndex] : locked[0]
                    Button {
                        unlockTarget = currentName
                        showUnlockConfirm = true
                    } label: {
                        HStack(spacing: 8) {
                            Text("₮")
                                .font(.system(size: 14, weight: .black, design: .rounded))
                                .foregroundColor(Color(hex: 0xf7931a))
                            Text("Unlock \(currentName.rawValue.capitalized) · ₮100")
                                .font(.system(size: 15, weight: .bold))
                        }
                        .foregroundColor(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 16)
                        .background(
                            availableTokens >= 100
                                ? LinearGradient(colors: [Color(hex: 0xf7931a), Color(hex: 0xe8850a)], startPoint: .leading, endPoint: .trailing)
                                : LinearGradient(colors: [Color.gray, Color.gray], startPoint: .leading, endPoint: .trailing)
                        )
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .shadow(color: availableTokens >= 100 ? Color(hex: 0xf7931a).opacity(0.4) : .clear, radius: 10, y: 4)
                    }
                    .disabled(availableTokens < 100)
                    .padding(.horizontal, 24)

                    if availableTokens < 100 {
                        Text("Need \(100 - availableTokens) more tokens — keep saving!")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundColor(.white.opacity(0.4))
                    }
                }

                Spacer(minLength: 20)
            }
        }
    }

    @State private var shopPreviewIndex: TerseThemeName? = nil

    private func shopCardPreview(for name: TerseThemeName) -> some View {
        let t = TerseTheme.theme(for: name)
        let showKB = shopPreviewIndex == name

        return VStack(spacing: 16) {
            ZStack {
                if !showKB {
                    // Card face
                    ZStack {
                        RoundedRectangle(cornerRadius: 24, style: .continuous)
                            .fill(
                                t.bgGradient != nil
                                    ? AnyShapeStyle(LinearGradient(colors: t.bgGradient!, startPoint: .topLeading, endPoint: .bottomTrailing))
                                    : AnyShapeStyle(t.bg)
                            )
                            .overlay(
                                LinearGradient(colors: [Color.white.opacity(0.3), Color.clear, Color.white.opacity(0.08)],
                                               startPoint: .topLeading, endPoint: .bottomTrailing)
                                    .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
                            )
                            .overlay(
                                RoundedRectangle(cornerRadius: 24, style: .continuous)
                                    .stroke(Color.white.opacity(0.3), lineWidth: 1)
                            )
                            .shadow(color: t.bg.opacity(0.5), radius: 24, y: 12)

                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(name.rawValue.uppercased())
                                        .font(.system(size: 24, weight: .black, design: .rounded))
                                        .tracking(2)
                                    Text(t.isGradient ? "GRADIENT KEYBOARD" : "SOLID KEYBOARD")
                                        .font(.system(size: 10, weight: .bold)).tracking(1).opacity(0.5)
                                }
                                Spacer()
                                Image(systemName: "lock.fill").font(.system(size: 18)).opacity(0.3)
                            }
                            Spacer()
                            HStack {
                                Text("TAP TO PREVIEW")
                                    .font(.system(size: 9, weight: .bold, design: .monospaced))
                                    .tracking(1).opacity(0.4)
                                Spacer()
                                Text("₮").font(.system(size: 24, weight: .black, design: .rounded)).opacity(0.15)
                            }
                        }
                        .foregroundColor(t.t1)
                        .padding(24)
                    }
                    .transition(.opacity)
                } else {
                    // Keyboard preview
                    VStack(spacing: 6) {
                        Text("KEYBOARD PREVIEW").font(.system(size: 8, weight: .bold, design: .monospaced))
                            .tracking(1).foregroundColor(.white.opacity(0.4))
                        miniKeyboardPreview(for: name)
                        Text("TAP TO GO BACK").font(.system(size: 8, weight: .bold, design: .monospaced))
                            .tracking(1).foregroundColor(.white.opacity(0.3))
                    }
                    .transition(.opacity)
                }
            }
            .frame(height: 240)
            .onTapGesture {
                withAnimation(.spring(response: 0.4, dampingFraction: 0.75)) {
                    shopPreviewIndex = showKB ? nil : name
                }
            }

            // Swatches
            HStack(spacing: 12) {
                colorSwatch("BG", color: t.bg)
                colorSwatch("Accent", color: t.accent)
                colorSwatch("Text", color: t.t1)
                colorSwatch("Surface", color: t.surface)
            }
        }
    }

    // MARK: - Unlock Logic

    private func unlockTheme() {
        guard let target = unlockTarget, availableTokens >= 100 else { return }
        let d = UserDefaults(suiteName: "group.com.terseai.shared")

        // Spend tokens
        d?.set(spentTokens + 100, forKey: "spentTokens")

        // Add to unlocked
        var unlocked = d?.stringArray(forKey: "unlockedThemes") ?? []
        unlocked.append(target.rawValue)
        d?.set(unlocked, forKey: "unlockedThemes")

        unlockTarget = nil
    }

    // MARK: - Receipt Card

    private var receiptCard: some View {
        VStack(spacing: 0) {
            // Perforated top
            ZigzagEdge().fill(paperColor).frame(height: 10).scaleEffect(x: 1, y: -1)

            // Body
            VStack(spacing: 0) {
                VStack(spacing: 14) {
                    // Header
                    VStack(spacing: 5) {
                        Text("T E R S E")
                            .font(.system(size: 14, weight: .black, design: .monospaced))
                            .tracking(2)
                            .foregroundColor(Color.black.opacity(0.7))

                        Text("TOKEN SAVINGS RECEIPT")
                            .font(.system(size: 9, weight: .medium, design: .monospaced))
                            .foregroundColor(Color.black.opacity(0.35))

                        Text("#\(String(format: "%06d", statsData.messagesTotal))")
                            .font(.system(size: 8, weight: .regular, design: .monospaced))
                            .foregroundColor(Color.black.opacity(0.25))

                        Text(formattedDate())
                            .font(.system(size: 9, weight: .regular, design: .monospaced))
                            .foregroundColor(Color.black.opacity(0.3))
                    }
                    .padding(.top, 22)

                    thermalDash

                    // ── REDUCTION ──
                    VStack(spacing: 4) {
                        Text("\(statsData.percentSaved)%")
                            .font(.system(size: 56, weight: .black, design: .rounded))
                            .foregroundColor(Color.black.opacity(0.82))

                        Text("TOKENS REDUCED")
                            .font(.system(size: 8, weight: .bold, design: .monospaced))
                            .tracking(2)
                            .foregroundColor(Color.black.opacity(0.3))

                        // Efficiency badge
                        Text(efficiency)
                            .font(.system(size: 10, weight: .black, design: .monospaced))
                            .foregroundColor(Color.black.opacity(0.5))
                            .padding(.horizontal, 12)
                            .padding(.vertical, 3)
                            .overlay(
                                RoundedRectangle(cornerRadius: 4)
                                    .stroke(Color.black.opacity(0.2), lineWidth: 1)
                            )
                    }

                    thermalDash

                    // ── TOKEN DETAILS ──
                    sectionHeader("TOKEN DETAILS")

                    VStack(spacing: 5) {
                        thermalRow("Tokens Input", "\(statsData.tokensIn)")
                        thermalRow("Tokens Output", "\(statsData.tokensIn - statsData.tokensSaved)")
                        thermalRow("Tokens Saved", "\(statsData.tokensSaved)")
                        thermalRow("Avg Saved/Msg", "\(avgTokensPerMsg)")
                    }

                    thermalDash

                    // ── COST SAVINGS ──
                    sectionHeader("COST SAVINGS (EST.)")

                    VStack(spacing: 4) {
                        Text(formatMoney(moneySaved))
                            .font(.system(size: 34, weight: .black, design: .rounded))
                            .foregroundColor(Color.black.opacity(0.8))

                        VStack(spacing: 2) {
                            costRow("GPT-4o", msgCost: 0.08)
                            costRow("GPT-4 / Opus", msgCost: 0.25)
                            costRow("Claude Sonnet", msgCost: 0.15)
                        }
                        .padding(.top, 4)

                        Text("* avg conversation cost × messages × reduction%")
                            .font(.system(size: 7, weight: .regular, design: .monospaced))
                            .foregroundColor(Color.black.opacity(0.2))
                            .padding(.top, 2)
                    }

                    thermalDash

                    // ── ACTIVITY ──
                    sectionHeader("ACTIVITY")

                    VStack(spacing: 5) {
                        thermalRow("Total Messages", "\(statsData.messagesTotal)")
                        thermalRow("Period", selectedPeriod.rawValue)
                        if let best = bestDay, best.tokensSaved > 0 {
                            thermalRow("Best Day", "\(best.dateLabel) (\(best.tokensSaved) tok)")
                        }
                    }

                    // Mini chart
                    if !statsData.byDay.isEmpty {
                        miniChart
                    }

                    // ── SOURCES ──
                    if !statsData.bySource.isEmpty {
                        thermalDash
                        sectionHeader("BY SOURCE")

                        VStack(spacing: 5) {
                            ForEach(statsData.bySource, id: \.name) { src in
                                thermalRow(src.name, "\(src.tokensSaved) tok · \(src.messages) msg · \(src.percent)%")
                            }
                        }
                    }

                    thermalDash

                    // ── FOOTER ──
                    VStack(spacing: 6) {
                        Text("================================")
                            .font(.system(size: 8, design: .monospaced))
                            .foregroundColor(Color.black.opacity(0.15))

                        Text("*** THANK YOU FOR SAVING ***")
                            .font(.system(size: 9, weight: .bold, design: .monospaced))
                            .foregroundColor(Color.black.opacity(0.4))

                        Text("Every token saved is money saved.")
                            .font(.system(size: 8, weight: .medium, design: .monospaced))
                            .foregroundColor(Color.black.opacity(0.25))

                        Text("terseai.org")
                            .font(.system(size: 9, weight: .semibold, design: .monospaced))
                            .foregroundColor(Color.black.opacity(0.3))

                        Text("================================")
                            .font(.system(size: 8, design: .monospaced))
                            .foregroundColor(Color.black.opacity(0.15))
                    }
                    .padding(.bottom, 24)
                }
                .padding(.horizontal, 18)
            }
            .background(
                ZStack {
                    paperColor

                    // Paper grain
                    Canvas { context, size in
                        for _ in 0..<300 {
                            let x = CGFloat.random(in: 0...size.width)
                            let y = CGFloat.random(in: 0...size.height)
                            let r = CGFloat.random(in: 0.3...1.0)
                            context.fill(
                                Path(ellipseIn: CGRect(x: x, y: y, width: r, height: r)),
                                with: .color(Color.black.opacity(Double.random(in: 0.015...0.045)))
                            )
                        }
                    }

                    // Fold line
                    Rectangle()
                        .fill(
                            LinearGradient(
                                colors: [.clear, Color.black.opacity(0.02), .clear],
                                startPoint: .leading, endPoint: .trailing
                            )
                        )
                        .frame(width: 30)

                    // Top edge light reflection
                    VStack {
                        LinearGradient(
                            colors: [Color.white.opacity(0.15), Color.clear],
                            startPoint: .top, endPoint: .bottom
                        )
                        .frame(height: 30)
                        Spacer()
                    }
                }
            )

            // Torn bottom
            ZigzagEdge().fill(paperColor).frame(height: 12)
        }
        .rotationEffect(.degrees(-0.5))
    }

    private var paperColor: Color {
        Color(red: 0.98, green: 0.96, blue: 0.92)
    }

    // MARK: - Helpers

    private func sectionHeader(_ text: String) -> some View {
        HStack {
            Text(text)
                .font(.system(size: 8, weight: .bold, design: .monospaced))
                .tracking(1)
                .foregroundColor(Color.black.opacity(0.3))
            Spacer()
        }
    }

    private var thermalDash: some View {
        HStack(spacing: 3) {
            ForEach(0..<40, id: \.self) { _ in
                Rectangle().fill(Color.black.opacity(0.15)).frame(width: 4, height: 1)
            }
        }
        .frame(maxWidth: .infinity)
    }

    private func thermalRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label)
                .font(.system(size: 11, weight: .regular, design: .monospaced))
                .foregroundColor(Color.black.opacity(0.45))
            Spacer()
            Text(value)
                .font(.system(size: 11, weight: .bold, design: .monospaced))
                .foregroundColor(Color.black.opacity(0.7))
        }
    }

    private func formatMoney(_ amount: Double) -> String {
        if amount >= 0.01 { return String(format: "$%.2f", amount) }
        if amount > 0 { return String(format: "$%.4f", amount) }
        return "$0.00"
    }

    private func costRow(_ model: String, msgCost: Double) -> some View {
        let pct = Double(statsData.percentSaved) / 100.0
        let saved = Double(statsData.messagesTotal) * msgCost * pct
        return HStack {
            Text(model)
                .font(.system(size: 9, weight: .regular, design: .monospaced))
                .foregroundColor(Color.black.opacity(0.35))
            Spacer()
            Text("~$\(String(format: "%.2f", msgCost))/msg")
                .font(.system(size: 8, weight: .regular, design: .monospaced))
                .foregroundColor(Color.black.opacity(0.25))
            Text(formatMoney(saved))
                .font(.system(size: 10, weight: .bold, design: .monospaced))
                .foregroundColor(Color.black.opacity(0.6))
                .frame(width: 70, alignment: .trailing)
        }
    }

    private var miniChart: some View {
        HStack(alignment: .bottom, spacing: 2) {
            let maxVal = max(statsData.byDay.map { $0.tokensSaved }.max() ?? 1, 1)
            let days = Array(statsData.byDay.suffix(14))
            ForEach(Array(days.enumerated()), id: \.offset) { _, day in
                RoundedRectangle(cornerRadius: 1)
                    .fill(Color.black.opacity(0.25))
                    .frame(maxWidth: .infinity, minHeight: 1,
                           maxHeight: max(1, CGFloat(day.tokensSaved) / CGFloat(maxVal) * 30))
            }
        }
        .frame(height: 34)
    }

    // MARK: - Share

    private func shareReceipt() { showShareSheet = true }

    @MainActor
    private func renderReceiptImage() -> UIImage? {
        let view = ReceiptRenderView(
            statsData: statsData, period: selectedPeriod.rawValue,
            moneySaved: moneySaved, avgPerMsg: avgTokensPerMsg,
            efficiency: efficiency, bestDay: bestDay, theme: theme
        )
        let renderer = ImageRenderer(content: view)
        renderer.scale = displayScale
        return renderer.uiImage
    }

    private func loadStats() {
        statsData = TerseStats.shared.getData(for: selectedPeriod)
    }

    private func formattedDate() -> String {
        let fmt = DateFormatter(); fmt.dateFormat = "yyyy/MM/dd  HH:mm"
        return fmt.string(from: Date())
    }
}

// MARK: - Zigzag Edge

struct ZigzagEdge: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let w: CGFloat = 8
        let count = Int(rect.width / w) + 1
        path.move(to: .zero)
        for i in 0..<count {
            let x = CGFloat(i) * w
            path.addLine(to: CGPoint(x: x + w / 2, y: rect.height))
            path.addLine(to: CGPoint(x: x + w, y: 0))
        }
        path.addLine(to: CGPoint(x: rect.width, y: 0))
        path.closeSubpath()
        return path
    }
}

// MARK: - Render View (share image)

struct ReceiptRenderView: View {
    let statsData: StatsData
    let period: String
    let moneySaved: Double
    let avgPerMsg: Int
    let efficiency: String
    let bestDay: DayStats?
    let theme: TerseTheme

    private var paper: Color { Color(red: 0.98, green: 0.96, blue: 0.92) }

    var body: some View {
        VStack(spacing: 0) {
            ZigzagEdge().fill(paper).frame(height: 8).scaleEffect(x: 1, y: -1)

            VStack(spacing: 12) {
                Text("T E R S E").font(.system(size: 13, weight: .black, design: .monospaced))
                    .foregroundColor(.black.opacity(0.7)).padding(.top, 16)
                Text("TOKEN SAVINGS RECEIPT").font(.system(size: 8, weight: .medium, design: .monospaced))
                    .foregroundColor(.black.opacity(0.35))
                Text(DateFormatter.localizedString(from: Date(), dateStyle: .medium, timeStyle: .short))
                    .font(.system(size: 8, design: .monospaced)).foregroundColor(.black.opacity(0.25))

                dash

                Text("\(statsData.percentSaved)%").font(.system(size: 48, weight: .black, design: .rounded))
                    .foregroundColor(.black.opacity(0.8))
                Text("TOKENS REDUCED · \(efficiency)").font(.system(size: 8, weight: .bold, design: .monospaced))
                    .foregroundColor(.black.opacity(0.3))

                dash

                VStack(spacing: 4) {
                    row("Tokens In", "\(statsData.tokensIn)")
                    row("Tokens Saved", "\(statsData.tokensSaved)")
                    row("Avg Saved/Msg", "\(avgPerMsg)")
                    row("Messages", "\(statsData.messagesTotal)")
                    row("Period", period)
                    if let best = bestDay, best.tokensSaved > 0 {
                        row("Best Day", "\(best.dateLabel)")
                    }
                }

                dash

                Text("EST. COST SAVINGS").font(.system(size: 8, weight: .bold, design: .monospaced))
                    .foregroundColor(.black.opacity(0.3))
                Text(String(format: "$%.2f", moneySaved))
                    .font(.system(size: 28, weight: .black, design: .rounded)).foregroundColor(.black.opacity(0.8))

                VStack(spacing: 2) {
                    costRow("GPT-4o", msgCost: 0.08)
                    costRow("GPT-4/Opus", msgCost: 0.25)
                    costRow("Claude", msgCost: 0.15)
                }

                if !statsData.bySource.isEmpty {
                    dash
                    ForEach(statsData.bySource, id: \.name) { src in
                        row(src.name, "\(src.tokensSaved) tok · \(src.percent)%")
                    }
                }

                dash

                Text("*** THANK YOU FOR SAVING ***").font(.system(size: 9, weight: .bold, design: .monospaced))
                    .foregroundColor(.black.opacity(0.4))
                Text("terseai.org").font(.system(size: 8, design: .monospaced)).foregroundColor(.black.opacity(0.2))
                    .padding(.bottom, 16)
            }
            .padding(.horizontal, 20)
            .background(paper)

            ZigzagEdge().fill(paper).frame(height: 10)
        }
        .frame(width: 280).background(Color.white)
    }

    private var dash: some View {
        HStack(spacing: 3) { ForEach(0..<35, id: \.self) { _ in
            Rectangle().fill(Color.black.opacity(0.15)).frame(width: 4, height: 1)
        }}.frame(maxWidth: .infinity)
    }

    private func row(_ l: String, _ v: String) -> some View {
        HStack {
            Text(l).font(.system(size: 10, design: .monospaced)).foregroundColor(.black.opacity(0.4))
            Spacer()
            Text(v).font(.system(size: 10, weight: .bold, design: .monospaced)).foregroundColor(.black.opacity(0.7))
        }
    }

    private func costRow(_ model: String, msgCost: Double) -> some View {
        let pct = Double(statsData.percentSaved) / 100.0
        let saved = Double(statsData.messagesTotal) * msgCost * pct
        return HStack {
            Text(model).font(.system(size: 8, design: .monospaced)).foregroundColor(.black.opacity(0.3))
            Spacer()
            Text(saved >= 0.01 ? String(format: "$%.2f", saved) : String(format: "$%.4f", saved))
                .font(.system(size: 9, weight: .bold, design: .monospaced))
                .foregroundColor(.black.opacity(0.6))
        }
    }
}

// MARK: - Share Sheet

struct ShareSheetView: UIViewControllerRepresentable {
    let image: UIImage
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [image], applicationActivities: nil)
    }
    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}

// MARK: - Data Models

struct StatsData {
    var tokensIn: Int; var tokensSaved: Int; var percentSaved: Int
    var messagesTotal: Int; var byDay: [DayStats]; var bySource: [SourceStats]
    static let empty = StatsData(tokensIn: 0, tokensSaved: 0, percentSaved: 0, messagesTotal: 0, byDay: [], bySource: [])
}
struct DayStats { var date: String; var dateLabel: String; var tokensIn: Int; var tokensSaved: Int }
struct SourceStats { var name: String; var color: Color; var tokensIn: Int; var tokensSaved: Int; var messages: Int; var percent: Int }

#Preview { StatsView().environmentObject(TerseSettings.shared) }
