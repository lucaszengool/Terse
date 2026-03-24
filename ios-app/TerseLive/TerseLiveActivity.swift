import ActivityKit
import WidgetKit
import SwiftUI

struct TerseLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: TerseActivityAttributes.self) { context in
            // Lock Screen / Banner view
            lockScreenView(context: context)
        } dynamicIsland: { context in
            DynamicIsland {
                // Expanded view
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 4) {
                        Circle()
                            .fill(Color(hex: 0x4ade80))
                            .frame(width: 8, height: 8)
                        Text("Terse")
                            .font(.system(size: 14, weight: .bold))
                            .foregroundColor(.white)
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(modeLabel(context.state.mode))
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(Color(hex: 0x4ade80))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(Color.white.opacity(0.15))
                        .cornerRadius(10)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(spacing: 4) {
                        if context.state.tokensSaved > 0 {
                            Text("\(formatTokens(context.state.tokensSaved)) tokens saved")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundColor(.white)
                        }
                        HStack(spacing: 12) {
                            Label("\(context.state.totalOptimizations)", systemImage: "arrow.triangle.2.circlepath")
                                .font(.system(size: 11))
                                .foregroundColor(.gray)
                            if context.state.percentSaved > 0 {
                                Text("-\(context.state.percentSaved)%")
                                    .font(.system(size: 11, weight: .bold))
                                    .foregroundColor(Color(hex: 0x4ade80))
                            }
                            Text(autoLabel(context.state.autoMode))
                                .font(.system(size: 11))
                                .foregroundColor(.gray)
                        }
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    Text("Tap to open Terse")
                        .font(.system(size: 10))
                        .foregroundColor(.gray)
                        .padding(.top, 2)
                }
            } compactLeading: {
                HStack(spacing: 3) {
                    Circle()
                        .fill(Color(hex: 0x4ade80))
                        .frame(width: 6, height: 6)
                    Text("T")
                        .font(.system(size: 12, weight: .black))
                        .foregroundColor(.white)
                }
            } compactTrailing: {
                if context.state.tokensSaved > 0 {
                    Text("-\(context.state.percentSaved)%")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundColor(Color(hex: 0x4ade80))
                } else {
                    Text(modeLabel(context.state.mode).prefix(1))
                        .font(.system(size: 11, weight: .bold))
                        .foregroundColor(Color(hex: 0x4ade80))
                }
            } minimal: {
                Circle()
                    .fill(Color(hex: 0x4ade80))
                    .frame(width: 8, height: 8)
            }
        }
    }

    @ViewBuilder
    private func lockScreenView(context: ActivityViewContext<TerseActivityAttributes>) -> some View {
        HStack {
            HStack(spacing: 6) {
                Circle()
                    .fill(Color(hex: 0x4ade80))
                    .frame(width: 10, height: 10)
                Text("Terse")
                    .font(.system(size: 15, weight: .bold))
            }
            Spacer()
            if context.state.tokensSaved > 0 {
                Text("\(formatTokens(context.state.tokensSaved)) saved")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(Color(hex: 0x4ade80))
            }
            Text(modeLabel(context.state.mode))
                .font(.system(size: 11, weight: .semibold))
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(Color.white.opacity(0.2))
                .cornerRadius(10)
        }
        .padding(16)
        .background(Color.black)
    }

    private func modeLabel(_ mode: String) -> String {
        switch mode {
        case "light": return "Soft"
        case "balanced": return "Normal"
        case "aggressive": return "Aggr"
        default: return "Normal"
        }
    }

    private func autoLabel(_ mode: String) -> String {
        switch mode {
        case "send": return "Send"
        case "auto": return "Auto"
        default: return "Off"
        }
    }

    private func formatTokens(_ n: Int) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
        if n >= 1_000 { return String(format: "%.1fK", Double(n) / 1_000) }
        return "\(n)"
    }
}

// Color(hex:) is provided by TerseTheme.swift (shared)
