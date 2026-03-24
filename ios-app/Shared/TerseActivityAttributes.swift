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
    }
    var startTime: Date
}
#endif
