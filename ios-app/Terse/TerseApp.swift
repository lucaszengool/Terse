import SwiftUI

@main
struct TerseApp: App {
    @StateObject private var settings = TerseSettings.shared
    @StateObject private var auth = TerseAuth.shared

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(settings)
                .environmentObject(auth)
        }
    }
}
