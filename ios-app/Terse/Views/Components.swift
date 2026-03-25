import SwiftUI

// MARK: - TerseButton

struct TerseButton: View {
    let title: String
    let icon: String?
    let theme: TerseTheme
    let action: () -> Void
    var isActive: Bool = true

    init(_ title: String, icon: String? = nil, theme: TerseTheme, isActive: Bool = true, action: @escaping () -> Void) {
        self.title = title
        self.icon = icon
        self.theme = theme
        self.isActive = isActive
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let icon {
                    Image(systemName: icon)
                        .font(.system(size: 12, weight: .semibold))
                }
                Text(title)
                    .font(.system(size: 13, weight: .bold))
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 10)
            .background(isActive ? theme.btn : theme.sf)
            .foregroundColor(isActive ? theme.btnText : theme.t3)
            .clipShape(Capsule())
        }
        .opacity(isActive ? 1 : 0.6)
    }
}

// MARK: - ToggleGroup

struct ToggleGroup: View {
    let options: [String]
    let selected: String
    let theme: TerseTheme
    let onSelect: (String) -> Void

    var body: some View {
        HStack(spacing: 2) {
            ForEach(options, id: \.self) { option in
                Button {
                    onSelect(option)
                } label: {
                    Text(option)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(selected == option ? theme.btnText : theme.t3)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .background(selected == option ? theme.btn : Color.clear)
                        .clipShape(Capsule())
                }
                .animation(.easeInOut(duration: 0.15), value: selected)
            }
        }
        .padding(3)
        .background(.ultraThinMaterial, in: Capsule())
    }
}

// MARK: - TechniqueTags

struct TechniqueTags: View {
    let techniques: [String]
    let theme: TerseTheme

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                ForEach(techniques, id: \.self) { technique in
                    Text(technique)
                        .font(.system(size: 9, weight: .bold))
                        .foregroundColor(theme.t2)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(.ultraThinMaterial, in: Capsule())
                }
            }
        }
    }
}

// MARK: - TokenStats

struct TokenStats: View {
    let before: Int
    let after: Int
    let percent: Int
    let theme: TerseTheme

    var body: some View {
        HStack(spacing: 8) {
            Text(formatTokens(before))
                .font(.system(size: 15, weight: .bold, design: .monospaced))
                .foregroundColor(theme.t2)
            Image(systemName: "arrow.right")
                .font(.system(size: 10, weight: .medium))
                .foregroundColor(theme.t3)
            Text(formatTokens(after))
                .font(.system(size: 15, weight: .bold, design: .monospaced))
                .foregroundColor(theme.accent)
            if percent > 0 {
                Text("-\(percent)%")
                    .font(.system(size: 14, weight: .heavy))
                    .foregroundColor(theme.accent)
            }
            Spacer()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .glassCard(cornerRadius: 12)
    }

    private func formatTokens(_ n: Int) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
        if n >= 1_000 { return String(format: "%.1fK", Double(n) / 1_000) }
        return "\(n)"
    }
}

// MARK: - ThemePicker

struct ThemePicker: View {
    let selected: String
    let theme: TerseTheme
    let onSelect: (String) -> Void

    private struct ThemeItem: Identifiable {
        let id: String
        let colors: [Color]
        var name: String { id }
    }

    private var themes: [ThemeItem] {
        TerseThemeName.allCases.map { name in
            let t = TerseTheme.theme(for: name)
            if let grad = t.bgGradient {
                return ThemeItem(id: name.rawValue, colors: grad)
            } else {
                return ThemeItem(id: name.rawValue, colors: [t.bg])
            }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Solid themes
            Text("SOLID")
                .font(.system(size: 9, weight: .bold))
                .tracking(0.5)
                .foregroundColor(theme.t3.opacity(0.5))

            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 8), spacing: 12) {
                ForEach(themes.filter { $0.colors.count == 1 }, id: \.id) { t in
                    themeCircle(t)
                }
            }

            // Gradient themes
            Text("GRADIENT")
                .font(.system(size: 9, weight: .bold))
                .tracking(0.5)
                .foregroundColor(theme.t3.opacity(0.5))
                .padding(.top, 4)

            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 5), spacing: 12) {
                ForEach(themes.filter { $0.colors.count > 1 }, id: \.id) { t in
                    themeCircle(t)
                }
            }
        }
        .padding(16)
        .glassCard(cornerRadius: 14)
    }

    private func themeCircle(_ t: ThemeItem) -> some View {
        Button { onSelect(t.name) } label: {
            ZStack {
                if t.colors.count > 1 {
                    Circle()
                        .fill(LinearGradient(colors: t.colors, startPoint: .topLeading, endPoint: .bottomTrailing))
                        .frame(width: 34, height: 34)
                } else {
                    Circle()
                        .fill(t.colors[0])
                        .frame(width: 34, height: 34)
                }
                if selected == t.name {
                    Circle()
                        .strokeBorder(Color.white, lineWidth: 2.5)
                        .frame(width: 34, height: 34)
                    Image(systemName: "checkmark")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundColor(.white)
                }
            }
            .shadow(color: t.colors[0].opacity(0.3), radius: 3, y: 2)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Glass Card Modifier

struct GlassCard: ViewModifier {
    var cornerRadius: CGFloat = 16

    func body(content: Content) -> some View {
        content
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .stroke(Color.white.opacity(0.3), lineWidth: 0.5)
            )
            .shadow(color: Color.black.opacity(0.08), radius: 8, y: 4)
    }
}

extension View {
    func glassCard(cornerRadius: CGFloat = 16) -> some View {
        modifier(GlassCard(cornerRadius: cornerRadius))
    }
}

// MARK: - Animated Glass App Background

struct GlassAppBackground: View {
    let theme: TerseTheme
    @State private var animate = false

    var body: some View {
        ZStack {
            // Base: solid or gradient
            if let grad = theme.bgGradient {
                LinearGradient(colors: grad, startPoint: .topLeading, endPoint: .bottomTrailing)
            } else {
                theme.bg
            }

            // Animated blurred shapes for glass depth
            Circle()
                .fill(Color.white.opacity(0.3))
                .frame(width: 280, height: 280)
                .blur(radius: 80)
                .offset(x: animate ? -60 : -120, y: animate ? -180 : -220)

            Circle()
                .fill(theme.accent.opacity(0.25))
                .frame(width: 220, height: 220)
                .blur(radius: 70)
                .offset(x: animate ? 140 : 80, y: animate ? 60 : 120)

            Ellipse()
                .fill(Color.white.opacity(0.18))
                .frame(width: 320, height: 160)
                .blur(radius: 50)
                .offset(x: animate ? 20 : 60, y: animate ? -320 : -360)
        }
        .ignoresSafeArea()
        .onAppear {
            withAnimation(.easeInOut(duration: 6).repeatForever(autoreverses: true)) {
                animate = true
            }
        }
    }
}

// MARK: - Shimmer Effect (for premium buttons)

struct ShimmerModifier: ViewModifier {
    @State private var phase: CGFloat = 0

    func body(content: Content) -> some View {
        content
            .overlay(
                GeometryReader { geo in
                    LinearGradient(
                        colors: [.clear, Color.white.opacity(0.25), .clear],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                    .frame(width: geo.size.width * 0.4)
                    .offset(x: phase * geo.size.width * 1.4 - geo.size.width * 0.2)
                    .mask(content)
                }
            )
            .onAppear {
                withAnimation(.linear(duration: 2.5).repeatForever(autoreverses: false)) {
                    phase = 1
                }
            }
    }
}

extension View {
    func shimmer() -> some View {
        modifier(ShimmerModifier())
    }
}

// MARK: - TerseStats (local stats storage)

class TerseStats {
    static let shared = TerseStats()
    private let defaults: UserDefaults

    init() {
        defaults = UserDefaults(suiteName: "group.com.terseai.shared") ?? .standard
    }

    private var entries: [[String: Any]] {
        get { defaults.array(forKey: "stats_entries") as? [[String: Any]] ?? [] }
        set { defaults.set(newValue, forKey: "stats_entries") }
    }

    func record(tokensIn: Int, tokensSaved: Int, source: String) {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        var all = entries
        all.append(["date": formatter.string(from: Date()), "tokensIn": tokensIn, "tokensSaved": tokensSaved, "source": source])
        entries = all
    }

    func getData(for period: StatsView.StatsPeriod) -> StatsData {
        let all = entries
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        let now = Date()
        let cutoff: Date
        switch period {
        case .day: cutoff = Calendar.current.startOfDay(for: now)
        case .week: cutoff = Calendar.current.date(byAdding: .day, value: -7, to: now) ?? now
        case .month: cutoff = Calendar.current.date(byAdding: .month, value: -1, to: now) ?? now
        case .all: cutoff = Date.distantPast
        }
        let filtered = all.filter { e in
            guard let ds = e["date"] as? String, let d = formatter.date(from: ds) else { return false }
            return d >= cutoff
        }
        var totalIn = 0, totalSaved = 0, totalMsgs = 0
        var dayMap: [String: (Int, Int)] = [:]
        var srcMap: [String: (Int, Int, Int)] = [:]
        for e in filtered {
            let tIn = e["tokensIn"] as? Int ?? 0
            let tSaved = e["tokensSaved"] as? Int ?? 0
            let src = e["source"] as? String ?? "manual"
            let date = e["date"] as? String ?? ""
            totalIn += tIn; totalSaved += tSaved; totalMsgs += 1
            let ex = dayMap[date] ?? (0, 0); dayMap[date] = (ex.0 + tIn, ex.1 + tSaved)
            let se = srcMap[src] ?? (0, 0, 0); srcMap[src] = (se.0 + tIn, se.1 + tSaved, se.2 + 1)
        }
        let pct = totalIn > 0 ? Int(round(Double(totalSaved) / Double(totalIn) * 100)) : 0
        let days = dayMap.keys.sorted().map { date -> DayStats in
            let parts = date.split(separator: "-")
            let label = parts.count >= 3 ? "\(parts[1])/\(parts[2])" : date
            let v = dayMap[date]!
            return DayStats(date: date, dateLabel: label, tokensIn: v.0, tokensSaved: v.1)
        }
        let sourceColors: [String: Color] = ["keyboard": .blue, "manual": Color(red: 0.71, green: 0.33, blue: 0.04), "action": Color(red: 0.43, green: 0.16, blue: 0.85)]
        let sourceNames: [String: String] = ["keyboard": "Keyboard", "manual": "Manual", "action": "Action"]
        let sources = srcMap.map { (key, val) -> SourceStats in
            let p = val.0 > 0 ? Int(round(Double(val.1) / Double(val.0) * 100)) : 0
            return SourceStats(name: sourceNames[key] ?? key.capitalized, color: sourceColors[key] ?? .gray, tokensIn: val.0, tokensSaved: val.1, messages: val.2, percent: p)
        }
        return StatsData(tokensIn: totalIn, tokensSaved: totalSaved, percentSaved: pct, messagesTotal: totalMsgs, byDay: days, bySource: sources)
    }
}
