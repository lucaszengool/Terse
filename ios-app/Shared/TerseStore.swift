import StoreKit

@MainActor
class TerseStore: ObservableObject {
    static let shared = TerseStore()

    private let productIds = ["com.pruneai.pro.monthly"]

    @Published var products: [Product] = []
    @Published var purchasedProductIds: Set<String> = []
    @Published var isPurchasing = false
    @Published var errorMessage: String?

    var isPro: Bool { purchasedProductIds.contains("com.pruneai.pro.monthly") }

    var proProduct: Product? { products.first { $0.id == "com.pruneai.pro.monthly" } }

    init() {
        Task { await loadProducts() }
        Task { await listenForTransactions() }
        Task { await updatePurchasedProducts() }
    }

    func loadProducts() async {
        do {
            products = try await Product.products(for: productIds)
            print("[TerseStore] Loaded \(products.count) products: \(products.map { $0.id })")
            if products.isEmpty {
                errorMessage = "Subscription not available yet. Please try again later."
            }
        } catch {
            print("[TerseStore] Failed to load products: \(error)")
            errorMessage = "Could not load subscriptions."
        }
    }

    func purchase(_ product: Product) async {
        isPurchasing = true
        errorMessage = nil

        do {
            let result = try await product.purchase()
            switch result {
            case .success(let verification):
                let transaction = try checkVerified(verification)
                await updatePurchasedProducts()
                await transaction.finish()
                // Notify server and sync license
                await syncWithServer(transaction: transaction)
                TerseAuth.shared.verifyLicense()
                print("[TerseStore] Purchase successful: \(product.id)")
            case .userCancelled:
                print("[TerseStore] User cancelled")
            case .pending:
                print("[TerseStore] Purchase pending")
            @unknown default:
                break
            }
        } catch {
            errorMessage = "Purchase failed. Please try again."
            print("[TerseStore] Purchase error: \(error)")
        }

        isPurchasing = false
    }

    func restore() async {
        try? await AppStore.sync()
        await updatePurchasedProducts()
    }

    func updatePurchasedProducts() async {
        var purchased: Set<String> = []

        for await result in Transaction.currentEntitlements {
            if let transaction = try? checkVerified(result) {
                if transaction.revocationDate == nil {
                    purchased.insert(transaction.productID)
                }
            }
        }

        purchasedProductIds = purchased
        print("[TerseStore] Active subscriptions: \(purchased)")

        // Update TerseAuth tier and persist to UserDefaults so keyboard extension sees it
        let auth = TerseAuth.shared
        let defaults = UserDefaults(suiteName: "group.com.pruneai.shared")
        if isPro {
            if auth.tier == "free" {
                auth.tier = "pro"
                auth.optimizationsPerWeek = -1
                auth.remaining = -1
                defaults?.set("pro", forKey: "licenseTier")
                defaults?.set(-1, forKey: "optimizationsPerWeek")
                defaults?.synchronize()
                print("[TerseStore] Persisted Pro tier to UserDefaults")
            }
        } else {
            // If no active subscription, revert to free (unless server says otherwise)
            if auth.tier == "pro" {
                defaults?.set("free", forKey: "licenseTier")
                defaults?.set(120, forKey: "optimizationsPerWeek")
                defaults?.synchronize()
            }
        }
    }

    private func listenForTransactions() async {
        for await result in Transaction.updates {
            if let transaction = try? checkVerified(result) {
                await updatePurchasedProducts()
                await transaction.finish()
                await syncWithServer(transaction: transaction)
            }
        }
    }

    private func checkVerified<T>(_ result: VerificationResult<T>) throws -> T {
        switch result {
        case .unverified(_, let error):
            throw error
        case .verified(let value):
            return value
        }
    }

    /// Sync the latest active transaction with the server — call after SubscriptionStoreView purchase
    func syncLatestTransaction() async {
        for await result in Transaction.currentEntitlements {
            if let transaction = try? checkVerified(result) {
                await syncWithServer(transaction: transaction)
                return
            }
        }
    }

    private func syncWithServer(transaction: Transaction) async {
        guard let userId = TerseAuth.shared.clerkUserId, !userId.isEmpty else { return }
        guard let url = URL(string: "https://www.pruneai.com/api/iap/verify") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body: [String: Any] = [
            "clerkUserId": userId,
            "productId": transaction.productID,
            "transactionId": String(transaction.id),
            "originalTransactionId": String(transaction.originalID),
            "expirationDate": transaction.expirationDate?.timeIntervalSince1970 ?? 0,
        ]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            print("[TerseStore] Server sync response: \(status)")
        } catch {
            print("[TerseStore] Server sync failed: \(error)")
        }
    }
}
