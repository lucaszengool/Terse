package com.pruneai.terse.auth

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.util.Calendar

class TerseAuth private constructor(context: Context) {

    private val prefs: SharedPreferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val apiBase = "https://www.terseai.org"

    private val _isSignedIn = MutableStateFlow(prefs.getBoolean("isSignedIn", false))
    val isSignedIn: StateFlow<Boolean> = _isSignedIn

    private val _signInError = MutableStateFlow<String?>(null)
    val signInError: StateFlow<String?> = _signInError

    private val _clerkUserId = MutableStateFlow(prefs.getString("clerkUserId", null))
    val clerkUserId: StateFlow<String?> = _clerkUserId

    private val _email = MutableStateFlow(prefs.getString("email", null))
    val email: StateFlow<String?> = _email

    private val _firstName = MutableStateFlow(prefs.getString("firstName", null))
    val firstName: StateFlow<String?> = _firstName

    private val _imageUrl = MutableStateFlow(prefs.getString("imageUrl", null))
    val imageUrl: StateFlow<String?> = _imageUrl

    private val _tier = MutableStateFlow(prefs.getString("licenseTier", "free") ?: "free")
    val tier: StateFlow<String> = _tier

    private val _weeklyUsage = MutableStateFlow(0)
    val weeklyUsage: StateFlow<Int> = _weeklyUsage

    private val _optimizationsPerWeek = MutableStateFlow(prefs.getInt("optimizationsPerWeek", 120))
    val optimizationsPerWeek: StateFlow<Int> = _optimizationsPerWeek

    private val _remaining = MutableStateFlow(0)
    val remaining: StateFlow<Int> = _remaining

    val isUnlimited get() = _optimizationsPerWeek.value < 0
    val canOptimize get() = isUnlimited || _remaining.value > 0
    val tierLabel get() = _tier.value.replaceFirstChar { it.uppercase() }
    val usageText get() = if (isUnlimited) "Unlimited" else "${_remaining.value}/${_optimizationsPerWeek.value} left this week"

    init {
        loadWeeklyUsage()
    }

    fun signInWithGoogle(idToken: String, email: String?, firstName: String?, lastName: String?) {
        scope.launch {
            _signInError.value = null
            try {
                val body = JSONObject().apply {
                    put("identityToken", idToken)
                    put("provider", "google")
                    email?.let { put("email", it) }
                    firstName?.let { put("firstName", it) }
                    lastName?.let { put("lastName", it) }
                }
                val json = post("$apiBase/api/auth/apple", body.toString()) ?: run {
                    _signInError.value = "Network error. Please try again."; return@launch
                }
                if (json.optString("status") != "authenticated") {
                    _signInError.value = "Sign in failed. Please try again."; return@launch
                }
                val userId = json.optString("clerkUserId", "")
                val userEmail = json.optString("email", email ?: "")
                val userImage = json.optString("imageUrl").ifEmpty { null }
                val userFirst = json.optString("firstName").ifEmpty { firstName }
                withContext(Dispatchers.Main) {
                    saveAuth(userId, userEmail, userImage, userFirst)
                    verifyLicense()
                }
            } catch (e: Exception) {
                _signInError.value = "Network error. Please try again."
            }
        }
    }

    fun startWebSignIn(onUrl: (String) -> Unit, onError: (() -> Unit)? = null) {
        scope.launch {
            try {
                val json = post("$apiBase/api/auth/start", "{}")
                val token = json?.optString("token")?.ifEmpty { null }
                if (json == null || token == null) {
                    withContext(Dispatchers.Main) {
                        _signInError.value = "Network error. Please try again."
                        onError?.invoke()
                    }
                    return@launch
                }
                prefs.edit().putString("authToken", token).putBoolean("authCompleted", false).apply()
                val authUrl = "$apiBase/auth-callback.html?token=$token&action=signin"
                withContext(Dispatchers.Main) { onUrl(authUrl) }
                pollForAuth(token)
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    _signInError.value = "Network error. Please try again."
                    onError?.invoke()
                }
            }
        }
    }

    fun checkPendingAuth() {
        if (_isSignedIn.value) return
        val token = prefs.getString("authToken", null) ?: return
        if (prefs.getBoolean("authCompleted", false)) return
        scope.launch { pollForAuth(token) }
    }

    private suspend fun pollForAuth(token: String) {
        delay(1000)
        try {
            val json = get("$apiBase/api/auth/poll/$token") ?: run { pollForAuth(token); return }
            when (json.optString("status")) {
                "authenticated" -> {
                    val userId = json.optString("clerkUserId")
                    val email = json.optString("email")
                    val imageUrl = json.optString("imageUrl").ifEmpty { null }
                    val firstName = json.optString("firstName").ifEmpty { null }
                    prefs.edit().putBoolean("authCompleted", true).apply()
                    withContext(Dispatchers.Main) {
                        saveAuth(userId, email, imageUrl, firstName)
                        verifyLicense()
                    }
                }
                "pending" -> pollForAuth(token)
            }
        } catch (e: Exception) {
            delay(2000); pollForAuth(token)
        }
    }

    fun startCheckout(onUrl: (String) -> Unit) {
        val userId = _clerkUserId.value?.takeIf { it.isNotEmpty() } ?: return
        val userEmail = _email.value ?: ""
        scope.launch {
            try {
                val body = JSONObject().apply {
                    put("tier", "pro")
                    put("clerkUserId", userId)
                    put("clerkUserEmail", userEmail)
                    put("noTrial", false)
                }
                val json = post("$apiBase/api/checkout", body.toString()) ?: return@launch
                val url = json.optString("url").ifEmpty { return@launch }
                withContext(Dispatchers.Main) { onUrl(url) }
            } catch (e: Exception) { /* silent */ }
        }
    }

    fun verifyLicense() {
        val userId = _clerkUserId.value?.takeIf { it.isNotEmpty() } ?: return
        scope.launch {
            try {
                val json = get("$apiBase/api/license/$userId?platform=android") ?: return@launch
                withContext(Dispatchers.Main) {
                    val serverTier = json.optString("tier", "free")
                    val localTier = prefs.getString("licenseTier", "free")
                    val localOpt = prefs.getInt("optimizationsPerWeek", 120)
                    if (localTier == "pro" && localOpt == -1 && serverTier == "free") {
                        _tier.value = "pro"
                        _optimizationsPerWeek.value = -1
                        _remaining.value = -1
                    } else {
                        _tier.value = serverTier
                        val limits = json.optJSONObject("limits")
                        _optimizationsPerWeek.value = limits?.optInt("optimizations_per_week", 120) ?: 120
                    }
                    loadWeeklyUsage()
                    saveLicense()
                }
            } catch (e: Exception) { /* silent */ }
        }
    }

    fun recordOptimization() {
        val currentWeek = currentWeekString
        val savedWeek = prefs.getString("usageWeek", "")
        if (savedWeek != currentWeek) {
            _weeklyUsage.value = 0
            prefs.edit().putString("usageWeek", currentWeek).apply()
        }
        _weeklyUsage.value += 1
        prefs.edit().putInt("weeklyUsage", _weeklyUsage.value).apply()
        updateRemaining()
    }

    fun signOut() {
        _isSignedIn.value = false
        _clerkUserId.value = null
        _email.value = null
        _imageUrl.value = null
        _firstName.value = null
        _tier.value = "free"
        _optimizationsPerWeek.value = 120
        _remaining.value = 120
        _weeklyUsage.value = 0
        prefs.edit()
            .remove("isSignedIn").remove("clerkUserId").remove("email")
            .remove("imageUrl").remove("firstName").remove("licenseTier")
            .remove("optimizationsPerWeek").remove("weeklyUsage").remove("usageWeek")
            .apply()
    }

    fun deleteAccount() {
        val userId = _clerkUserId.value?.takeIf { it.isNotEmpty() }
        if (userId != null) {
            scope.launch {
                try {
                    val body = JSONObject().put("clerkUserId", userId).toString()
                    post("$apiBase/api/auth/delete", body)
                } catch (e: Exception) { /* silent */ }
            }
        }
        signOut()
        prefs.edit()
            .remove("stats_entries").remove("totalTokensSaved")
            .remove("totalTokensOptimized").remove("totalOptimizations")
            .apply()
    }

    private fun saveAuth(clerkUserId: String, email: String, imageUrl: String?, firstName: String?) {
        _isSignedIn.value = true
        _clerkUserId.value = clerkUserId
        _email.value = email
        _imageUrl.value = imageUrl
        _firstName.value = firstName
        prefs.edit()
            .putBoolean("isSignedIn", true)
            .putString("clerkUserId", clerkUserId)
            .putString("email", email)
            .putString("imageUrl", imageUrl)
            .putString("firstName", firstName)
            .apply()
    }

    private fun loadWeeklyUsage() {
        val currentWeek = currentWeekString
        val savedWeek = prefs.getString("usageWeek", "")
        if (savedWeek != currentWeek) {
            _weeklyUsage.value = 0
            prefs.edit().putString("usageWeek", currentWeek).putInt("weeklyUsage", 0).apply()
        } else {
            _weeklyUsage.value = prefs.getInt("weeklyUsage", 0)
        }
        updateRemaining()
    }

    private fun updateRemaining() {
        _remaining.value = if (_optimizationsPerWeek.value < 0) -1
        else maxOf(0, _optimizationsPerWeek.value - _weeklyUsage.value)
    }

    private fun saveLicense() {
        prefs.edit()
            .putString("licenseTier", _tier.value)
            .putInt("optimizationsPerWeek", _optimizationsPerWeek.value)
            .apply()
    }

    private fun post(urlStr: String, body: String): JSONObject? {
        val conn = URL(urlStr).openConnection() as HttpURLConnection
        return try {
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.doOutput = true
            conn.connectTimeout = 10000
            conn.readTimeout = 10000
            OutputStreamWriter(conn.outputStream).use { it.write(body) }
            val response = conn.inputStream.bufferedReader().readText()
            JSONObject(response)
        } catch (e: Exception) { null } finally { conn.disconnect() }
    }

    private fun get(urlStr: String): JSONObject? {
        val conn = URL(urlStr).openConnection() as HttpURLConnection
        return try {
            conn.requestMethod = "GET"
            conn.connectTimeout = 10000
            conn.readTimeout = 10000
            val response = conn.inputStream.bufferedReader().readText()
            JSONObject(response)
        } catch (e: Exception) { null } finally { conn.disconnect() }
    }

    companion object {
        const val PREFS_NAME = "terse_auth"
        private val currentWeekString get() = Calendar.getInstance().let {
            "${it.get(Calendar.YEAR)}${it.get(Calendar.WEEK_OF_YEAR).toString().padStart(2, '0')}"
        }

        @Volatile private var INSTANCE: TerseAuth? = null
        fun getInstance(context: Context): TerseAuth =
            INSTANCE ?: synchronized(this) {
                INSTANCE ?: TerseAuth(context.applicationContext).also { INSTANCE = it }
            }
    }
}
