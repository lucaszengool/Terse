package com.pruneai.terse.billing

import android.app.Activity
import android.content.Context
import com.android.billingclient.api.*
import com.pruneai.terse.auth.TerseAuth
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

class TerseSubscription private constructor(context: Context) : PurchasesUpdatedListener {

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val appContext = context.applicationContext

    private val _isPurchasing = MutableStateFlow(false)
    val isPurchasing: StateFlow<Boolean> = _isPurchasing

    private val _purchaseError = MutableStateFlow<String?>(null)
    val purchaseError: StateFlow<String?> = _purchaseError

    private var productDetails: ProductDetails? = null

    private val billingClient = BillingClient.newBuilder(appContext)
        .setListener(this)
        .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
        .build()

    init { connectBilling() }

    private fun connectBilling() {
        billingClient.startConnection(object : BillingClientStateListener {
            override fun onBillingSetupFinished(result: BillingResult) {
                if (result.responseCode == BillingClient.BillingResponseCode.OK) {
                    scope.launch { queryProducts() }
                }
            }
            override fun onBillingServiceDisconnected() {
                scope.launch { delay(2000); connectBilling() }
            }
        })
    }

    private suspend fun queryProducts() {
        val params = QueryProductDetailsParams.newBuilder()
            .setProductList(listOf(
                QueryProductDetailsParams.Product.newBuilder()
                    .setProductId(PRODUCT_ID)
                    .setProductType(BillingClient.ProductType.SUBS)
                    .build()
            )).build()

        val result = billingClient.queryProductDetails(params)
        if (result.billingResult.responseCode == BillingClient.BillingResponseCode.OK) {
            productDetails = result.productDetailsList?.firstOrNull()
        }
    }

    fun launchBillingFlow(activity: Activity) {
        val details = productDetails ?: run {
            _purchaseError.value = "Product unavailable. Please try again."; return
        }
        val offerToken = details.subscriptionOfferDetails?.firstOrNull()?.offerToken ?: run {
            _purchaseError.value = "No offer available."; return
        }
        val params = BillingFlowParams.newBuilder()
            .setProductDetailsParamsList(listOf(
                BillingFlowParams.ProductDetailsParams.newBuilder()
                    .setProductDetails(details)
                    .setOfferToken(offerToken)
                    .build()
            )).build()
        _isPurchasing.value = true
        billingClient.launchBillingFlow(activity, params)
    }

    fun restorePurchases() {
        scope.launch {
            val params = QueryPurchasesParams.newBuilder()
                .setProductType(BillingClient.ProductType.SUBS)
                .build()
            val result = billingClient.queryPurchasesAsync(params)
            for (purchase in result.purchasesList) {
                if (purchase.purchaseState == Purchase.PurchaseState.PURCHASED) {
                    handlePurchase(purchase)
                }
            }
        }
    }

    override fun onPurchasesUpdated(result: BillingResult, purchases: List<Purchase>?) {
        _isPurchasing.value = false
        if (result.responseCode == BillingClient.BillingResponseCode.OK && purchases != null) {
            for (purchase in purchases) {
                scope.launch { handlePurchase(purchase) }
            }
        } else if (result.responseCode != BillingClient.BillingResponseCode.USER_CANCELED) {
            _purchaseError.value = "Purchase failed: ${result.debugMessage}"
        }
    }

    private suspend fun handlePurchase(purchase: Purchase) {
        if (purchase.purchaseState != Purchase.PurchaseState.PURCHASED) return

        if (!purchase.isAcknowledged) {
            val ackParams = AcknowledgePurchaseParams.newBuilder()
                .setPurchaseToken(purchase.purchaseToken)
                .build()
            billingClient.acknowledgePurchase(ackParams)
        }

        val auth = TerseAuth.getInstance(appContext)
        val userId = auth.clerkUserId.value ?: return
        verifyWithServer(userId, purchase.purchaseToken)
    }

    private fun verifyWithServer(userId: String, purchaseToken: String) {
        scope.launch {
            try {
                val url = java.net.URL("https://www.pruneai.com/api/iap/verify")
                val conn = url.openConnection() as java.net.HttpURLConnection
                conn.requestMethod = "POST"
                conn.setRequestProperty("Content-Type", "application/json")
                conn.doOutput = true
                val body = org.json.JSONObject().apply {
                    put("clerkUserId", userId)
                    put("purchaseToken", purchaseToken)
                    put("platform", "android")
                }.toString()
                java.io.OutputStreamWriter(conn.outputStream).use { it.write(body) }
                conn.inputStream.bufferedReader().readText()
                withContext(Dispatchers.Main) {
                    TerseAuth.getInstance(appContext).verifyLicense()
                }
            } catch (e: Exception) { /* silent */ }
        }
    }

    companion object {
        const val PRODUCT_ID = "com.pruneai.terse.pro_monthly"

        @Volatile private var INSTANCE: TerseSubscription? = null
        fun getInstance(context: Context): TerseSubscription =
            INSTANCE ?: synchronized(this) {
                INSTANCE ?: TerseSubscription(context.applicationContext).also { INSTANCE = it }
            }
    }
}
