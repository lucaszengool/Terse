import Foundation

/// Code-based localization — no Xcode lproj setup needed
enum TL {
    static func s(_ key: String) -> String {
        let lang = currentLang
        if let table = translations[lang], let val = table[key] { return val }
        if let val = translations["en"]?[key] { return val }
        return key
    }

    private static var currentLang: String {
        let preferred = Locale.preferredLanguages.first ?? "en"
        if preferred.hasPrefix("zh-Hans") || preferred.hasPrefix("zh-CN") { return "zh-Hans" }
        if preferred.hasPrefix("zh-Hant") || preferred.hasPrefix("zh-TW") || preferred.hasPrefix("zh-HK") { return "zh-Hant" }
        let code = String(preferred.prefix(2))
        return translations.keys.contains(code) ? code : "en"
    }

    // MARK: - All Translations

    private static let translations: [String: [String: String]] = [
        "en": en, "zh-Hans": zhHans, "zh-Hant": zhHant,
        "ja": ja, "ko": ko, "es": es, "fr": fr, "de": de
    ]

    private static let en: [String: String] = [
        "app.name": "Terse",
        "header.saved": "saved",
        "header.pro": "PRO",
        "header.setupKeyboard": "Set up Terse Keyboard",
        "tab.optimize": "Optimize",
        "tab.stats": "Stats",
        "tab.settings": "Settings",
        "optimize.placeholder": "Paste a prompt to optimize...",
        "optimize.button": "Optimize",
        "optimize.optimizing": "Optimizing...",
        "optimize.copy": "Copy",
        "optimize.copied": "Copied",
        "stats.today": "Today",
        "stats.week": "Week",
        "stats.month": "Month",
        "stats.allTime": "All Time",
        "stats.shareReceipt": "Share Receipt",
        "wallet.tokens": "tokens",
        "wallet.unlockThemes": "Unlock themes with saved tokens",
        "wallet.myThemes": "My Themes",
        "wallet.themeShop": "Theme Shop",
        "wallet.unlock": "Unlock (₮100)",
        "wallet.unlockTitle": "Unlock Theme",
        "wallet.unlockHint": "Tap + to browse and unlock themes with your saved tokens",
        "wallet.done": "Done",
        "wallet.cancel": "Cancel",
        "quota.left": "left this week",
        "quota.unlimited": "Unlimited",
        "settings.title": "Settings",
        "settings.account": "ACCOUNT",
        "settings.signOut": "Sign Out",
        "settings.theme": "THEME",
        "mode.soft": "Soft",
        "mode.balanced": "Balanced",
        "mode.aggressive": "Aggressive",
    ]

    private static let zhHans: [String: String] = [
        "app.name": "Terse",
        "header.saved": "已节省",
        "header.pro": "PRO",
        "header.setupKeyboard": "设置 Terse 键盘",
        "tab.optimize": "优化",
        "tab.stats": "统计",
        "tab.settings": "设置",
        "optimize.placeholder": "粘贴提示词来优化...",
        "optimize.button": "优化",
        "optimize.optimizing": "优化中...",
        "optimize.copy": "复制",
        "optimize.copied": "已复制",
        "stats.today": "今天",
        "stats.week": "本周",
        "stats.month": "本月",
        "stats.allTime": "全部",
        "stats.shareReceipt": "分享小票",
        "wallet.tokens": "tokens",
        "wallet.unlockThemes": "用节省的 tokens 解锁主题",
        "wallet.myThemes": "我的主题",
        "wallet.themeShop": "主题商店",
        "wallet.unlock": "解锁 (₮100)",
        "wallet.unlockTitle": "解锁主题",
        "wallet.unlockHint": "点击 + 浏览并用节省的 tokens 解锁更多主题",
        "wallet.done": "完成",
        "wallet.cancel": "取消",
        "quota.left": "本周剩余",
        "quota.unlimited": "无限",
        "settings.title": "设置",
        "settings.account": "账户",
        "settings.signOut": "退出登录",
        "settings.theme": "主题",
        "mode.soft": "轻度",
        "mode.balanced": "均衡",
        "mode.aggressive": "激进",
    ]

    private static let zhHant: [String: String] = [
        "app.name": "Terse",
        "header.saved": "已節省",
        "header.pro": "PRO",
        "header.setupKeyboard": "設定 Terse 鍵盤",
        "tab.optimize": "優化",
        "tab.stats": "統計",
        "tab.settings": "設定",
        "optimize.placeholder": "貼上提示詞來優化...",
        "optimize.button": "優化",
        "optimize.optimizing": "優化中...",
        "optimize.copy": "複製",
        "optimize.copied": "已複製",
        "stats.today": "今天",
        "stats.week": "本週",
        "stats.month": "本月",
        "stats.allTime": "全部",
        "stats.shareReceipt": "分享收據",
        "wallet.tokens": "tokens",
        "wallet.myThemes": "我的主題",
        "wallet.themeShop": "主題商店",
        "wallet.unlock": "解鎖 (₮100)",
        "wallet.unlockHint": "點擊 + 瀏覽並用節省的 tokens 解鎖更多主題",
        "wallet.done": "完成",
        "wallet.cancel": "取消",
        "quota.left": "本週剩餘",
        "settings.title": "設定",
        "mode.soft": "輕度",
        "mode.balanced": "均衡",
        "mode.aggressive": "積極",
    ]

    private static let ja: [String: String] = [
        "header.saved": "節約",
        "header.setupKeyboard": "Terse キーボードを設定",
        "tab.optimize": "最適化",
        "tab.stats": "統計",
        "tab.settings": "設定",
        "optimize.placeholder": "最適化するプロンプトを貼り付け...",
        "optimize.button": "最適化",
        "optimize.copy": "コピー",
        "optimize.copied": "コピー済み",
        "stats.today": "今日",
        "stats.week": "今週",
        "stats.month": "今月",
        "stats.allTime": "全期間",
        "stats.shareReceipt": "レシートを共有",
        "wallet.myThemes": "マイテーマ",
        "wallet.themeShop": "テーマショップ",
        "wallet.done": "完了",
        "mode.soft": "ソフト",
        "mode.balanced": "バランス",
        "mode.aggressive": "アグレッシブ",
    ]

    private static let ko: [String: String] = [
        "header.saved": "절약",
        "tab.optimize": "최적화",
        "tab.stats": "통계",
        "tab.settings": "설정",
        "optimize.placeholder": "최적화할 프롬프트를 붙여넣기...",
        "optimize.button": "최적화",
        "optimize.copy": "복사",
        "optimize.copied": "복사됨",
        "stats.today": "오늘",
        "stats.week": "이번 주",
        "stats.month": "이번 달",
        "stats.allTime": "전체",
        "stats.shareReceipt": "영수증 공유",
        "wallet.myThemes": "내 테마",
        "wallet.done": "완료",
    ]

    private static let es: [String: String] = [
        "header.saved": "ahorrados",
        "tab.optimize": "Optimizar",
        "tab.stats": "Estadísticas",
        "tab.settings": "Ajustes",
        "optimize.placeholder": "Pega un prompt para optimizar...",
        "optimize.button": "Optimizar",
        "optimize.copy": "Copiar",
        "optimize.copied": "Copiado",
        "stats.today": "Hoy",
        "stats.week": "Semana",
        "stats.month": "Mes",
        "stats.allTime": "Todo",
        "stats.shareReceipt": "Compartir recibo",
        "wallet.myThemes": "Mis Temas",
        "wallet.done": "Hecho",
    ]

    private static let fr: [String: String] = [
        "header.saved": "économisés",
        "tab.optimize": "Optimiser",
        "tab.stats": "Statistiques",
        "tab.settings": "Réglages",
        "optimize.placeholder": "Collez un prompt à optimiser...",
        "optimize.button": "Optimiser",
        "optimize.copy": "Copier",
        "optimize.copied": "Copié",
        "stats.today": "Aujourd'hui",
        "stats.week": "Semaine",
        "stats.month": "Mois",
        "stats.allTime": "Tout",
        "stats.shareReceipt": "Partager le reçu",
        "wallet.myThemes": "Mes Thèmes",
        "wallet.done": "Terminé",
    ]

    private static let de: [String: String] = [
        "header.saved": "gespart",
        "tab.optimize": "Optimieren",
        "tab.stats": "Statistiken",
        "tab.settings": "Einstellungen",
        "optimize.placeholder": "Prompt zum Optimieren einfügen...",
        "optimize.button": "Optimieren",
        "optimize.copy": "Kopieren",
        "optimize.copied": "Kopiert",
        "stats.today": "Heute",
        "stats.week": "Woche",
        "stats.month": "Monat",
        "stats.allTime": "Gesamt",
        "stats.shareReceipt": "Beleg teilen",
        "wallet.myThemes": "Meine Themen",
        "wallet.done": "Fertig",
    ]
}
