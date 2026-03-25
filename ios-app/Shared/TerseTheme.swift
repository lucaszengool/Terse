import SwiftUI

enum TerseThemeName: String, CaseIterable, Codable, Identifiable {
    var id: String { rawValue }
    // Original 8 solid
    case lime, lavender, coral, teal, midnight, rose, sage, sand
    // 8 new solid
    case arctic, peach, indigo, mint, charcoal, blush, ocean, amber
    // 10 gradient
    case sunset, aurora, neon, sakura, ember, frost, tropical, velvet, dawn, cosmic
}

struct TerseTheme {
    let bg: Color
    let bgGradient: [Color]?  // nil = solid, non-nil = gradient theme
    let t1: Color
    let t2: Color
    let t3: Color
    let btn: Color
    let btnText: Color
    let accent: Color
    let surface: Color
    let surfaceHover: Color
    let border: Color

    // Convenience init for solid themes
    init(bg: Color, t1: Color, t2: Color, t3: Color, btn: Color, btnText: Color,
         accent: Color, surface: Color, surfaceHover: Color, border: Color) {
        self.bg = bg; self.bgGradient = nil; self.t1 = t1; self.t2 = t2; self.t3 = t3
        self.btn = btn; self.btnText = btnText; self.accent = accent
        self.surface = surface; self.surfaceHover = surfaceHover; self.border = border
    }

    // Init for gradient themes
    init(bg: Color, gradient: [Color], t1: Color, t2: Color, t3: Color, btn: Color, btnText: Color,
         accent: Color, surface: Color, surfaceHover: Color, border: Color) {
        self.bg = bg; self.bgGradient = gradient; self.t1 = t1; self.t2 = t2; self.t3 = t3
        self.btn = btn; self.btnText = btnText; self.accent = accent
        self.surface = surface; self.surfaceHover = surfaceHover; self.border = border
    }

    var isGradient: Bool { bgGradient != nil }

    static func theme(for name: TerseThemeName) -> TerseTheme {
        switch name {
        case .lime:
            return TerseTheme(
                bg: Color(hex: 0xd1e847), t1: Color(hex: 0x0a0a0a), t2: Color(hex: 0x333333), t3: Color(hex: 0x555555),
                btn: .white, btnText: Color(hex: 0x0a0a0a), accent: Color(hex: 0x2d8b00),
                surface: Color.white.opacity(0.5), surfaceHover: Color.white.opacity(0.65),
                border: Color.black.opacity(0.06))
        case .lavender:
            return TerseTheme(
                bg: Color(hex: 0xc4b5fd), t1: Color(hex: 0x1a0a3e), t2: Color(hex: 0x3d2570), t3: Color(hex: 0x5a3d99),
                btn: .white, btnText: Color(hex: 0x1a0a3e), accent: Color(hex: 0x6d28d9),
                surface: Color.white.opacity(0.5), surfaceHover: Color.white.opacity(0.65),
                border: Color(hex: 0x1a0a3e).opacity(0.08))
        case .coral:2783
            return TerseTheme(
                bg: Color(hex: 0xff8a80), t1: Color(hex: 0x4a0000), t2: Color(hex: 0x6e1010), t3: Color(hex: 0x8b2020),
                btn: .white, btnText: Color(hex: 0x4a0000), accent: Color(hex: 0xb91c1c),
                surface: Color.white.opacity(0.5), surfaceHover: Color.white.opacity(0.65),
                border: Color(hex: 0x4a0000).opacity(0.08))
        case .teal:
            return TerseTheme(
                bg: Color(hex: 0x5eead4), t1: Color(hex: 0x022c22), t2: Color(hex: 0x0a4a3e), t3: Color(hex: 0x15665a),
                btn: .white, btnText: Color(hex: 0x022c22), accent: Color(hex: 0x0f766e),
                surface: Color.white.opacity(0.5), surfaceHover: Color.white.opacity(0.65),
                border: Color(hex: 0x022c22).opacity(0.08))
        case .midnight:
            return TerseTheme(
                bg: Color(hex: 0x1e293b), t1: Color(hex: 0xe2e8f0), t2: Color(hex: 0x94a3b8), t3: Color(hex: 0x64748b),
                btn: .white, btnText: Color(hex: 0x1e293b), accent: Color(hex: 0x38bdf8),
                surface: Color.white.opacity(0.1), surfaceHover: Color.white.opacity(0.16),
                border: Color.white.opacity(0.08))
        case .rose:
            return TerseTheme(
                bg: Color(hex: 0xfda4af), t1: Color(hex: 0x350a14), t2: Color(hex: 0x5c1a2a), t3: Color(hex: 0x7d2a40),
                btn: .white, btnText: Color(hex: 0x350a14), accent: Color(hex: 0xbe123c),
                surface: Color.white.opacity(0.5), surfaceHover: Color.white.opacity(0.65),
                border: Color(hex: 0x350a14).opacity(0.08))
        case .sage:
            return TerseTheme(
                bg: Color(hex: 0x86efac), t1: Color(hex: 0x022c16), t2: Color(hex: 0x0a4a28), t3: Color(hex: 0x15663e),
                btn: .white, btnText: Color(hex: 0x022c16), accent: Color(hex: 0x15803d),
                surface: Color.white.opacity(0.5), surfaceHover: Color.white.opacity(0.65),
                border: Color(hex: 0x022c16).opacity(0.08))
        case .sand:
            return TerseTheme(
                bg: Color(hex: 0xfde68a), t1: Color(hex: 0x1c1300), t2: Color(hex: 0x44360a), t3: Color(hex: 0x665218),
                btn: .white, btnText: Color(hex: 0x1c1300), accent: Color(hex: 0xb45309),
                surface: Color.white.opacity(0.55), surfaceHover: Color.white.opacity(0.7),
                border: Color(hex: 0x1c1300).opacity(0.08))

        // ── 8 New Solid Themes ──

        case .arctic:
            return TerseTheme(
                bg: Color(hex: 0xe0f2fe), t1: Color(hex: 0x0c2340), t2: Color(hex: 0x1e3a5f), t3: Color(hex: 0x4a6f8f),
                btn: .white, btnText: Color(hex: 0x0c2340), accent: Color(hex: 0x0284c7),
                surface: Color.white.opacity(0.55), surfaceHover: Color.white.opacity(0.7),
                border: Color(hex: 0x0c2340).opacity(0.06))
        case .peach:
            return TerseTheme(
                bg: Color(hex: 0xffd7be), t1: Color(hex: 0x3d1500), t2: Color(hex: 0x6b2f10), t3: Color(hex: 0x8f4a25),
                btn: .white, btnText: Color(hex: 0x3d1500), accent: Color(hex: 0xe8590c),
                surface: Color.white.opacity(0.5), surfaceHover: Color.white.opacity(0.65),
                border: Color(hex: 0x3d1500).opacity(0.06))
        case .indigo:
            return TerseTheme(
                bg: Color(hex: 0x312e81), t1: Color(hex: 0xe0e7ff), t2: Color(hex: 0xa5b4fc), t3: Color(hex: 0x6366f1),
                btn: .white, btnText: Color(hex: 0x312e81), accent: Color(hex: 0x818cf8),
                surface: Color.white.opacity(0.1), surfaceHover: Color.white.opacity(0.16),
                border: Color.white.opacity(0.1))
        case .mint:
            return TerseTheme(
                bg: Color(hex: 0xc7f9cc), t1: Color(hex: 0x0a2e12), t2: Color(hex: 0x1a4a25), t3: Color(hex: 0x3a6a45),
                btn: .white, btnText: Color(hex: 0x0a2e12), accent: Color(hex: 0x22c55e),
                surface: Color.white.opacity(0.5), surfaceHover: Color.white.opacity(0.65),
                border: Color(hex: 0x0a2e12).opacity(0.06))
        case .charcoal:
            return TerseTheme(
                bg: Color(hex: 0x27272a), t1: Color(hex: 0xfafafa), t2: Color(hex: 0xa1a1aa), t3: Color(hex: 0x71717a),
                btn: .white, btnText: Color(hex: 0x27272a), accent: Color(hex: 0xf59e0b),
                surface: Color.white.opacity(0.08), surfaceHover: Color.white.opacity(0.14),
                border: Color.white.opacity(0.08))
        case .blush:
            return TerseTheme(
                bg: Color(hex: 0xfce7f3), t1: Color(hex: 0x3b0a2a), t2: Color(hex: 0x6b1d4a), t3: Color(hex: 0x9b3570),
                btn: .white, btnText: Color(hex: 0x3b0a2a), accent: Color(hex: 0xec4899),
                surface: Color.white.opacity(0.5), surfaceHover: Color.white.opacity(0.65),
                border: Color(hex: 0x3b0a2a).opacity(0.06))
        case .ocean:
            return TerseTheme(
                bg: Color(hex: 0x164e63), t1: Color(hex: 0xecfeff), t2: Color(hex: 0x67e8f9), t3: Color(hex: 0x22d3ee),
                btn: .white, btnText: Color(hex: 0x164e63), accent: Color(hex: 0x06b6d4),
                surface: Color.white.opacity(0.1), surfaceHover: Color.white.opacity(0.16),
                border: Color.white.opacity(0.08))
        case .amber:
            return TerseTheme(
                bg: Color(hex: 0xfbbf24), t1: Color(hex: 0x1c1300), t2: Color(hex: 0x44360a), t3: Color(hex: 0x665218),
                btn: .white, btnText: Color(hex: 0x1c1300), accent: Color(hex: 0xd97706),
                surface: Color.white.opacity(0.5), surfaceHover: Color.white.opacity(0.65),
                border: Color(hex: 0x1c1300).opacity(0.06))

        // ── 10 Gradient Themes ──

        case .sunset:
            return TerseTheme(bg: Color(hex: 0xff6b6b),
                gradient: [Color(hex: 0xff6b6b), Color(hex: 0xffa07a), Color(hex: 0xffd93d)],
                t1: .white, t2: Color.white.opacity(0.9), t3: Color.white.opacity(0.7),
                btn: .white, btnText: Color(hex: 0xcc3300), accent: Color(hex: 0xff4500),
                surface: Color.white.opacity(0.2), surfaceHover: Color.white.opacity(0.3),
                border: Color.white.opacity(0.2))
        case .aurora:
            return TerseTheme(bg: Color(hex: 0x0f172a),
                gradient: [Color(hex: 0x0f172a), Color(hex: 0x1e3a5f), Color(hex: 0x06b6d4), Color(hex: 0x22c55e)],
                t1: .white, t2: Color.white.opacity(0.85), t3: Color.white.opacity(0.6),
                btn: .white, btnText: Color(hex: 0x0f172a), accent: Color(hex: 0x22d3ee),
                surface: Color.white.opacity(0.1), surfaceHover: Color.white.opacity(0.16),
                border: Color.white.opacity(0.12))
        case .neon:
            return TerseTheme(bg: Color(hex: 0x0a0a0a),
                gradient: [Color(hex: 0x0a0a0a), Color(hex: 0x6d28d9), Color(hex: 0xec4899)],
                t1: .white, t2: Color.white.opacity(0.85), t3: Color.white.opacity(0.6),
                btn: .white, btnText: Color(hex: 0x0a0a0a), accent: Color(hex: 0xa855f7),
                surface: Color.white.opacity(0.08), surfaceHover: Color.white.opacity(0.14),
                border: Color.white.opacity(0.1))
        case .sakura:
            return TerseTheme(bg: Color(hex: 0xfce7f3),
                gradient: [Color(hex: 0xfce7f3), Color(hex: 0xf9a8d4), Color(hex: 0xc084fc)],
                t1: Color(hex: 0x3b0a2a), t2: Color(hex: 0x6b1d4a), t3: Color(hex: 0x9b4580),
                btn: .white, btnText: Color(hex: 0x3b0a2a), accent: Color(hex: 0xd946ef),
                surface: Color.white.opacity(0.4), surfaceHover: Color.white.opacity(0.55),
                border: Color(hex: 0x3b0a2a).opacity(0.08))
        case .ember:
            return TerseTheme(bg: Color(hex: 0x1a0000),
                gradient: [Color(hex: 0x1a0000), Color(hex: 0x7f1d1d), Color(hex: 0xf97316)],
                t1: .white, t2: Color.white.opacity(0.85), t3: Color.white.opacity(0.6),
                btn: .white, btnText: Color(hex: 0x1a0000), accent: Color(hex: 0xf97316),
                surface: Color.white.opacity(0.1), surfaceHover: Color.white.opacity(0.16),
                border: Color.white.opacity(0.1))
        case .frost:
            return TerseTheme(bg: Color(hex: 0x000428),
                gradient: [Color(hex: 0x000428), Color(hex: 0x004e92), Color(hex: 0x6dd5ed)],
                t1: .white, t2: Color.white.opacity(0.85), t3: Color.white.opacity(0.6),
                btn: .white, btnText: Color(hex: 0x000428), accent: Color(hex: 0x38bdf8),
                surface: Color.white.opacity(0.1), surfaceHover: Color.white.opacity(0.16),
                border: Color.white.opacity(0.12))
        case .tropical:
            return TerseTheme(bg: Color(hex: 0x02aab0),
                gradient: [Color(hex: 0x56ab2f), Color(hex: 0x02aab0), Color(hex: 0x00cdac)],
                t1: .white, t2: Color.white.opacity(0.9), t3: Color.white.opacity(0.7),
                btn: .white, btnText: Color(hex: 0x023a2e), accent: Color(hex: 0x00cdac),
                surface: Color.white.opacity(0.2), surfaceHover: Color.white.opacity(0.3),
                border: Color.white.opacity(0.2))
        case .velvet:
            return TerseTheme(bg: Color(hex: 0x42275a),
                gradient: [Color(hex: 0x42275a), Color(hex: 0x734b6d), Color(hex: 0xcc2b5e)],
                t1: .white, t2: Color.white.opacity(0.85), t3: Color.white.opacity(0.6),
                btn: .white, btnText: Color(hex: 0x42275a), accent: Color(hex: 0xcc2b5e),
                surface: Color.white.opacity(0.12), surfaceHover: Color.white.opacity(0.2),
                border: Color.white.opacity(0.12))
        case .dawn:
            return TerseTheme(bg: Color(hex: 0xffecd2),
                gradient: [Color(hex: 0xffecd2), Color(hex: 0xfcb69f), Color(hex: 0xff8a80)],
                t1: Color(hex: 0x2d1a0e), t2: Color(hex: 0x5a3520), t3: Color(hex: 0x8a5535),
                btn: .white, btnText: Color(hex: 0x2d1a0e), accent: Color(hex: 0xe8590c),
                surface: Color.white.opacity(0.4), surfaceHover: Color.white.opacity(0.55),
                border: Color(hex: 0x2d1a0e).opacity(0.08))
        case .cosmic:
            return TerseTheme(bg: Color(hex: 0x0f0c29),
                gradient: [Color(hex: 0x0f0c29), Color(hex: 0x302b63), Color(hex: 0x24243e)],
                t1: .white, t2: Color.white.opacity(0.85), t3: Color.white.opacity(0.6),
                btn: .white, btnText: Color(hex: 0x0f0c29), accent: Color(hex: 0x818cf8),
                surface: Color.white.opacity(0.08), surfaceHover: Color.white.opacity(0.14),
                border: Color.white.opacity(0.1))
        }
    }

    // Aliases for compatibility with Components.swift
    var sf: Color { surface }
    var sfh: Color { surfaceHover }

    // UIKit colors for keyboard extension
    var bgUI: UIColor { UIColor(bg) }
    var t1UI: UIColor { UIColor(t1) }
    var t2UI: UIColor { UIColor(t2) }
    var t3UI: UIColor { UIColor(t3) }
    var btnUI: UIColor { UIColor(btn) }
    var btnTextUI: UIColor { UIColor(btnText) }
    var accentUI: UIColor { UIColor(accent) }
    var surfaceUI: UIColor { UIColor(surface) }
    var surfaceHoverUI: UIColor { UIColor(surfaceHover) }
}

// MARK: - Color Hex Init

extension Color {
    init(hex: UInt, alpha: Double = 1.0) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: alpha
        )
    }
}

extension UIColor {
    convenience init(hex: UInt, alpha: CGFloat = 1.0) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: alpha
        )
    }
}
