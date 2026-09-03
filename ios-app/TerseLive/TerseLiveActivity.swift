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
                        /* The number, drawn as particles rather than set as
                           type — the one place in the Island wide enough for it
                           to read, and the thing the wallpaper is for.

                           It holds still. A Live Activity gets a static
                           snapshot, its animations are capped at two seconds
                           and switched off entirely on an Always-On display, so
                           this is the field's TEXT, not the field. */
                        ParticleText(text: context.state.glyph,
                                     size: 26, dot: 1.7,
                                     color: Color(hex: 0x4ade80))
                            .padding(.bottom, 1)
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
                    /* What the wallpaper structurally cannot carry. The Home
                       Screen picture is a still that a Shortcut swaps on a
                       schedule, so an agent that started thirty seconds ago is
                       not on it. Here it is. */
                    if context.state.agentCount > 0 {
                        HStack(spacing: 6) {
                            Circle()
                                .fill(Color(hex: 0x4ade80))
                                .frame(width: 5, height: 5)
                            Text(context.state.agentName.isEmpty
                                 ? "\(context.state.agentCount) running"
                                 : context.state.agentName)
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundColor(.white)
                            if !context.state.agentLine.isEmpty {
                                Text(context.state.agentLine)
                                    .font(.system(size: 11))
                                    .foregroundColor(.gray)
                                    .lineLimit(1)
                                    .truncationMode(.tail)
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(.top, 2)
                    } else {
                        Text("Tap to open Terse")
                            .font(.system(size: 10))
                            .foregroundColor(.gray)
                            .padding(.top, 2)
                    }
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

    /* THE GLASS LIVES HERE, AND ONLY HERE.
       The Dynamic Island's background is the physical cutout — always black, by
       design, so the pill and the hardware read as one object. There is no
       translucency to give it. The Lock Screen banner is a real view over the
       user's own wallpaper, so it is the surface where the Mac window's look
       actually transfers, and `.ultraThinMaterial` is genuine backdrop blur
       rather than a grey fill pretending to be one. */
    @ViewBuilder
    private func lockScreenView(context: ActivityViewContext<TerseActivityAttributes>) -> some View {
        VStack(spacing: 8) {
            HStack {
                HStack(spacing: 6) {
                    Circle()
                        .fill(Color(hex: 0x4ade80))
                        .frame(width: 10, height: 10)
                    Text("Terse")
                        .font(.system(size: 15, weight: .bold))
                }
                Spacer()
                ParticleText(text: context.state.glyph, size: 20, dot: 1.5,
                             color: Color(hex: 0x4ade80))
                Text(modeLabel(context.state.mode))
                    .font(.system(size: 11, weight: .semibold))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Color.white.opacity(0.16))
                    .cornerRadius(10)
            }

            if context.state.agentCount > 0 {
                HStack(spacing: 6) {
                    Text(context.state.agentName.isEmpty
                         ? "\(context.state.agentCount) agents"
                         : context.state.agentName)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(.white)
                    if !context.state.agentLine.isEmpty {
                        Text(context.state.agentLine)
                            .font(.system(size: 12))
                            .foregroundColor(.white.opacity(0.6))
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                    Spacer(minLength: 0)
                }
            }
        }
        .padding(16)
        .background(.ultraThinMaterial)
        /* The tint the system paints BEHIND the material. Without it the
           banner takes the wallpaper's colour and the green stops reading. */
        .activityBackgroundTint(Color.black.opacity(0.45))
        .activitySystemActionForegroundColor(Color(hex: 0x4ade80))
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
