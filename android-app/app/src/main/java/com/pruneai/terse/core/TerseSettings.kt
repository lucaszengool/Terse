package com.pruneai.terse.core

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

enum class AggressivenessMode(val label: String, val description: String) {
    LIGHT("Light", "Typo correction and whitespace only."),
    BALANCED("Balanced", "Removes filler, politeness, hedging."),
    AGGRESSIVE("Aggressive", "Maximum compression.")
}

class TerseSettings private constructor(context: Context) {

    private val prefs: SharedPreferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    private val _aggressiveness = MutableStateFlow(loadEnum("aggressiveness", AggressivenessMode.BALANCED))
    val aggressiveness: StateFlow<AggressivenessMode> = _aggressiveness

    private val _theme = MutableStateFlow(loadEnum("theme", TerseThemeName.CREAM))
    val theme: StateFlow<TerseThemeName> = _theme

    private val _removeFillerWords = MutableStateFlow(prefs.getBoolean("removeFillerWords", true))
    val removeFillerWords: StateFlow<Boolean> = _removeFillerWords

    private val _removePoliteness = MutableStateFlow(prefs.getBoolean("removePoliteness", true))
    val removePoliteness: StateFlow<Boolean> = _removePoliteness

    private val _removeHedging = MutableStateFlow(prefs.getBoolean("removeHedging", true))
    val removeHedging: StateFlow<Boolean> = _removeHedging

    private val _removeMetaLanguage = MutableStateFlow(prefs.getBoolean("removeMetaLanguage", true))
    val removeMetaLanguage: StateFlow<Boolean> = _removeMetaLanguage

    private val _shortenPhrases = MutableStateFlow(prefs.getBoolean("shortenPhrases", true))
    val shortenPhrases: StateFlow<Boolean> = _shortenPhrases

    private val _simplifyInstructions = MutableStateFlow(prefs.getBoolean("simplifyInstructions", true))
    val simplifyInstructions: StateFlow<Boolean> = _simplifyInstructions

    private val _removeRedundancy = MutableStateFlow(prefs.getBoolean("removeRedundancy", true))
    val removeRedundancy: StateFlow<Boolean> = _removeRedundancy

    private val _compressWhitespace = MutableStateFlow(prefs.getBoolean("compressWhitespace", true))
    val compressWhitespace: StateFlow<Boolean> = _compressWhitespace

    private val _compressCodeBlocks = MutableStateFlow(prefs.getBoolean("compressCodeBlocks", true))
    val compressCodeBlocks: StateFlow<Boolean> = _compressCodeBlocks

    private val _useAbbreviations = MutableStateFlow(prefs.getBoolean("useAbbreviations", true))
    val useAbbreviations: StateFlow<Boolean> = _useAbbreviations

    private val _deduplicateContent = MutableStateFlow(prefs.getBoolean("deduplicateContent", true))
    val deduplicateContent: StateFlow<Boolean> = _deduplicateContent

    private val _compressLists = MutableStateFlow(prefs.getBoolean("compressLists", true))
    val compressLists: StateFlow<Boolean> = _compressLists

    private val _correctTypos = MutableStateFlow(prefs.getBoolean("correctTypos", true))
    val correctTypos: StateFlow<Boolean> = _correctTypos

    private val _hapticFeedback = MutableStateFlow(prefs.getBoolean("hapticFeedback", true))
    val hapticFeedback: StateFlow<Boolean> = _hapticFeedback

    private val _showTokenCount = MutableStateFlow(prefs.getBoolean("showTokenCount", true))
    val showTokenCount: StateFlow<Boolean> = _showTokenCount

    private val _autoOptimizeOnPaste = MutableStateFlow(prefs.getBoolean("autoOptimizeOnPaste", false))
    val autoOptimizeOnPaste: StateFlow<Boolean> = _autoOptimizeOnPaste

    private val _hasSeenSetup = MutableStateFlow(prefs.getBoolean("hasSeenSetup", false))
    val hasSeenSetup: StateFlow<Boolean> = _hasSeenSetup

    private val _totalTokensOptimized = MutableStateFlow(prefs.getInt("totalTokensOptimized", 0))
    val totalTokensOptimized: StateFlow<Int> = _totalTokensOptimized

    private val _totalTokensSaved = MutableStateFlow(prefs.getInt("totalTokensSaved", 0))
    val totalTokensSaved: StateFlow<Int> = _totalTokensSaved

    private val _totalOptimizations = MutableStateFlow(prefs.getInt("totalOptimizations", 0))
    val totalOptimizations: StateFlow<Int> = _totalOptimizations

    fun setAggressiveness(v: AggressivenessMode) { _aggressiveness.value = v; prefs.edit().putString("aggressiveness", v.name).apply() }
    fun setTheme(v: TerseThemeName) { _theme.value = v; prefs.edit().putString("theme", v.name).apply() }
    fun setRemoveFillerWords(v: Boolean) { _removeFillerWords.value = v; prefs.edit().putBoolean("removeFillerWords", v).apply() }
    fun setRemovePoliteness(v: Boolean) { _removePoliteness.value = v; prefs.edit().putBoolean("removePoliteness", v).apply() }
    fun setRemoveHedging(v: Boolean) { _removeHedging.value = v; prefs.edit().putBoolean("removeHedging", v).apply() }
    fun setRemoveMetaLanguage(v: Boolean) { _removeMetaLanguage.value = v; prefs.edit().putBoolean("removeMetaLanguage", v).apply() }
    fun setShortenPhrases(v: Boolean) { _shortenPhrases.value = v; prefs.edit().putBoolean("shortenPhrases", v).apply() }
    fun setSimplifyInstructions(v: Boolean) { _simplifyInstructions.value = v; prefs.edit().putBoolean("simplifyInstructions", v).apply() }
    fun setRemoveRedundancy(v: Boolean) { _removeRedundancy.value = v; prefs.edit().putBoolean("removeRedundancy", v).apply() }
    fun setCompressWhitespace(v: Boolean) { _compressWhitespace.value = v; prefs.edit().putBoolean("compressWhitespace", v).apply() }
    fun setCompressCodeBlocks(v: Boolean) { _compressCodeBlocks.value = v; prefs.edit().putBoolean("compressCodeBlocks", v).apply() }
    fun setUseAbbreviations(v: Boolean) { _useAbbreviations.value = v; prefs.edit().putBoolean("useAbbreviations", v).apply() }
    fun setDeduplicateContent(v: Boolean) { _deduplicateContent.value = v; prefs.edit().putBoolean("deduplicateContent", v).apply() }
    fun setCompressLists(v: Boolean) { _compressLists.value = v; prefs.edit().putBoolean("compressLists", v).apply() }
    fun setCorrectTypos(v: Boolean) { _correctTypos.value = v; prefs.edit().putBoolean("correctTypos", v).apply() }
    fun setHapticFeedback(v: Boolean) { _hapticFeedback.value = v; prefs.edit().putBoolean("hapticFeedback", v).apply() }
    fun setShowTokenCount(v: Boolean) { _showTokenCount.value = v; prefs.edit().putBoolean("showTokenCount", v).apply() }
    fun setAutoOptimizeOnPaste(v: Boolean) { _autoOptimizeOnPaste.value = v; prefs.edit().putBoolean("autoOptimizeOnPaste", v).apply() }
    fun setHasSeenSetup(v: Boolean) { _hasSeenSetup.value = v; prefs.edit().putBoolean("hasSeenSetup", v).apply() }

    fun recordOptimization(tokensBefore: Int, tokensAfter: Int) {
        val saved = tokensBefore - tokensAfter
        _totalTokensOptimized.value += tokensBefore
        _totalTokensSaved.value += saved
        _totalOptimizations.value += 1
        prefs.edit()
            .putInt("totalTokensOptimized", _totalTokensOptimized.value)
            .putInt("totalTokensSaved", _totalTokensSaved.value)
            .putInt("totalOptimizations", _totalOptimizations.value)
            .apply()
        recordStatsEntry(tokensBefore, tokensAfter)
    }

    private fun recordStatsEntry(tokensBefore: Int, tokensAfter: Int) {
        val entries = getStatsEntries().toMutableList()
        val today = System.currentTimeMillis() / 86400000L
        val entry = mapOf("date" to today, "tokensIn" to tokensBefore, "tokensSaved" to (tokensBefore - tokensAfter), "source" to "manual")
        entries.add(entry)
        if (entries.size > 1000) entries.removeAt(0)
        val serialized = entries.joinToString("|") { e ->
            "${e["date"]},${e["tokensIn"]},${e["tokensSaved"]},${e["source"]}"
        }
        prefs.edit().putString("stats_entries", serialized).apply()
    }

    fun getStatsEntries(): List<Map<String, Any>> {
        val raw = prefs.getString("stats_entries", "") ?: return emptyList()
        if (raw.isEmpty()) return emptyList()
        return raw.split("|").mapNotNull { line ->
            val parts = line.split(",")
            if (parts.size >= 4) mapOf<String, Any>(
                "date" to (parts[0].toLongOrNull() ?: 0L),
                "tokensIn" to (parts[1].toIntOrNull() ?: 0),
                "tokensSaved" to (parts[2].toIntOrNull() ?: 0),
                "source" to parts[3]
            ) else null
        }
    }

    fun applyTo(optimizer: TerseOptimizer) {
        optimizer.aggressiveness = _aggressiveness.value.name.lowercase()
        optimizer.removeFillerWords = _removeFillerWords.value
        optimizer.removePoliteness = _removePoliteness.value
        optimizer.removeHedging = _removeHedging.value
        optimizer.removeMetaLanguage = _removeMetaLanguage.value
        optimizer.shortenPhrases = _shortenPhrases.value
        optimizer.simplifyInstructions = _simplifyInstructions.value
        optimizer.removeRedundancy = _removeRedundancy.value
        optimizer.compressWhitespace = _compressWhitespace.value
        optimizer.compressCodeBlocks = _compressCodeBlocks.value
        optimizer.useAbbreviations = _useAbbreviations.value
        optimizer.deduplicateContent = _deduplicateContent.value
        optimizer.compressLists = _compressLists.value
        optimizer.correctTypos = _correctTypos.value
    }

    private inline fun <reified T : Enum<T>> loadEnum(key: String, default: T): T {
        val raw = prefs.getString(key, null) ?: return default
        return try { enumValueOf(raw) } catch (e: IllegalArgumentException) { default }
    }

    companion object {
        const val PREFS_NAME = "terse_settings"

        @Volatile private var INSTANCE: TerseSettings? = null

        fun getInstance(context: Context): TerseSettings =
            INSTANCE ?: synchronized(this) {
                INSTANCE ?: TerseSettings(context.applicationContext).also { INSTANCE = it }
            }
    }
}
