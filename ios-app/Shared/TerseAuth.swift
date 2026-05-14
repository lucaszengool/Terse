import Foundation
import AuthenticationServices

class TerseAuth: ObservableObject {
    static let shared = TerseAuth()

    private let apiBase = "https://www.pruneai.com"
    private let defaults: UserDefaults
    private var webAuthSession: ASWebAuthenticationSession?
    private let contextProvider = WebAuthContextProvider()

    @Published var isSignedIn: Bool = false
    @Published var signInError: String?
    @Published var clerkUserId: String?
    @Published var email: String?
    @Published var firstName: String?
    @Published var imageUrl: String?

    // License
    @Published var tier: String = "free"
    @Published var status: String = "active"
    @Published var weeklyUsage: Int = 0
    @Published var optimizationsPerWeek: Int = 120
    @Published var maxSessions: Int = 1
    @Published var remaining: Int = 120

    var isUnlimited: Bool { optimizationsPerWeek < 0 }
    var canOptimize: Bool { isUnlimited || remaining > 0 }

    var usageText: String {
        if isUnlimited { return "Unlimited" }
        return "\(remaining)/\(optimizationsPerWeek) left this week"
    }

    var tierLabel: String {
        tier.prefix(1).uppercased() + tier.dropFirst()
    }

    init() {
        self.defaults = UserDefaults(suiteName: "group.com.pruneai.shared") ?? .standard
        loadAuth()
        loadLicense()
    }

    // MARK: - Sign in with Apple

    func signInWithApple(credential: ASAuthorizationAppleIDCredential) {
        guard let tokenData = credential.identityToken,
              let identityToken = String(data: tokenData, encoding: .utf8) else {
            print("[TerseAuth] No identity token from Apple")
            return
        }

        let appleEmail = credential.email
        let fullName = credential.fullName
        let firstName = fullName?.givenName
        let lastName = fullName?.familyName

        // Save Apple name locally (Apple only sends it on first sign-in)
        if let fn = firstName {
            defaults.set(fn, forKey: "appleFirstName")
        }
        if let ln = lastName {
            defaults.set(ln, forKey: "appleLastName")
        }

        let savedFirstName = firstName ?? defaults.string(forKey: "appleFirstName")
        let savedLastName = lastName ?? defaults.string(forKey: "appleLastName")

        guard let url = URL(string: "\(apiBase)/api/auth/apple") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        var body: [String: Any] = ["identityToken": identityToken]
        if let e = appleEmail { body["email"] = e }
        if let fn = savedFirstName { body["firstName"] = fn }
        if let ln = savedLastName { body["lastName"] = ln }

        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        print("[TerseAuth] Sending Apple token to server...")
        DispatchQueue.main.async { self.signInError = nil }

        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            guard let self = self else { return }

            if let error = error {
                print("[TerseAuth] Apple auth network error: \(error.localizedDescription)")
                DispatchQueue.main.async { self.signInError = "Network error. Please try again." }
                return
            }

            let httpStatus = (response as? HTTPURLResponse)?.statusCode ?? 0
            let rawStr = data.flatMap { String(data: $0, encoding: .utf8) } ?? "nil"
            print("[TerseAuth] Apple auth response (\(httpStatus)): \(rawStr)")

            guard let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let status = json["status"] as? String,
                  status == "authenticated" else {
                print("[TerseAuth] Apple auth API failed or not authenticated")
                DispatchQueue.main.async { self.signInError = "Sign in failed. Please try again." }
                return
            }

            let userId = json["clerkUserId"] as? String ?? ""
            let email = json["email"] as? String ?? ""
            let imageUrl = json["imageUrl"] as? String
            let name = json["firstName"] as? String ?? savedFirstName

            print("[TerseAuth] Apple Sign In completed! User: \(userId)")

            DispatchQueue.main.async {
                self.signInError = nil
                self.saveAuth(clerkUserId: userId, email: email, imageUrl: imageUrl, firstName: name)
                self.verifyLicense()
            }
        }.resume()
    }

    // MARK: - Web Auth Flow (fallback)

    func startSignIn() {
        guard let url = URL(string: "\(apiBase)/api/auth/start") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"

        URLSession.shared.dataTask(with: request) { [weak self] data, _, error in
            guard let self = self,
                  let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let token = json["token"] as? String else { return }

            self.defaults.set(token, forKey: "authToken")
            self.defaults.set(false, forKey: "authCompleted")

            guard let authURL = URL(string: "\(self.apiBase)/auth-callback.html?token=\(token)&action=signin") else { return }

            DispatchQueue.main.async {
                let session = ASWebAuthenticationSession(
                    url: authURL,
                    callbackURLScheme: "terseauth"
                ) { _, _ in
                    // User dismissed or callback received — check if auth completed
                    self.checkPendingAuth()
                }
                session.presentationContextProvider = self.contextProvider
                session.prefersEphemeralWebBrowserSession = false
                session.start()
                self.webAuthSession = session
            }

            self.pollForAuth(token: token)
        }.resume()
    }

    /// Call this when the app returns to foreground to resume auth check
    func checkPendingAuth() {
        guard !isSignedIn else { return }
        guard let token = defaults.string(forKey: "authToken"), !token.isEmpty else { return }
        if defaults.bool(forKey: "authCompleted") { return }
        print("[TerseAuth] Resuming auth poll for token: \(token.prefix(8))...")
        pollForAuth(token: token)
    }

    private func pollForAuth(token: String) {
        DispatchQueue.global().asyncAfter(deadline: .now() + 1.0) { [weak self] in
            guard let self = self else { return }
            guard let url = URL(string: "\(self.apiBase)/api/auth/poll/\(token)") else { return }

            URLSession.shared.dataTask(with: url) { data, _, _ in
                guard let data = data,
                      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let status = json["status"] as? String else {
                    // Retry
                    self.pollForAuth(token: token)
                    return
                }

                if status == "authenticated" {
                    let userId = json["clerkUserId"] as? String
                    let email = json["email"] as? String
                    let imageUrl = json["imageUrl"] as? String
                    let firstName = json["firstName"] as? String

                    self.defaults.set(true, forKey: "authCompleted")
                    print("[TerseAuth] Auth completed! User: \(userId ?? "nil")")

                    DispatchQueue.main.async {
                        self.webAuthSession?.cancel()
                        self.webAuthSession = nil
                        self.saveAuth(
                            clerkUserId: userId ?? "",
                            email: email ?? "",
                            imageUrl: imageUrl,
                            firstName: firstName
                        )
                        self.verifyLicense()
                    }
                } else if status == "pending" {
                    self.pollForAuth(token: token)
                }
            }.resume()
        }
    }

    // MARK: - Save/Load Auth

    private func saveAuth(clerkUserId: String, email: String, imageUrl: String?, firstName: String?) {
        self.clerkUserId = clerkUserId
        self.email = email
        self.imageUrl = imageUrl
        self.firstName = firstName
        self.isSignedIn = true

        defaults.set(true, forKey: "isSignedIn")
        defaults.set(clerkUserId, forKey: "clerkUserId")
        defaults.set(email, forKey: "email")
        defaults.set(imageUrl, forKey: "imageUrl")
        defaults.set(firstName, forKey: "firstName")
    }

    private func loadAuth() {
        isSignedIn = defaults.bool(forKey: "isSignedIn")
        clerkUserId = defaults.string(forKey: "clerkUserId")
        email = defaults.string(forKey: "email")
        imageUrl = defaults.string(forKey: "imageUrl")
        firstName = defaults.string(forKey: "firstName")
    }

    func signOut() {
        isSignedIn = false
        clerkUserId = nil
        email = nil
        imageUrl = nil
        firstName = nil

        defaults.removeObject(forKey: "isSignedIn")
        defaults.removeObject(forKey: "clerkUserId")
        defaults.removeObject(forKey: "email")
        defaults.removeObject(forKey: "imageUrl")
        defaults.removeObject(forKey: "firstName")

        // Reset license to free
        tier = "free"
        optimizationsPerWeek = 500
        remaining = 500
        weeklyUsage = 0
        saveLicense()
    }

    func deleteAccount() {
        guard let userId = clerkUserId, !userId.isEmpty else {
            signOut()
            return
        }

        // Call server to delete account
        guard let url = URL(string: "\(apiBase)/api/auth/delete") else {
            signOut()
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["clerkUserId": userId])

        URLSession.shared.dataTask(with: request) { _, _, _ in
            print("[TerseAuth] Account deletion requested for \(userId)")
        }.resume()

        // Clear all local data
        signOut()
        defaults.removeObject(forKey: "stats_entries")
        defaults.removeObject(forKey: "totalTokensSaved")
        defaults.removeObject(forKey: "totalTokensOptimized")
        defaults.removeObject(forKey: "totalOptimizations")
        defaults.removeObject(forKey: "weeklyUsage")
        defaults.removeObject(forKey: "usageWeek")
        defaults.removeObject(forKey: "spentTokens")
        defaults.removeObject(forKey: "unlockedThemes")
        defaults.removeObject(forKey: "appleFirstName")
        defaults.removeObject(forKey: "appleLastName")
        defaults.synchronize()
    }

    // MARK: - License

    func verifyLicense() {
        guard let userId = clerkUserId, !userId.isEmpty else {
            print("[TerseAuth] No clerkUserId, skipping license verify")
            return
        }
        guard let url = URL(string: "\(apiBase)/api/license/\(userId)?platform=ios") else { return }
        print("[TerseAuth] Verifying license for: \(userId)")

        URLSession.shared.dataTask(with: url) { [weak self] data, response, error in
            guard let self = self else { return }

            if let error = error {
                print("[TerseAuth] License API error: \(error.localizedDescription)")
                return
            }

            guard let data = data else {
                print("[TerseAuth] No data from license API")
                return
            }

            let rawStr = String(data: data, encoding: .utf8) ?? "nil"
            print("[TerseAuth] License API response: \(rawStr)")

            guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                print("[TerseAuth] Failed to parse JSON")
                return
            }

            DispatchQueue.main.async {
                let serverTier = json["tier"] as? String ?? "free"
                self.status = json["status"] as? String ?? "active"

                // Don't downgrade from Pro if local UserDefaults says user has active subscription
                let localTier = self.defaults.string(forKey: "licenseTier") ?? "free"
                let localOptPerWeek = self.defaults.integer(forKey: "optimizationsPerWeek")
                if localTier == "pro" && localOptPerWeek == -1 && serverTier == "free" {
                    // StoreKit has active subscription — keep Pro, server will catch up
                    self.tier = "pro"
                    self.optimizationsPerWeek = -1
                    self.remaining = -1
                    print("[TerseAuth] Server says free but StoreKit says Pro — keeping Pro")
                } else {
                    self.tier = serverTier
                    if let limits = json["limits"] as? [String: Any] {
                        self.optimizationsPerWeek = limits["optimizations_per_week"] as? Int ?? 120
                        self.maxSessions = limits["max_sessions"] as? Int ?? 1
                    }
                    print("[TerseAuth] Tier: \(self.tier), Status: \(self.status)")
                }

                self.loadWeeklyUsage()
                self.saveLicense()
            }
        }.resume()
    }

    /// Reload usage from UserDefaults (keyboard extension writes here)
    func reloadUsage() {
        defaults.synchronize()
        loadWeeklyUsage()
        objectWillChange.send()
    }

    private func loadWeeklyUsage() {
        let currentWeek = Self.currentWeekString()
        let savedWeek = defaults.string(forKey: "usageWeek") ?? ""
        if savedWeek != currentWeek {
            weeklyUsage = 0
            defaults.set(currentWeek, forKey: "usageWeek")
            defaults.set(0, forKey: "weeklyUsage")
        } else {
            weeklyUsage = defaults.integer(forKey: "weeklyUsage")
        }
        updateRemaining()
    }

    func recordOptimization() {
        let currentWeek = Self.currentWeekString()
        let savedWeek = defaults.string(forKey: "usageWeek") ?? ""
        if savedWeek != currentWeek {
            weeklyUsage = 0
            defaults.set(currentWeek, forKey: "usageWeek")
        }
        weeklyUsage += 1
        defaults.set(weeklyUsage, forKey: "weeklyUsage")
        updateRemaining()
    }

    private func updateRemaining() {
        if optimizationsPerWeek < 0 {
            remaining = -1
        } else {
            remaining = max(0, optimizationsPerWeek - weeklyUsage)
        }
    }

    private func saveLicense() {
        defaults.set(tier, forKey: "licenseTier")
        defaults.set(optimizationsPerWeek, forKey: "optimizationsPerWeek")
        defaults.set(maxSessions, forKey: "maxSessions")
    }

    private func loadLicense() {
        tier = defaults.string(forKey: "licenseTier") ?? "free"
        optimizationsPerWeek = defaults.object(forKey: "optimizationsPerWeek") as? Int ?? 120
        maxSessions = defaults.object(forKey: "maxSessions") as? Int ?? 1
        loadWeeklyUsage()
    }

    private static func currentWeekString() -> String {
        let cal = Calendar(identifier: .iso8601)
        let comps = cal.dateComponents([.yearForWeekOfYear, .weekOfYear], from: Date())
        return "\(comps.yearForWeekOfYear ?? 0)\(String(format: "%02d", comps.weekOfYear ?? 0))"
    }
}

// MARK: - ASWebAuthenticationSession Context Provider

class WebAuthContextProvider: NSObject, ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        return ASPresentationAnchor()
    }
}
