import Foundation

#if canImport(ActivityKit)
import ActivityKit

struct TerseActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        var tokensSaved: Int
        var totalOptimizations: Int
        var mode: String // "light", "balanced", "aggressive"
        var autoMode: String // "off", "send", "auto"
        var percentSaved: Int
        var isActive: Bool

        /* What the wallpaper cannot show, and the Island can.
           The Home Screen picture is a still that a Shortcut replaces on a
           schedule; agent activity moves faster than that and is stale by the
           time it lands. The Island is the surface that can carry it.

           ⚠ KEPT SMALL ON PURPOSE. A Live Activity's ContentState has a hard
           4 KB ceiling and an update over it is rejected outright — with the
           activity left showing whatever it had. One line, one name, clipped at
           the source rather than trusted to be short. */
        var agentName: String = ""
        var agentLine: String = ""
        var agentCount: Int = 0

        /// The string the Island draws as particles. The saving is the number
        /// worth reading at a glance; the mode is already a chip beside it.
        var glyph: String {
            if tokensSaved > 0 && percentSaved > 0 { return "-\(percentSaved)%" }
            if tokensSaved > 0 { return TerseActivityAttributes.short(tokensSaved) }
            return "TERSE"
        }
    }
    var startTime: Date

    /// 1240 -> "1.2k". The Island is narrow and a raw token count does not fit.
    static func short(_ n: Int) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
        if n >= 1_000 { return String(format: "%.1fk", Double(n) / 1_000) }
        return String(n)
    }
}
#endif
