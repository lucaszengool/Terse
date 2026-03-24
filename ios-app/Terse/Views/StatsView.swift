import SwiftUI

struct StatsView: View {
    @EnvironmentObject var settings: TerseSettings
    @State private var selectedPeriod: StatsPeriod = .month
    @State private var statsData: StatsData = .empty
    @State private var showShareSheet = false
    @State private var isTapped = false
    @State private var appeared = false
    @State private var showAllThemes = false
    @State private var unlockTarget: TerseThemeName? = nil
    @State private var showUnlockConfirm = false
    @Environment(\.displayScale) private var displayScale

    var theme: TerseTheme { settings.currentTheme }

    // Tokens as currency (bitcoin-style icon)
    private var totalTokensSaved: Int {
        settings.totalTokensSaved
    }
    private var spentTokens: Int {
        let d = UserDefaults(suiteName: "group.com.terse.shared")
        return d?.integer(forKey: "spentTokens") ?? 0
    }
    private var availableTokens: Int {
        max(0, totalTokensSaved - spentTokens)
    }

    private static let freeThemes: Set<String> = [
        "lime", "lavender", "coral", "teal", "midnight", "rose", "sage", "sand"
    ]

    private var unlockedThemes: Set<String> {
        let d = UserDefaults(suiteName: "group.com.terse.shared")
        let unlocked = d?.stringArray(forKey: "unlockedThemes") ?? []
        return Self.freeThemes.union(unlocked)
    }

    private var moneySaved: Double {
        Double(statsData.tokensSaved) * 0.003 / 1000.0
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

                // ── Coins Balance ──
                coinBalanceView
                    .padding(.horizontal, 24)
                    .padding(.top, 8)

                // ── Theme Wallet (Apple Wallet style) ──
                walletHeader
                    .padding(.horizontal, 24)
                    .padding(.top, 16)

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
        .sheet(isPresented: $showAllThemes) {
            allThemesSheet
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
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(TL.s("wallet.myThemes"))
                    .font(.system(size: 16, weight: .black))
                    .foregroundColor(theme.t1)

                Text("\(unlockedThemes.count)/\(TerseThemeName.allCases.count)")
                    .font(.system(size: 11, weight: .bold, design: .monospaced))
                    .foregroundColor(theme.t3.opacity(0.5))

                Spacer()

                Button { showAllThemes = true } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "plus")
                            .font(.system(size: 12, weight: .bold))
                        Text(TL.s("wallet.themeShop"))
                            .font(.system(size: 11, weight: .bold))
                    }
                    .foregroundColor(.white)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(theme.accent)
                    .clipShape(Capsule())
                }
            }

            // Hint text
            Text(TL.s("wallet.unlockHint"))
                .font(.system(size: 10, weight: .medium))
                .foregroundColor(theme.t3.opacity(0.5))
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
                        withAnimation(.spring(response: 0.3)) {
                            settings.theme = name
                        }
                    }
            }
        }
        .frame(height: CGFloat(min(owned.count, 8)) * 28 + 80)
    }

    private func themeCard(name: TerseThemeName, theme t: TerseTheme, isActive: Bool) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text(name.rawValue.uppercased())
                    .font(.system(size: 13, weight: .black, design: .rounded))
                    .tracking(1)

                if t.isGradient {
                    Text("GRADIENT")
                        .font(.system(size: 8, weight: .bold))
                        .tracking(0.5)
                        .opacity(0.5)
                }
            }

            Spacer()

            if isActive {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 16))
            }
        }
        .foregroundColor(t.t1)
        .padding(.horizontal, 20)
        .padding(.vertical, 16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(height: 80)
        .background(
            Group {
                if let grad = t.bgGradient {
                    LinearGradient(colors: grad, startPoint: .topLeading, endPoint: .bottomTrailing)
                } else {
                    t.bg
                }
            }
        )
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .shadow(color: Color.black.opacity(0.12), radius: 6, y: 3)
    }

    // MARK: - All Themes Sheet

    private var allThemesSheet: some View {
        NavigationView {
            ScrollView {
                VStack(spacing: 12) {
                    // Token balance at top
                    HStack(spacing: 8) {
                        ZStack {
                            Circle()
                                .fill(LinearGradient(colors: [Color(hex: 0xf7931a), Color(hex: 0xe8850a)], startPoint: .topLeading, endPoint: .bottomTrailing))
                                .frame(width: 24, height: 24)
                            Text("₮")
                                .font(.system(size: 12, weight: .black, design: .rounded))
                                .foregroundColor(.white)
                        }
                        Text("\(availableTokens) tokens available")
                            .font(.system(size: 15, weight: .bold))
                        Spacer()
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 8)

                    ForEach(TerseThemeName.allCases, id: \.self) { name in
                        let t = TerseTheme.theme(for: name)
                        let owned = unlockedThemes.contains(name.rawValue)

                        HStack(spacing: 14) {
                            // Color preview
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .fill(
                                    t.bgGradient != nil
                                        ? AnyShapeStyle(LinearGradient(colors: t.bgGradient!, startPoint: .topLeading, endPoint: .bottomTrailing))
                                        : AnyShapeStyle(t.bg)
                                )
                                .frame(width: 44, height: 44)
                                .overlay(
                                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                                        .stroke(Color.white.opacity(0.3), lineWidth: 0.5)
                                )

                            VStack(alignment: .leading, spacing: 2) {
                                Text(name.rawValue.capitalized)
                                    .font(.system(size: 14, weight: .bold))
                                Text(t.isGradient ? "Gradient" : "Solid")
                                    .font(.system(size: 11))
                                    .foregroundColor(.secondary)
                            }

                            Spacer()

                            if owned {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundColor(.green)
                            } else {
                                Button {
                                    unlockTarget = name
                                    showUnlockConfirm = true
                                } label: {
                                    HStack(spacing: 4) {
                                        Text("₮")
                                            .font(.system(size: 11, weight: .black))
                                        Text("100")
                                            .font(.system(size: 12, weight: .bold))
                                    }
                                    .foregroundColor(.white)
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 6)
                                    .background(availableTokens >= 100 ? Color(hex: 0xf7931a) : Color.gray)
                                    .clipShape(Capsule())
                                }
                                .disabled(availableTokens < 100)
                            }
                        }
                        .padding(.horizontal, 20)
                        .padding(.vertical, 8)
                    }
                }
            }
            .navigationTitle(TL.s("wallet.themeShop"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(TL.s("wallet.done")) { showAllThemes = false }
                }
            }
        }
    }

    // MARK: - Unlock Logic

    private func unlockTheme() {
        guard let target = unlockTarget, availableTokens >= 100 else { return }
        let d = UserDefaults(suiteName: "group.com.terse.shared")

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
                        Text(String(format: "$%.2f", moneySaved))
                            .font(.system(size: 34, weight: .black, design: .rounded))
                            .foregroundColor(Color.black.opacity(0.8))

                        VStack(spacing: 2) {
                            costRow("GPT-4o", rate: 0.0025)
                            costRow("GPT-4", rate: 0.03)
                            costRow("Claude Sonnet", rate: 0.003)
                        }
                        .padding(.top, 4)

                        Text("* based on input token pricing per 1K")
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

    private func costRow(_ model: String, rate: Double) -> some View {
        let saved = Double(statsData.tokensSaved) * rate / 1000.0
        return HStack {
            Text(model)
                .font(.system(size: 9, weight: .regular, design: .monospaced))
                .foregroundColor(Color.black.opacity(0.35))
            Spacer()
            Text("~$\(String(format: "%.2f", rate))/1K")
                .font(.system(size: 8, weight: .regular, design: .monospaced))
                .foregroundColor(Color.black.opacity(0.25))
            Text(String(format: "$%.2f", saved))
                .font(.system(size: 10, weight: .bold, design: .monospaced))
                .foregroundColor(Color.black.opacity(0.6))
                .frame(width: 60, alignment: .trailing)
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
                    costRow("GPT-4o", rate: 0.0025)
                    costRow("GPT-4", rate: 0.03)
                    costRow("Claude", rate: 0.003)
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

    private func costRow(_ model: String, rate: Double) -> some View {
        let saved = Double(statsData.tokensSaved) * rate / 1000.0
        return HStack {
            Text(model).font(.system(size: 8, design: .monospaced)).foregroundColor(.black.opacity(0.3))
            Spacer()
            Text(String(format: "$%.2f", saved)).font(.system(size: 9, weight: .bold, design: .monospaced))
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
