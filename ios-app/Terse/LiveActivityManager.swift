import Foundation
import SwiftUI

#if canImport(ActivityKit)
import ActivityKit

/**
 Starts, updates and ends the Dynamic Island activity.

 THIS IS THE PIECE THAT WAS MISSING. The widget in TerseLive and the attributes
 in Shared have both been in the project for a long time, and nothing ever
 called `Activity.request`. So the Island was never dead code that broke — it
 was dead code that had never once run, which is why nobody had seen it.

 Everything here is a no-op rather than an error when Live Activities are
 unavailable: the entitlement can be off, the user can disable them in Settings,
 and the whole feature is absent below iOS 16.1. A monitor toggle that throws
 because the phone is a 13 mini is worse than one that quietly stays off.
 */
@MainActor
final class LiveActivityManager: ObservableObject {
    static let shared = LiveActivityManager()

    /// The user's switch, remembered across launches. Read through
    /// `UserDefaults` rather than `@AppStorage` so the manager can be used from
    /// places that are not a View.
    private static let key = "terse.liveActivity.enabled"

    @Published private(set) var isRunning = false
    @Published var enabled: Bool {
        didSet {
            guard oldValue != enabled else { return }
            UserDefaults.standard.set(enabled, forKey: Self.key)
            if enabled { start() } else { stop() }
        }
    }

    /// Whether the switch can do anything at all on this device.
    var isSupported: Bool {
        if #available(iOS 16.1, *) {
            return ActivityAuthorizationInfo().areActivitiesEnabled
        }
        return false
    }

    private var activity: Any?

    private init() {
        enabled = UserDefaults.standard.bool(forKey: Self.key)
        // Adopt an activity that outlived the app. iOS keeps Live Activities
        // running across launches and even across a crash, so requesting a
        // second one would leave two Islands fighting over the same pill.
        if #available(iOS 16.1, *) {
            if let existing = Activity<TerseActivityAttributes>.activities.first {
                activity = existing
                isRunning = true
            }
        }
    }

    // MARK: - lifecycle

    func start() {
        guard #available(iOS 16.1, *), enabled, !isRunning, isSupported else { return }
        do {
            let a = try Activity.request(
                attributes: TerseActivityAttributes(startTime: Date()),
                contentState: currentState(),
                pushType: nil            // updated in-process; no push server
            )
            activity = a
            isRunning = true
        } catch {
            // Requesting can fail for reasons the user controls (activities
            // switched off, too many already running). Leave the switch on so
            // it retries next launch, and say nothing.
            isRunning = false
        }
    }

    func stop() {
        guard #available(iOS 16.1, *), let a = activity as? Activity<TerseActivityAttributes> else {
            isRunning = false
            return
        }
        Task {
            // .immediate, not .default: "off" has to mean the pill is gone now.
            // The default policy leaves it on screen for up to four hours.
            await a.end(dismissalPolicy: .immediate)
            self.activity = nil
            self.isRunning = false
        }
    }

    /**
     Push a new state.

     ⚠ THROTTLED, AND THAT IS NOT A NICETY. The system coalesces Live Activity
     updates and animates each one; pushing faster than the animation cycle
     drops frames and jitters the pill. Apple's guidance is on the order of
     seconds, so an agent log arriving line by line has to be sampled rather
     than forwarded.
     */
    private var lastPush = Date.distantPast
    private static let minInterval: TimeInterval = 5

    func update(force: Bool = false) {
        guard #available(iOS 16.1, *), isRunning,
              let a = activity as? Activity<TerseActivityAttributes> else { return }
        let now = Date()
        guard force || now.timeIntervalSince(lastPush) >= Self.minInterval else { return }
        lastPush = now
        let state = currentState()
        Task { await a.update(using: state) }
    }

    // MARK: - state

    /// What the Island should currently say. Kept in one place so the initial
    /// request and every later update cannot drift apart.
    private func currentState() -> TerseActivityAttributes.ContentState {
        let d = UserDefaults.standard
        return .init(
            tokensSaved: d.integer(forKey: "terse.stats.tokensSaved"),
            totalOptimizations: d.integer(forKey: "terse.stats.totalOptimizations"),
            mode: d.string(forKey: "terse.settings.mode") ?? "balanced",
            autoMode: d.string(forKey: "terse.settings.autoMode") ?? "off",
            percentSaved: d.integer(forKey: "terse.stats.percentSaved"),
            isActive: true,
            agentName: Self.clip(d.string(forKey: "terse.agent.name") ?? "", 22),
            agentLine: Self.clip(d.string(forKey: "terse.agent.line") ?? "", 48),
            agentCount: d.integer(forKey: "terse.agent.count")
        )
    }

    /// Clipped here rather than in the view: an oversized ContentState is
    /// REJECTED, so the limit has to hold before the payload is built, not
    /// after it fails to display.
    private static func clip(_ s: String, _ n: Int) -> String {
        s.count <= n ? s : String(s.prefix(n - 1)) + "…"
    }
}
#endif
