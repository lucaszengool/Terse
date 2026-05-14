package com.pruneai.terse.core

import androidx.compose.ui.graphics.Color

enum class TerseThemeName(val displayName: String) {
    CREAM("Cream"), LIME("Lime"), LAVENDER("Lavender"), CORAL("Coral"),
    TEAL("Teal"), MIDNIGHT("Midnight"), ROSE("Rose"), SAGE("Sage"), SAND("Sand"),
    ARCTIC("Arctic"), PEACH("Peach"), INDIGO("Indigo"), MINT("Mint"),
    CHARCOAL("Charcoal"), BLUSH("Blush"), OCEAN("Ocean"), AMBER("Amber"),
    SUNSET("Sunset"), AURORA("Aurora"), NEON("Neon"), SAKURA("Sakura"),
    EMBER("Ember"), FROST("Frost"), TROPICAL("Tropical"), VELVET("Velvet"),
    DAWN("Dawn"), COSMIC("Cosmic")
}

data class TerseTheme(
    val bg: Color,
    val bgGradient: List<Color>? = null,
    val t1: Color,
    val t2: Color,
    val t3: Color,
    val btn: Color,
    val btnText: Color,
    val accent: Color,
    val surface: Color,
    val surfaceHover: Color,
    val border: Color
) {
    val isGradient get() = bgGradient != null
}

fun Color.Companion.hex(hex: Long, alpha: Float = 1f) = Color(
    red = ((hex shr 16) and 0xFF).toInt() / 255f,
    green = ((hex shr 8) and 0xFF).toInt() / 255f,
    blue = (hex and 0xFF).toInt() / 255f,
    alpha = alpha
)

object TerseThemes {
    fun get(name: TerseThemeName): TerseTheme = when (name) {
        TerseThemeName.CREAM -> TerseTheme(
            bg = Color.hex(0xFFED29), t1 = Color.hex(0x1A1800), t2 = Color.hex(0x3D3A10), t3 = Color.hex(0x6B6530),
            btn = Color.hex(0x1A1800), btnText = Color.hex(0xFFED29), accent = Color.hex(0x8A8016),
            surface = Color.White.copy(alpha = 0.45f), surfaceHover = Color.White.copy(alpha = 0.6f),
            border = Color.hex(0x1A1800, alpha = 0.10f))
        TerseThemeName.LIME -> TerseTheme(
            bg = Color.hex(0xD1E847), t1 = Color.hex(0x0A0A0A), t2 = Color.hex(0x333333), t3 = Color.hex(0x555555),
            btn = Color.White, btnText = Color.hex(0x0A0A0A), accent = Color.hex(0x2D8B00),
            surface = Color.White.copy(alpha = 0.5f), surfaceHover = Color.White.copy(alpha = 0.65f),
            border = Color.Black.copy(alpha = 0.06f))
        TerseThemeName.LAVENDER -> TerseTheme(
            bg = Color.hex(0xC4B5FD), t1 = Color.hex(0x1A0A3E), t2 = Color.hex(0x3D2570), t3 = Color.hex(0x5A3D99),
            btn = Color.White, btnText = Color.hex(0x1A0A3E), accent = Color.hex(0x6D28D9),
            surface = Color.White.copy(alpha = 0.5f), surfaceHover = Color.White.copy(alpha = 0.65f),
            border = Color.hex(0x1A0A3E, alpha = 0.08f))
        TerseThemeName.CORAL -> TerseTheme(
            bg = Color.hex(0xFF8A80), t1 = Color.hex(0x4A0000), t2 = Color.hex(0x6E1010), t3 = Color.hex(0x8B2020),
            btn = Color.White, btnText = Color.hex(0x4A0000), accent = Color.hex(0xB91C1C),
            surface = Color.White.copy(alpha = 0.5f), surfaceHover = Color.White.copy(alpha = 0.65f),
            border = Color.hex(0x4A0000, alpha = 0.08f))
        TerseThemeName.TEAL -> TerseTheme(
            bg = Color.hex(0x5EEAD4), t1 = Color.hex(0x022C22), t2 = Color.hex(0x0A4A3E), t3 = Color.hex(0x15665A),
            btn = Color.White, btnText = Color.hex(0x022C22), accent = Color.hex(0x0F766E),
            surface = Color.White.copy(alpha = 0.5f), surfaceHover = Color.White.copy(alpha = 0.65f),
            border = Color.hex(0x022C22, alpha = 0.08f))
        TerseThemeName.MIDNIGHT -> TerseTheme(
            bg = Color.hex(0x1E293B), t1 = Color.hex(0xE2E8F0), t2 = Color.hex(0x94A3B8), t3 = Color.hex(0x64748B),
            btn = Color.White, btnText = Color.hex(0x1E293B), accent = Color.hex(0x38BDF8),
            surface = Color.White.copy(alpha = 0.1f), surfaceHover = Color.White.copy(alpha = 0.16f),
            border = Color.White.copy(alpha = 0.08f))
        TerseThemeName.ROSE -> TerseTheme(
            bg = Color.hex(0xFDA4AF), t1 = Color.hex(0x350A14), t2 = Color.hex(0x5C1A2A), t3 = Color.hex(0x7D2A40),
            btn = Color.White, btnText = Color.hex(0x350A14), accent = Color.hex(0xBE123C),
            surface = Color.White.copy(alpha = 0.5f), surfaceHover = Color.White.copy(alpha = 0.65f),
            border = Color.hex(0x350A14, alpha = 0.08f))
        TerseThemeName.SAGE -> TerseTheme(
            bg = Color.hex(0x86EFAC), t1 = Color.hex(0x022C16), t2 = Color.hex(0x0A4A28), t3 = Color.hex(0x15663E),
            btn = Color.White, btnText = Color.hex(0x022C16), accent = Color.hex(0x15803D),
            surface = Color.White.copy(alpha = 0.5f), surfaceHover = Color.White.copy(alpha = 0.65f),
            border = Color.hex(0x022C16, alpha = 0.08f))
        TerseThemeName.SAND -> TerseTheme(
            bg = Color.hex(0xFDE68A), t1 = Color.hex(0x1C1300), t2 = Color.hex(0x44360A), t3 = Color.hex(0x665218),
            btn = Color.White, btnText = Color.hex(0x1C1300), accent = Color.hex(0xB45309),
            surface = Color.White.copy(alpha = 0.55f), surfaceHover = Color.White.copy(alpha = 0.7f),
            border = Color.hex(0x1C1300, alpha = 0.08f))
        TerseThemeName.ARCTIC -> TerseTheme(
            bg = Color.hex(0xE0F2FE), t1 = Color.hex(0x0C2340), t2 = Color.hex(0x1E3A5F), t3 = Color.hex(0x4A6F8F),
            btn = Color.White, btnText = Color.hex(0x0C2340), accent = Color.hex(0x0284C7),
            surface = Color.White.copy(alpha = 0.55f), surfaceHover = Color.White.copy(alpha = 0.7f),
            border = Color.hex(0x0C2340, alpha = 0.06f))
        TerseThemeName.PEACH -> TerseTheme(
            bg = Color.hex(0xFFD7BE), t1 = Color.hex(0x3D1500), t2 = Color.hex(0x6B2F10), t3 = Color.hex(0x8F4A25),
            btn = Color.White, btnText = Color.hex(0x3D1500), accent = Color.hex(0xE8590C),
            surface = Color.White.copy(alpha = 0.5f), surfaceHover = Color.White.copy(alpha = 0.65f),
            border = Color.hex(0x3D1500, alpha = 0.06f))
        TerseThemeName.INDIGO -> TerseTheme(
            bg = Color.hex(0x312E81), t1 = Color.hex(0xE0E7FF), t2 = Color.hex(0xA5B4FC), t3 = Color.hex(0x6366F1),
            btn = Color.White, btnText = Color.hex(0x312E81), accent = Color.hex(0x818CF8),
            surface = Color.White.copy(alpha = 0.1f), surfaceHover = Color.White.copy(alpha = 0.16f),
            border = Color.White.copy(alpha = 0.1f))
        TerseThemeName.MINT -> TerseTheme(
            bg = Color.hex(0xC7F9CC), t1 = Color.hex(0x0A2E12), t2 = Color.hex(0x1A4A25), t3 = Color.hex(0x3A6A45),
            btn = Color.White, btnText = Color.hex(0x0A2E12), accent = Color.hex(0x22C55E),
            surface = Color.White.copy(alpha = 0.5f), surfaceHover = Color.White.copy(alpha = 0.65f),
            border = Color.hex(0x0A2E12, alpha = 0.06f))
        TerseThemeName.CHARCOAL -> TerseTheme(
            bg = Color.hex(0x27272A), t1 = Color.hex(0xFAFAFA), t2 = Color.hex(0xA1A1AA), t3 = Color.hex(0x71717A),
            btn = Color.White, btnText = Color.hex(0x27272A), accent = Color.hex(0xF59E0B),
            surface = Color.White.copy(alpha = 0.08f), surfaceHover = Color.White.copy(alpha = 0.14f),
            border = Color.White.copy(alpha = 0.08f))
        TerseThemeName.BLUSH -> TerseTheme(
            bg = Color.hex(0xFCE7F3), t1 = Color.hex(0x3B0A2A), t2 = Color.hex(0x6B1D4A), t3 = Color.hex(0x9B3570),
            btn = Color.White, btnText = Color.hex(0x3B0A2A), accent = Color.hex(0xEC4899),
            surface = Color.White.copy(alpha = 0.5f), surfaceHover = Color.White.copy(alpha = 0.65f),
            border = Color.hex(0x3B0A2A, alpha = 0.06f))
        TerseThemeName.OCEAN -> TerseTheme(
            bg = Color.hex(0x164E63), t1 = Color.hex(0xECFEFF), t2 = Color.hex(0x67E8F9), t3 = Color.hex(0x22D3EE),
            btn = Color.White, btnText = Color.hex(0x164E63), accent = Color.hex(0x06B6D4),
            surface = Color.White.copy(alpha = 0.1f), surfaceHover = Color.White.copy(alpha = 0.16f),
            border = Color.White.copy(alpha = 0.08f))
        TerseThemeName.AMBER -> TerseTheme(
            bg = Color.hex(0xFBBF24), t1 = Color.hex(0x1C1300), t2 = Color.hex(0x44360A), t3 = Color.hex(0x665218),
            btn = Color.White, btnText = Color.hex(0x1C1300), accent = Color.hex(0xD97706),
            surface = Color.White.copy(alpha = 0.5f), surfaceHover = Color.White.copy(alpha = 0.65f),
            border = Color.hex(0x1C1300, alpha = 0.06f))
        TerseThemeName.SUNSET -> TerseTheme(
            bg = Color.hex(0xFF6B6B),
            bgGradient = listOf(Color.hex(0xFF6B6B), Color.hex(0xFFA07A), Color.hex(0xFFD93D)),
            t1 = Color.White, t2 = Color.White.copy(alpha = 0.9f), t3 = Color.White.copy(alpha = 0.7f),
            btn = Color.White, btnText = Color.hex(0xCC3300), accent = Color.hex(0xFF4500),
            surface = Color.White.copy(alpha = 0.2f), surfaceHover = Color.White.copy(alpha = 0.3f),
            border = Color.White.copy(alpha = 0.2f))
        TerseThemeName.AURORA -> TerseTheme(
            bg = Color.hex(0x0F172A),
            bgGradient = listOf(Color.hex(0x0F172A), Color.hex(0x1E3A5F), Color.hex(0x06B6D4), Color.hex(0x22C55E)),
            t1 = Color.White, t2 = Color.White.copy(alpha = 0.85f), t3 = Color.White.copy(alpha = 0.6f),
            btn = Color.White, btnText = Color.hex(0x0F172A), accent = Color.hex(0x22D3EE),
            surface = Color.White.copy(alpha = 0.1f), surfaceHover = Color.White.copy(alpha = 0.16f),
            border = Color.White.copy(alpha = 0.12f))
        TerseThemeName.NEON -> TerseTheme(
            bg = Color.hex(0x0A0A0A),
            bgGradient = listOf(Color.hex(0x0A0A0A), Color.hex(0x6D28D9), Color.hex(0xEC4899)),
            t1 = Color.White, t2 = Color.White.copy(alpha = 0.85f), t3 = Color.White.copy(alpha = 0.6f),
            btn = Color.White, btnText = Color.hex(0x0A0A0A), accent = Color.hex(0xA855F7),
            surface = Color.White.copy(alpha = 0.08f), surfaceHover = Color.White.copy(alpha = 0.14f),
            border = Color.White.copy(alpha = 0.1f))
        TerseThemeName.SAKURA -> TerseTheme(
            bg = Color.hex(0xFCE7F3),
            bgGradient = listOf(Color.hex(0xFCE7F3), Color.hex(0xF9A8D4), Color.hex(0xC084FC)),
            t1 = Color.hex(0x3B0A2A), t2 = Color.hex(0x6B1D4A), t3 = Color.hex(0x9B4580),
            btn = Color.White, btnText = Color.hex(0x3B0A2A), accent = Color.hex(0xD946EF),
            surface = Color.White.copy(alpha = 0.4f), surfaceHover = Color.White.copy(alpha = 0.55f),
            border = Color.hex(0x3B0A2A, alpha = 0.08f))
        TerseThemeName.EMBER -> TerseTheme(
            bg = Color.hex(0x1A0000),
            bgGradient = listOf(Color.hex(0x1A0000), Color.hex(0x7F1D1D), Color.hex(0xF97316)),
            t1 = Color.White, t2 = Color.White.copy(alpha = 0.85f), t3 = Color.White.copy(alpha = 0.6f),
            btn = Color.White, btnText = Color.hex(0x1A0000), accent = Color.hex(0xF97316),
            surface = Color.White.copy(alpha = 0.1f), surfaceHover = Color.White.copy(alpha = 0.16f),
            border = Color.White.copy(alpha = 0.1f))
        TerseThemeName.FROST -> TerseTheme(
            bg = Color.hex(0x000428),
            bgGradient = listOf(Color.hex(0x000428), Color.hex(0x004E92), Color.hex(0x6DD5ED)),
            t1 = Color.White, t2 = Color.White.copy(alpha = 0.85f), t3 = Color.White.copy(alpha = 0.6f),
            btn = Color.White, btnText = Color.hex(0x000428), accent = Color.hex(0x38BDF8),
            surface = Color.White.copy(alpha = 0.1f), surfaceHover = Color.White.copy(alpha = 0.16f),
            border = Color.White.copy(alpha = 0.12f))
        TerseThemeName.TROPICAL -> TerseTheme(
            bg = Color.hex(0x02AAB0),
            bgGradient = listOf(Color.hex(0x56AB2F), Color.hex(0x02AAB0), Color.hex(0x00CDAC)),
            t1 = Color.White, t2 = Color.White.copy(alpha = 0.9f), t3 = Color.White.copy(alpha = 0.7f),
            btn = Color.White, btnText = Color.hex(0x023A2E), accent = Color.hex(0x00CDAC),
            surface = Color.White.copy(alpha = 0.2f), surfaceHover = Color.White.copy(alpha = 0.3f),
            border = Color.White.copy(alpha = 0.2f))
        TerseThemeName.VELVET -> TerseTheme(
            bg = Color.hex(0x42275A),
            bgGradient = listOf(Color.hex(0x42275A), Color.hex(0x734B6D), Color.hex(0xCC2B5E)),
            t1 = Color.White, t2 = Color.White.copy(alpha = 0.85f), t3 = Color.White.copy(alpha = 0.6f),
            btn = Color.White, btnText = Color.hex(0x42275A), accent = Color.hex(0xCC2B5E),
            surface = Color.White.copy(alpha = 0.12f), surfaceHover = Color.White.copy(alpha = 0.2f),
            border = Color.White.copy(alpha = 0.12f))
        TerseThemeName.DAWN -> TerseTheme(
            bg = Color.hex(0xFFECD2),
            bgGradient = listOf(Color.hex(0xFFECD2), Color.hex(0xFCB69F), Color.hex(0xFF8A80)),
            t1 = Color.hex(0x2D1A0E), t2 = Color.hex(0x5A3520), t3 = Color.hex(0x8A5535),
            btn = Color.White, btnText = Color.hex(0x2D1A0E), accent = Color.hex(0xE8590C),
            surface = Color.White.copy(alpha = 0.4f), surfaceHover = Color.White.copy(alpha = 0.55f),
            border = Color.hex(0x2D1A0E, alpha = 0.08f))
        TerseThemeName.COSMIC -> TerseTheme(
            bg = Color.hex(0x0F0C29),
            bgGradient = listOf(Color.hex(0x0F0C29), Color.hex(0x302B63), Color.hex(0x24243E)),
            t1 = Color.White, t2 = Color.White.copy(alpha = 0.85f), t3 = Color.White.copy(alpha = 0.6f),
            btn = Color.White, btnText = Color.hex(0x0F0C29), accent = Color.hex(0x818CF8),
            surface = Color.White.copy(alpha = 0.08f), surfaceHover = Color.White.copy(alpha = 0.14f),
            border = Color.White.copy(alpha = 0.1f))
    }

    val solidThemes = listOf(
        TerseThemeName.CREAM, TerseThemeName.LIME, TerseThemeName.LAVENDER, TerseThemeName.CORAL,
        TerseThemeName.TEAL, TerseThemeName.MIDNIGHT, TerseThemeName.ROSE, TerseThemeName.SAGE, TerseThemeName.SAND,
        TerseThemeName.ARCTIC, TerseThemeName.PEACH, TerseThemeName.INDIGO, TerseThemeName.MINT,
        TerseThemeName.CHARCOAL, TerseThemeName.BLUSH, TerseThemeName.OCEAN, TerseThemeName.AMBER
    )

    val gradientThemes = listOf(
        TerseThemeName.SUNSET, TerseThemeName.AURORA, TerseThemeName.NEON, TerseThemeName.SAKURA,
        TerseThemeName.EMBER, TerseThemeName.FROST, TerseThemeName.TROPICAL, TerseThemeName.VELVET,
        TerseThemeName.DAWN, TerseThemeName.COSMIC
    )
}
