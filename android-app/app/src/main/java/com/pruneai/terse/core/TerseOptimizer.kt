package com.pruneai.terse.core

import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.round

data class OptimizationResult(
    val optimized: String,
    val stats: OptimizationStats,
    val suggestions: List<Suggestion>
)

data class OptimizationStats(
    val originalChars: Int,
    val optimizedChars: Int,
    val originalTokens: Int,
    val optimizedTokens: Int,
    val tokensSaved: Int,
    val percentSaved: Int,
    val techniquesApplied: List<String>
)

data class Suggestion(val type: String, val text: String)

private val SPLIT_TYPOS = listOf(
    "int he" to "in the", "th e" to "the", "wit h" to "with", "fro m" to "from",
    "som e" to "some", "hav e" to "have", "whe n" to "when", "the n" to "then",
    "the y" to "they", "the re" to "there", "the ir" to "their", "whe re" to "where",
    "sho w" to "show", "sho uld" to "should", "cou ld" to "could", "wou ld" to "would"
)

private val TYPOS = mapOf(
    "teh" to "the", "hte" to "the", "thn" to "then", "thne" to "then",
    "thier" to "their", "theri" to "their", "taht" to "that", "htat" to "that",
    "thta" to "that", "tath" to "that", "tha" to "that", "thsi" to "this",
    "tihs" to "this", "htis" to "this", "thsoe" to "those", "thsee" to "these",
    "adn" to "and", "nad" to "and", "anf" to "and", "andd" to "and",
    "aer" to "are", "rae" to "are", "wsa" to "was",
    "wwant" to "want", "wan" to "want", "wnat" to "want", "watn" to "want",
    "wnt" to "want", "wanr" to "want", "wantd" to "wanted", "wnet" to "went",
    "wetn" to "went", "wiht" to "with", "wtih" to "with", "iwth" to "with",
    "wih" to "with", "whit" to "with", "witht" to "with", "waht" to "what",
    "whta" to "what", "wath" to "what", "hwat" to "what", "wehn" to "when",
    "whne" to "when", "whn" to "when", "wehre" to "where", "wheer" to "where",
    "wher" to "where", "whcih" to "which", "wich" to "which", "whihc" to "which",
    "whch" to "which", "whlei" to "while", "whiel" to "while",
    "woudl" to "would", "wuold" to "would", "woud" to "would", "wouldd" to "would",
    "shoudl" to "should", "shuold" to "should", "shoud" to "should", "shold" to "should",
    "coudl" to "could", "cuold" to "could", "coud" to "could", "cld" to "could",
    "hav" to "have", "ahve" to "have", "hvae" to "have", "haev" to "have",
    "hsa" to "has", "ahs" to "has",
    "buil" to "build", "biuld" to "build", "buidl" to "build", "bulid" to "build",
    "buld" to "build", "bulit" to "built", "bilt" to "built",
    "becuase" to "because", "becasue" to "because", "beacuse" to "because",
    "becouse" to "because", "becuz" to "because", "becuse" to "because", "becaues" to "because",
    "definately" to "definitely", "definatly" to "definitely", "definetly" to "definitely",
    "defintely" to "definitely", "defintiely" to "definitely",
    "recieve" to "receive", "recevie" to "receive", "receiev" to "receive",
    "acheive" to "achieve", "achive" to "achieve", "acheiv" to "achieve",
    "occured" to "occurred", "occurence" to "occurrence", "occurance" to "occurrence",
    "seperate" to "separate", "seperately" to "separately", "sepreate" to "separate",
    "neccessary" to "necessary", "neccesary" to "necessary", "necessery" to "necessary", "necesary" to "necessary",
    "accomodate" to "accommodate", "apparantly" to "apparently", "apparenly" to "apparently",
    "calender" to "calendar", "commited" to "committed", "comitted" to "committed",
    "concious" to "conscious", "enviroment" to "environment", "enviorment" to "environment",
    "goverment" to "government", "governmnet" to "government",
    "immediatly" to "immediately", "immediatlely" to "immediately", "immeadiately" to "immediately",
    "independant" to "independent", "knowlege" to "knowledge", "knowledeg" to "knowledge",
    "manualy" to "manually", "noticable" to "noticeable", "occassion" to "occasion",
    "persistant" to "persistent", "postion" to "position", "positon" to "position",
    "possibilty" to "possibility", "prefered" to "preferred", "privledge" to "privilege",
    "proffesional" to "professional", "profesional" to "professional", "publically" to "publicly",
    "recomend" to "recommend", "recomendation" to "recommendation", "recommed" to "recommend",
    "refering" to "referring", "relevent" to "relevant", "relavant" to "relevant",
    "reponse" to "response", "resposne" to "response", "responsne" to "response", "responce" to "response",
    "succesful" to "successful", "successfull" to "successful", "sucess" to "success", "succes" to "success",
    "suprise" to "surprise", "surprize" to "surprise",
    "tecnology" to "technology", "technoogy" to "technology",
    "tommorow" to "tomorrow", "tomorow" to "tomorrow",
    "togehter" to "together", "togather" to "together",
    "untill" to "until", "unitl" to "until",
    "usally" to "usually", "ususally" to "usually", "usaully" to "usually",
    "wierd" to "weird", "writting" to "writing", "writeing" to "writing",
    "wirte" to "write", "wrtie" to "write",
    "pleae" to "please", "pleas" to "please", "plesae" to "please", "plese" to "please",
    "pelase" to "please", "pealse" to "please",
    "anser" to "answer", "answr" to "answer", "anwser" to "answer", "awner" to "answer",
    "abot" to "about", "abut" to "about", "wuld" to "would", "wud" to "would",
    "qick" to "quick", "quik" to "quick", "quck" to "quick",
    "yuo" to "you", "yoru" to "your", "yuor" to "your", "yur" to "your",
    "fo" to "of", "ot" to "to", "si" to "is", "ti" to "it", "ni" to "in", "os" to "so",
    "nto" to "not", "ont" to "not", "cna" to "can", "cane" to "can",
    "jsut" to "just", "juts" to "just", "jst" to "just",
    "liek" to "like", "lkie" to "like", "likee" to "like",
    "knwo" to "know", "konw" to "know", "nkow" to "know",
    "amke" to "make", "mkae" to "make", "maek" to "make",
    "tkae" to "take", "teka" to "take",
    "godo" to "good", "goood" to "good", "nwe" to "new", "enw" to "new",
    "owrk" to "work", "wokr" to "work", "wrk" to "work",
    "tiem" to "time", "tmie" to "time", "itme" to "time",
    "sued" to "used", "uesd" to "used",
    "alos" to "also", "aslo" to "also", "evne" to "even", "eevn" to "even",
    "onyl" to "only", "olny" to "only", "veyr" to "very", "vrey" to "very",
    "somthing" to "something", "soemthing" to "something", "somethign" to "something",
    "eveything" to "everything", "evreything" to "everything", "everythign" to "everything",
    "anythign" to "anything", "anythin" to "anything",
    "abuot" to "about", "abotu" to "about", "baout" to "about",
    "agian" to "again", "agin" to "again",
    "alraedy" to "already", "alredy" to "already", "alreayd" to "already",
    "alrayd" to "already", "alrady" to "already",
    "alwyas" to "always", "alwasy" to "always", "alaways" to "always",
    "befoer" to "before", "befroe" to "before", "beign" to "being", "bieng" to "being"
)

private val FILLER_WORDS = setOf(
    "i", "me", "my", "you", "your", "we", "our", "it", "its", "the", "a", "an",
    "is", "am", "are", "was", "were", "be", "been", "being",
    "do", "does", "did", "have", "has", "had", "will", "would", "could", "should",
    "can", "may", "might", "to", "of", "in", "for", "on", "with", "at", "by",
    "from", "up", "out", "so", "and", "but", "or", "if", "that", "this",
    "just", "also", "very", "really", "much", "well", "still", "too",
    "here", "there", "then", "now", "want", "need", "know", "think", "like",
    "get", "go", "come", "make", "take", "see", "look", "give", "tell", "say",
    "try", "help", "let", "please", "about", "what", "how", "when", "where",
    "who", "why", "which", "not", "no", "any", "some", "all"
)

class TerseOptimizer {
    var aggressiveness = "balanced"
    var removeFillerWords = true
    var removePoliteness = true
    var removeHedging = true
    var removeMetaLanguage = true
    var shortenPhrases = true
    var simplifyInstructions = true
    var removeRedundancy = true
    var compressWhitespace = true
    var compressCodeBlocks = true
    var useAbbreviations = true
    var deduplicateContent = true
    var compressLists = true
    var correctTypos = true

    fun optimize(text: String): OptimizationResult {
        val originalTokens = estimateTokens(text)
        val wordCount = text.trim().split(Regex("\\s+")).size
        if (wordCount < 3) {
            val t = text.trim()
            return OptimizationResult(t, OptimizationStats(text.length, t.length, originalTokens, estimateTokens(t), 0, 0, emptyList()), genSuggestions(text, emptyList()))
        }

        var o = text
        val a = mutableListOf<String>()
        val lvl = aggressiveness

        if (correctTypos) { val b = o; o = correctTyposFn(o); if (o != b) a.add("Corrected typos") }
        if (compressWhitespace) { val b = o; o = rx(o, "\\n{3,}", "\n\n"); o = rx(o, "[ \\t]{2,}", " "); if (o != b) a.add("Compressed whitespace") }

        val (safe, blocks) = protectCode(o); o = safe

        if (lvl == "light") { applyLight(o, a).also { o = it }; o = capFirst(o) }
        if (lvl != "light") {
            o = applyBalanced(o, a)
            if (removeRedundancy) { val b = o; o = removeRedundantContent(o); if (o != b) a.add("Removed redundancy") }
            if (deduplicateContent) { val b = o; o = deduplicateSentences(o); if (o != b) a.add("Deduplicated") }
            val bc = o; o = deduplicateClauses(o); if (o != bc) a.add("Merged similar clauses")
            if (compressLists) { val b = o; o = rx(o, "(?m)^\\s*[-•]\\s+", "- "); o = rx(o, "(?m)^\\s*(\\d+)\\.\\s+", "$1. "); if (o != b) a.add("Compressed lists") }
            if (compressCodeBlocks) { val b = o; o = compressCodeFn(o); if (o != b) a.add("Compressed code") }
            val bn = o; o = numeralize(o); if (o != bn) a.add("Numeralized")
            val bs = o; o = convertToStructured(o); if (o != bs) a.add("Structured format")
            val bk = o; o = contractFormal(o); if (o != bk) a.add("Contracted")
        }
        if (lvl == "aggressive") { o = applyAggressive(o, a) }

        o = restoreCode(o, blocks)
        o = cleanup(o)
        val ot = estimateTokens(o)
        val saved = originalTokens - ot
        val pct = if (originalTokens > 0) (saved.toDouble() / originalTokens * 100).roundToInt() else 0
        return OptimizationResult(o, OptimizationStats(text.length, o.length, originalTokens, ot, saved, pct, a), genSuggestions(text, a))
    }

    fun estimateTokens(text: String): Int {
        val w = text.trim().split(Regex("\\s+")).size
        val p = text.count { !it.isLetter() && !it.isDigit() && !it.isWhitespace() }
        val cjk = text.codePoints().filter { cp ->
            (cp in 0x3040..0x9FFF) || (cp in 0xAC00..0xD7AF)
        }.count().toInt()
        return if (cjk > 0) {
            ceil(cjk * 1.5 + w * 1.3 + p * 0.5).toInt()
        } else {
            ceil(w * 1.3 + p * 0.5).toInt()
        }
    }

    private fun correctTyposFn(text: String): String {
        var r = text
        for ((bad, good) in SPLIT_TYPOS) {
            r = r.replace(Regex("\\b${Regex.escape(bad)}\\b", RegexOption.IGNORE_CASE), good)
        }
        return r.split(" ").joinToString(" ") { word ->
            val stripped = word.lowercase().replace(Regex("[^a-z]"), "")
            val fix = TYPOS[stripped] ?: return@joinToString word
            val trailing = word.replace(Regex("^[a-zA-Z]+"), "")
            val corrected = if (word.first().isUpperCase()) fix.replaceFirstChar { it.uppercase() } else fix
            corrected + trailing
        }
    }

    private fun protectCode(text: String): Pair<String, List<String>> {
        var r = text
        val blocks = mutableListOf<String>()
        for (pat in listOf("```[\\s\\S]*?```", "`[^`]+`", "https?://[^\\s]+")) {
            val regex = Regex(pat)
            val matches = regex.findAll(r).toList().reversed()
            for (m in matches) {
                blocks.add(0, m.value)
                r = r.substring(0, m.range.first) + "⟦CODE${blocks.size - 1}⟧" + r.substring(m.range.last + 1)
            }
        }
        return r to blocks
    }

    private fun restoreCode(text: String, blocks: List<String>): String {
        var r = text
        for ((i, b) in blocks.withIndex()) {
            r = r.replace("⟦CODE$i⟧", b)
        }
        return r
    }

    private fun applyLight(t: String, a: MutableList<String>): String {
        var r = t
        var b = r; r = contractFormal(r); if (r != b) a.add("Contracted")
        b = r; r = rx(r, "\\bin order to\\b", "to", ignoreCase = true); if (r != b) a.add("Shortened phrases")
        b = r; r = rx(r, "^(hi|hello|hey)\\s*(there|assistant|AI)?[,!.]?\\s*", "", ignoreCase = true); if (r != b) a.add("Removed greeting")
        b = r
        r = rx(r, "\\b(thanks in advance|thank you in advance|thanks so much|thank you so much)\\b[^.!?\\n]*[.!?]?\\s*$", "", ignoreCase = true)
        r = rx(r, "\\b(thanks!?|thank you!?)\\s*[.!]?\\s*$", "", ignoreCase = true)
        if (r != b) a.add("Removed closing thanks")
        b = r; r = rx(r, "\\bI hope you('re| are) doing well\\s*(\\w+)?\\s*[.!]?\\s*", "", ignoreCase = true); if (r != b) a.add("Removed fluff")
        return r
    }

    private fun applyBalanced(t: String, a: MutableList<String>): String {
        var r = t
        var b = r; r = removeSelfCtx(r); if (r != b) a.add("Removed self-context")
        if (removePoliteness) { b = r; r = removePolite(r); if (r != b) a.add("Removed politeness") }
        b = r; r = q2imp(r); if (r != b) a.add("Converted to imperative")
        if (removeFillerWords) { b = r; r = rmFillers(r); if (r != b) a.add("Removed filler words") }
        if (removeHedging) { b = r; r = rmHedge(r); if (r != b) a.add("Removed hedging") }
        if (removeMetaLanguage) { b = r; r = rmMeta(r); if (r != b) a.add("Removed meta-language") }
        if (shortenPhrases) { b = r; r = shorten(r); if (r != b) a.add("Shortened phrases") }
        if (simplifyInstructions) { b = r; r = simplifyVocab(r); if (r != b) a.add("Simplified vocabulary") }
        return r
    }

    private fun applyAggressive(t: String, a: MutableList<String>): String {
        var r = t
        if (useAbbreviations) { val b = r; r = abbrev(r); if (r != b) a.add("Abbreviated terms") }
        var b = r; r = stripMd(r); if (r != b) a.add("Stripped formatting")
        b = r; r = rmArticles(r); if (r != b) a.add("Removed articles")
        b = r; r = telegraph(r); if (r != b) a.add("Telegraph compressed")
        b = r; r = consolidateQ(r); if (r != b) a.add("Consolidated questions")
        b = r; r = dropLowInfo(r); if (r != b) a.add("Dropped low-info")
        return r
    }

    private fun contractFormal(t: String): String {
        var r = t
        val pairs = listOf(
            "\\bdo not\\b" to "don't", "\\bcannot\\b" to "can't", "\\bwill not\\b" to "won't",
            "\\bis not\\b" to "isn't", "\\bare not\\b" to "aren't", "\\bwould not\\b" to "wouldn't",
            "\\bshould not\\b" to "shouldn't", "\\bcould not\\b" to "couldn't",
            "\\bdoes not\\b" to "doesn't", "\\bdid not\\b" to "didn't",
            "\\bhas not\\b" to "hasn't", "\\bhave not\\b" to "haven't",
            "\\bit is\\b" to "it's", "\\bthat is\\b" to "that's", "\\bthere is\\b" to "there's"
        )
        for ((p, rep) in pairs) r = rx(r, p, rep, ignoreCase = true)
        return r
    }

    private fun removeSelfCtx(t: String): String {
        var r = t
        for (p in listOf(
            "\\bI'm (a|an) \\w+ (who|that|and|working|trying|looking)\\b[^.!?]*[.!?]?\\s*",
            "\\bI('m| am) (currently )?(working on|trying to|attempting to|looking to|building|developing|creating)\\b",
            "\\bI have (been|a) (\\w+ )?(experience|background|years)\\b[^.!?]*[.!?]?\\s*"
        )) r = rx(r, p, "", ignoreCase = true)
        return r
    }

    private fun removePolite(t: String): String {
        var r = t
        for (p in listOf(
            "\\bplease\\b[,]?\\s*",
            "\\bcould you (please )?",
            "\\bwould you (kindly |please )?",
            "\\bI was wondering if\\b[^.!?]*",
            "\\bif you don't mind\\b[,]?\\s*",
            "\\bwould you be (so kind|able) (as )?to\\b",
            "\\bI('d| would) (really )?appreciate (it )?if\\b",
            "\\bsorry (to bother|to ask|for asking|if this is)\\b[^.!?]*[.!?]?\\s*"
        )) r = rx(r, p, "", ignoreCase = true)
        return r
    }

    private fun q2imp(t: String): String {
        var r = t
        r = rx(r, "\\b[Cc]an you (please )?(explain|show|tell|help|give|provide|list|describe|write|create)", "$2")
        r = rx(r, "\\b[Cc]ould you (please )?(explain|show|tell|help|give|provide|list|describe|write|create)", "$2")
        r = rx(r, "\\b[Ww]ould you (mind )?(explain|show|tell|help|give|provide|list|describe|write|create)(ing)?", "$2")
        return r
    }

    private fun rmFillers(t: String): String {
        var r = t
        for (p in listOf(
            "\\bbasically\\b[,]?\\s*", "\\bactually\\b[,]?\\s*", "\\bjust\\b\\s+",
            "\\breally\\b\\s+", "\\bvery\\b\\s+", "\\bquite\\b\\s+", "\\bpretty much\\b[,]?\\s*",
            "\\bkind of\\b\\s*", "\\bsort of\\b\\s*", "\\bhonestly\\b[,]?\\s*",
            "\\bfrankly\\b[,]?\\s*", "\\bliterally\\b[,]?\\s*", "\\bessentially\\b[,]?\\s*",
            "\\bobviously\\b[,]?\\s*", "\\bclearly\\b[,]?\\s*"
        )) r = rx(r, p, "", ignoreCase = true)
        return r
    }

    private fun rmHedge(t: String): String {
        var r = t
        for (p in listOf(
            "\\bI (think|believe|guess|suppose|imagine|feel like|reckon)\\b[,]?\\s*",
            "\\bmaybe\\b[,]?\\s*", "\\bperhaps\\b[,]?\\s*", "\\bpossibly\\b[,]?\\s*",
            "\\bit seems like\\b\\s*", "\\bit appears that\\b\\s*",
            "\\bto be honest\\b[,]?\\s*", "\\bin my opinion\\b[,]?\\s*"
        )) r = rx(r, p, "", ignoreCase = true)
        return r
    }

    private fun rmMeta(t: String): String {
        var r = t
        for (p in listOf(
            "\\bI (want|need|would like) you to\\b\\s*",
            "\\bwhat I (need|want|am looking for) is\\b\\s*",
            "\\bI('m| am) looking for\\b\\s*",
            "\\bmy question is\\b[,:]?\\s*",
            "\\bI('d| would) like to ask\\b\\s*",
            "\\bI('m| am) wondering\\b\\s*"
        )) r = rx(r, p, "", ignoreCase = true)
        return r
    }

    private fun shorten(t: String): String {
        var r = t
        val pairs = listOf(
            "\\bin order to\\b" to "to", "\\bdue to the fact that\\b" to "because",
            "\\bat this point in time\\b" to "now", "\\bmake sure\\b" to "ensure",
            "\\ba lot of\\b" to "many", "\\bin the event that\\b" to "if",
            "\\bfor the purpose of\\b" to "to", "\\bprior to\\b" to "before",
            "\\bsubsequent to\\b" to "after", "\\bin spite of\\b" to "despite",
            "\\bwith regard to\\b" to "about", "\\bin terms of\\b" to "for",
            "\\bthe majority of\\b" to "most", "\\ba number of\\b" to "several",
            "\\bat the present time\\b" to "now", "\\bin the near future\\b" to "soon",
            "\\bon a daily basis\\b" to "daily", "\\bhas the ability to\\b" to "can",
            "\\bis able to\\b" to "can", "\\btake into account\\b" to "consider"
        )
        for ((p, rep) in pairs) r = rx(r, p, rep, ignoreCase = true)
        return r
    }

    private fun simplifyVocab(t: String): String {
        var r = t
        val pairs = listOf(
            "\\butilize\\b" to "use", "\\bimplement\\b" to "add",
            "\\bdemonstrate\\b" to "show", "\\bapproximately\\b" to "about",
            "\\bsufficient\\b" to "enough", "\\bterminate\\b" to "end",
            "\\binitiate\\b" to "start", "\\bfacilitate\\b" to "help",
            "\\bendeavor\\b" to "try", "\\bcommence\\b" to "begin",
            "\\bascertain\\b" to "find", "\\bameliorate\\b" to "improve",
            "\\belucidate\\b" to "explain", "\\bsubsequently\\b" to "then",
            "\\badditionally\\b" to "also", "\\bfurthermore\\b" to "also",
            "\\bnevertheless\\b" to "but"
        )
        for ((p, rep) in pairs) r = rx(r, p, rep, ignoreCase = true)
        return r
    }

    private fun removeRedundantContent(t: String): String {
        val hasPunct = t.contains(Regex("[.!?]"))
        val clauses = if (hasPunct) t.split(Regex("(?<=[.!?])\\s+")) else t.split(Regex(",\\s*"))
        val seen = mutableListOf<Set<String>>()
        val filtered = mutableListOf<String>()
        for (c in clauses) {
            val n = c.lowercase().replace(Regex("[^\\w\\s]"), "").trim()
            val w = n.split(Regex("\\s+")).filter { it.isNotEmpty() }.toSet()
            if (n.isEmpty() || w.size < 3) { filtered.add(c); continue }
            if (seen.any { existing -> existing.intersect(w).size.toDouble() / max(existing.size, w.size) > 0.75 }) continue
            seen.add(w); filtered.add(c)
        }
        return filtered.joinToString(if (hasPunct) " " else ", ")
    }

    private fun deduplicateSentences(t: String): String {
        val seen = mutableSetOf<String>()
        return t.lines().filter { line ->
            val tr = line.trim()
            if (tr.isEmpty()) return@filter true
            if (seen.contains(tr.lowercase())) return@filter false
            seen.add(tr.lowercase()); true
        }.joinToString("\n")
    }

    private fun deduplicateClauses(t: String): String {
        val parts = t.split(", ")
        if (parts.size < 2) return t
        val seen = mutableSetOf<String>()
        return parts.filter { val n = it.lowercase().trim(); if (seen.contains(n)) false else { seen.add(n); true } }.joinToString(", ")
    }

    private fun compressCodeFn(t: String): String {
        return Regex("```(\\w*)\\n([\\s\\S]*?)```").replace(t) { mr ->
            val lang = mr.groupValues[1]
            var code = mr.groupValues[2]
            code = rx(code, "(?m)^\\s*//\\s*.*$", "")
            code = code.replace(Regex("/\\*[\\s\\S]*?\\*/"), "")
            code = code.replace(Regex("\\n{3,}"), "\n\n").trim()
            "```$lang\n$code\n```"
        }
    }

    private fun numeralize(t: String): String {
        var r = t
        val map = listOf("zero" to "0","one" to "1","two" to "2","three" to "3","four" to "4","five" to "5","six" to "6","seven" to "7","eight" to "8","nine" to "9","ten" to "10","twenty" to "20","thirty" to "30","forty" to "40","fifty" to "50","hundred" to "100")
        for ((w, n) in map) r = rx(r, "\\b$w\\b", n, ignoreCase = true)
        return r
    }

    private fun convertToStructured(t: String): String {
        var r = t
        for ((w, n) in mapOf("first" to "1","second" to "2","third" to "3","fourth" to "4","fifth" to "5")) {
            r = rx(r, "\\b[Tt]he $w (?:thing|point|step|item) is\\s+", "$n. ")
        }
        return r
    }

    private fun abbrev(t: String): String {
        var r = t
        val pairs = listOf(
            "\\bfunction\\b" to "fn", "\\bapplication\\b" to "app", "\\bconfiguration\\b" to "config",
            "\\bdocumentation\\b" to "docs", "\\brepository\\b" to "repo", "\\bdirectory\\b" to "dir",
            "\\binformation\\b" to "info", "\\benvironment\\b" to "env", "\\bdevelopment\\b" to "dev",
            "\\bproduction\\b" to "prod", "\\bauthentication\\b" to "auth", "\\bdatabase\\b" to "DB"
        )
        for ((p, rep) in pairs) r = rx(r, p, rep, ignoreCase = true)
        return r
    }

    private fun stripMd(t: String): String {
        var r = t
        r = rx(r, "\\*{1,2}([^*]+)\\*{1,2}", "$1")
        r = rx(r, "_{1,2}([^_]+)_{1,2}", "$1")
        r = rx(r, "(?m)^#{1,4}\\s+", "")
        return r
    }

    private fun rmArticles(t: String): String {
        var r = t
        r = rx(r, "\\bthe\\b\\s+", "", ignoreCase = true)
        r = rx(r, "\\ba\\b\\s+", "", ignoreCase = true)
        r = rx(r, "\\ban\\b\\s+", "", ignoreCase = true)
        return r
    }

    private fun telegraph(t: String): String {
        var r = t
        r = rx(r, "\\bI (want|need|have|think|believe|know|see|feel|like|hope|wish|expect|prefer|suggest|recommend|understand|guess|suppose|wonder|remember|realize|imagine|consider|tried?)\\b", "$1", ignoreCase = true)
        r = rx(r, "\\byou (can|could|should|might|may|will|would) (also )?(just )?(use|try|check|look|see|read|write|run|add|set|get|find|make|do|go|put|take|give|call|send|open|close|start|stop|move|create|build|install|update|change|remove|delete|test|debug|fix|deploy)\\b", "$4", ignoreCase = true)
        r = rx(r, "\\b(we|you) (need|have|want) to\\b", "", ignoreCase = true)
        r = rx(r, "\\bin order to\\b", "to", ignoreCase = true)
        r = rx(r, "\\bit (would|could) be (good|nice|great|helpful|useful|better|best|ideal) (to|if)\\s*", "", ignoreCase = true)
        r = rx(r, "\\bwhat (you|we|I) (want|need|have|should) to do is\\s*", "", ignoreCase = true)
        r = rx(r, "\\bas (you can see|I said|mentioned|noted|shown|stated|described|explained)\\b[,]?\\s*", "", ignoreCase = true)
        r = rx(r, "\\b(that being said|having said that|that said)\\b[,]?\\s*", "", ignoreCase = true)
        r = rx(r, "\\bthe (thing|point|issue|problem|question|idea) is (that )?\\s*", "", ignoreCase = true)
        r = rx(r, "\\bwhen it comes to\\b", "for", ignoreCase = true)
        r = rx(r, "\\bas a result\\b", "so", ignoreCase = true)
        r = rx(r, "\\bon the other hand\\b", "but", ignoreCase = true)
        r = rx(r, "\\bat the end of the day\\b", "", ignoreCase = true)
        r = rx(r, "\\b(OK|okay|alright|right) so\\b[,]?\\s*", "", ignoreCase = true)
        return r
    }

    private fun consolidateQ(t: String): String {
        val questions = Regex("[^.!?\\n]*\\?").findAll(t).map { it.value }.toList()
        if (questions.size < 2) return t
        val used = mutableSetOf<Int>()
        var r = t
        for (i in questions.indices) {
            if (i in used) continue
            val wi = questions[i].lowercase().replace(Regex("[^\\w\\s]"), "").split(Regex("\\s+")).filter { it.length > 2 }.toSet()
            for (j in (i + 1) until questions.size) {
                if (j in used) continue
                val wj = questions[j].lowercase().replace(Regex("[^\\w\\s]"), "").split(Regex("\\s+")).filter { it.length > 2 }.toSet()
                val mn = minOf(wi.size, wj.size)
                if (mn > 0 && wi.intersect(wj).size.toDouble() / mn >= 0.4) {
                    r = r.replace(questions[j], "")
                    used.add(j)
                }
            }
        }
        return r.replace(Regex("  +"), " ").trim()
    }

    private fun dropLowInfo(t: String): String {
        val sents = t.split(Regex("(?<=[.!?])\\s+"))
        if (sents.size < 3) return t
        val kept = sents.filterIndexed { i, s ->
            val words = s.lowercase().replace(Regex("[^\\w\\s]"), "").split(Regex("\\s+")).filter { it.isNotEmpty() }
            val infoScore = if (words.isEmpty()) 0.0 else words.count { it !in FILLER_WORDS && it.length > 2 }.toDouble() / words.size
            i == 0 || (words.size >= 3 && !(infoScore < 0.1 && words.size < 8))
        }
        if (kept.size == sents.size) return t
        return kept.joinToString(" ").replace(Regex("  +"), " ").trim()
    }

    private fun capFirst(t: String): String =
        if (t.isNotEmpty() && t.first().isLowerCase()) t.replaceFirstChar { it.uppercase() } else t

    private fun cleanup(t: String): String {
        var r = t
        r = r.replace(Regex("\\n{3,}"), "\n\n")
        r = r.replace(Regex(" {2,}"), " ")
        r = r.replace(Regex("\\.\\s*\\."), ".")
        r = rx(r, "(?m)^\\s*[,.:]+\\s*", "")
        r = r.replace(Regex("\\s+([,.])"), "$1")
        r = r.trim()
        if (r.isNotEmpty() && r.first().isLowerCase()) r = r.replaceFirstChar { it.uppercase() }
        r = Regex("([.!?]\\s+)([a-z])").replace(r) { mr ->
            mr.groupValues[1] + mr.groupValues[2].uppercase()
        }
        r = r.replace(Regex("(?i)\\b(and|also|but|or|additionally|furthermore|moreover)\\s*[,.]?\\s*$"), "")
        return r.trim()
    }

    private fun genSuggestions(t: String, a: List<String>): List<Suggestion> {
        val s = mutableListOf<Suggestion>()
        if (t.length > 2000) s.add(Suggestion("structure", "Consider breaking this into smaller, focused prompts."))
        if (Regex("```[\\s\\S]{500,}```").containsMatchIn(t)) s.add(Suggestion("code", "Large code blocks. Include only the relevant snippet."))
        if (t.length < 200) s.add(Suggestion("routing", "Simple prompt — consider a smaller model."))
        if (a.isEmpty()) s.add(Suggestion("info", "Already concise. No optimizations found."))
        return s
    }

    private fun rx(t: String, pattern: String, replacement: String, ignoreCase: Boolean = false): String {
        val options = if (ignoreCase) setOf(RegexOption.IGNORE_CASE) else emptySet()
        return try { Regex(pattern, options).replace(t, replacement) } catch (e: Exception) { t }
    }

    private fun Double.roundToInt() = round(this).toInt()
}
