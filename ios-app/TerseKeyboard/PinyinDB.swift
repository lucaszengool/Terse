import Foundation
import SQLite3

/// Comprehensive pinyin → Chinese lookup using CC-CEDICT (121K+ entries)
/// with Forward Maximum Matching for sentence-level composition
class PinyinDB {
    static let shared = PinyinDB()

    private var db: OpaquePointer?
    private var validSyllables: Set<String> = []
    // Cache of pinyin → top words for fast lookup
    private var wordCache: [String: [(String, Double)]] = [:]

    private init() {
        openDatabase()
        loadValidSyllables()
    }

    deinit { if db != nil { sqlite3_close(db) } }

    private func openDatabase() {
        if let path = Bundle.main.path(forResource: "pinyin_dict", ofType: "db") {
            if sqlite3_open_v2(path, &db, SQLITE_OPEN_READONLY, nil) != SQLITE_OK { db = nil }
        }
    }

    private func loadValidSyllables() {
        guard let db = db else { return }
        var stmt: OpaquePointer?
        let sql = "SELECT DISTINCT pinyin_search FROM entries WHERE char_count = 1"
        if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
            while sqlite3_step(stmt) == SQLITE_ROW {
                if let c = sqlite3_column_text(stmt, 0) {
                    validSyllables.insert(String(cString: c))
                }
            }
        }
        sqlite3_finalize(stmt)
    }

    // MARK: - Main Lookup

    /// Returns candidates: sentence compositions first, then phrases, then single chars
    func lookup(pinyin: String) -> [String] {
        guard let db = db, !pinyin.isEmpty else { return [] }
        let py = pinyin.lowercased()
        var results: [String] = []
        var seen: Set<String> = []

        // 0. If it looks like English, include it as-is
        if isLikelyEnglish(py) {
            results.append(py)
            seen.insert(py)
        }

        // 1. Exact phrase match from dictionary (highest priority)
        let exactPhrases = queryWords(pinyin: py, exact: true, limit: 30)
        for (word, _) in exactPhrases where !seen.contains(word) {
            results.append(word); seen.insert(word)
        }

        // 2. DAG-based optimal sentence composition (Viterbi algorithm)
        let sentence = composeSentence(from: py)
        if !sentence.isEmpty && !seen.contains(sentence) {
            // Insert sentence at position 0 or 1 (highest priority for multi-syllable input)
            let insertAt = results.isEmpty ? 0 : min(1, results.count)
            results.insert(sentence, at: insertAt)
            seen.insert(sentence)
        }

        // 3. Alternative segmentation (prefers 2-char words)
        let altSentence = composeSentenceAlt(from: py)
        if !altSentence.isEmpty && !seen.contains(altSentence) {
            results.append(altSentence); seen.insert(altSentence)
        }

        // 3.5 Fuzzy pinyin matching (模糊拼音): try confusion pairs
        if results.count < 5 {
            for variant in fuzzyVariants(py) {
                let fuzzyResults = queryWords(pinyin: variant, exact: true, limit: 5)
                for (word, _) in fuzzyResults where !seen.contains(word) {
                    results.append(word); seen.insert(word)
                }
                // Also try sentence composition with fuzzy variant
                let fuzzySentence = composeSentence(from: variant)
                if !fuzzySentence.isEmpty && !seen.contains(fuzzySentence) {
                    results.append(fuzzySentence); seen.insert(fuzzySentence)
                }
            }
        }

        // 3.55 QWERTY typo correction: "mi" adjacent to "ni" → also show 你
        if results.count < 5 {
            // Try typo variants for each syllable in the split
            let syllables = splitPinyin(py)
            for syl in syllables {
                for variant in typoVariants(syl) {
                    let typoResults = queryWords(pinyin: variant, exact: true, limit: 3)
                    for (word, _) in typoResults where !seen.contains(word) {
                        results.append(word); seen.insert(word)
                    }
                }
            }
            // Also try typo variants on the full string for sentence composition
            if syllables.isEmpty {
                for variant in typoVariants(py) {
                    let sentence = composeSentence(from: variant)
                    if !sentence.isEmpty && !seen.contains(sentence) {
                        results.append(sentence); seen.insert(sentence)
                    }
                }
            }
        }

        // 3.6 Abbreviated pinyin (首字母): "nhpl" → look up each initial
        if results.isEmpty || splitPinyin(py).isEmpty {
            let abbrevResults = lookupAbbreviatedPinyin(py)
            for word in abbrevResults where !seen.contains(word) {
                results.append(word); seen.insert(word)
            }
        }

        // 3.6 Partial sentence: "nihaopiaol" → try prefix match "nihaopiaoliang"
        if results.count < 5 {
            let partialResults = lookupPartialSentence(py)
            for word in partialResults where !seen.contains(word) {
                results.append(word); seen.insert(word)
            }
        }

        // 4. Partial/prefix matches for single chars
        if results.count < 10 {
            if let syllable = longestMatchingSyllable(py) {
                let chars = queryWords(pinyin: syllable, exact: true, limit: 30)
                for (word, _) in chars where !seen.contains(word) {
                    results.append(word); seen.insert(word)
                }
            }
        }

        // 5. Prefix matches from DB (phrases starting with this pinyin)
        if results.count < 20 {
            let prefix = queryWords(pinyin: py, exact: false, limit: 30)
            for (word, _) in prefix where !seen.contains(word) {
                results.append(word); seen.insert(word)
            }
        }

        // 6. Single letter — show chars from matching syllables
        if results.isEmpty && py.count == 1 {
            let prefix = queryWords(pinyin: py, exact: false, limit: 30)
            for (word, _) in prefix where !seen.contains(word) {
                results.append(word); seen.insert(word)
            }
        }

        // 7. User dictionary (learned words get priority boost)
        let userResults = queryUserDict(pinyin: py)
        for word in userResults where !seen.contains(word) {
            results.insert(word, at: min(1, results.count)) // Insert near top
            seen.insert(word)
        }

        return results
    }

    // MARK: - Context-Aware Next Word Prediction

    /// Given the last word/character, predict what comes next
    func predictNextWord(after lastWord: String) -> [String] {
        guard let db = db, !lastWord.isEmpty else { return [] }
        var results: [String] = []
        var stmt: OpaquePointer?
        let sql = "SELECT word2, freq FROM bigrams WHERE word1 = ? ORDER BY freq DESC LIMIT 10"
        if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
            sqlite3_bind_text(stmt, 1, (lastWord as NSString).utf8String, -1, nil)
            while sqlite3_step(stmt) == SQLITE_ROW {
                if let c = sqlite3_column_text(stmt, 0) {
                    results.append(String(cString: c))
                }
            }
        }
        sqlite3_finalize(stmt)
        return results
    }

    // MARK: - User Dictionary (Learn from user selections)

    /// Record a user's word selection to boost it in future
    func learnWord(_ word: String, pinyin: String) {
        guard let db = db else { return }
        // Use a writable copy for user dict
        guard let writableDB = openWritableDB() else { return }
        var stmt: OpaquePointer?
        let sql = "INSERT INTO user_dict (word, pinyin, freq) VALUES (?, ?, 1) ON CONFLICT(word) DO UPDATE SET freq = freq + 1"
        if sqlite3_prepare_v2(writableDB, sql, -1, &stmt, nil) == SQLITE_OK {
            sqlite3_bind_text(stmt, 1, (word as NSString).utf8String, -1, nil)
            sqlite3_bind_text(stmt, 2, (pinyin as NSString).utf8String, -1, nil)
            sqlite3_step(stmt)
        }
        sqlite3_finalize(stmt)
        sqlite3_close(writableDB)
    }

    private func queryUserDict(pinyin: String) -> [String] {
        // User dict is stored in app group shared container
        guard let writableDB = openWritableDB() else { return [] }
        var results: [String] = []
        var stmt: OpaquePointer?

        // Check if user_dict table exists
        let checkSQL = "SELECT name FROM sqlite_master WHERE type='table' AND name='user_dict'"
        if sqlite3_prepare_v2(writableDB, checkSQL, -1, &stmt, nil) == SQLITE_OK {
            if sqlite3_step(stmt) != SQLITE_ROW {
                sqlite3_finalize(stmt)
                sqlite3_close(writableDB)
                return []
            }
        }
        sqlite3_finalize(stmt)
        stmt = nil

        let sql = "SELECT word FROM user_dict WHERE pinyin = ? ORDER BY freq DESC LIMIT 5"
        if sqlite3_prepare_v2(writableDB, sql, -1, &stmt, nil) == SQLITE_OK {
            sqlite3_bind_text(stmt, 1, (pinyin as NSString).utf8String, -1, nil)
            while sqlite3_step(stmt) == SQLITE_ROW {
                if let c = sqlite3_column_text(stmt, 0) {
                    results.append(String(cString: c))
                }
            }
        }
        sqlite3_finalize(stmt)
        sqlite3_close(writableDB)
        return results
    }

    private func openWritableDB() -> OpaquePointer? {
        guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.com.terseai.shared") else { return nil }
        let path = container.appendingPathComponent("user_pinyin.db").path
        var wdb: OpaquePointer?
        if sqlite3_open(path, &wdb) == SQLITE_OK {
            sqlite3_exec(wdb, "CREATE TABLE IF NOT EXISTS user_dict (word TEXT PRIMARY KEY, pinyin TEXT, freq INTEGER DEFAULT 1)", nil, nil, nil)
            sqlite3_exec(wdb, "CREATE INDEX IF NOT EXISTS idx_ud ON user_dict(pinyin)", nil, nil, nil)
            return wdb
        }
        return nil
    }

    // MARK: - Sentence Composition (DAG-based Optimal Segmentation)
    // Uses Directed Acyclic Graph + Viterbi-style optimal path with frequency weighting
    // Same algorithm family as jieba, Sogou Pinyin, Google Pinyin

    /// Compose optimal sentence from continuous pinyin using DAG shortest path
    private func composeSentence(from input: String) -> String {
        let syllables = splitPinyin(input)
        guard syllables.count >= 2 else { return "" }
        let n = syllables.count

        // Build DAG: for each position i, find all possible word matches ending at j
        // Edge (i, j) = word spanning syllables[i..<j] with its frequency score
        struct Edge {
            let word: String
            let endIdx: Int
            let score: Double
        }

        var dag: [[Edge]] = Array(repeating: [], count: n)

        for i in 0..<n {
            for len in 1...min(5, n - i) {
                let combined = syllables[i..<(i+len)].joined()
                let matches = queryWords(pinyin: combined, exact: true, limit: 3)
                for (word, freq) in matches {
                    // Score: log(freq) + bonus for multi-char words (prefer phrases)
                    let score = log(max(freq, 1.0)) + Double(len - 1) * 2.0
                    dag[i].append(Edge(word: word, endIdx: i + len, score: score))
                }
            }
            // If no match for single syllable, add unknown character fallback
            if dag[i].isEmpty || !dag[i].contains(where: { $0.endIdx == i + 1 }) {
                let chars = queryWords(pinyin: syllables[i], exact: true, limit: 1)
                let fallback = chars.first?.0 ?? syllables[i]
                dag[i].append(Edge(word: fallback, endIdx: i + 1, score: 0))
            }
        }

        // Viterbi: find optimal path through DAG (highest total score)
        var bestScore = Array(repeating: -Double.infinity, count: n + 1)
        var bestPrev = Array(repeating: -1, count: n + 1)
        var bestWord = Array(repeating: "", count: n + 1)
        bestScore[0] = 0

        for i in 0..<n {
            guard bestScore[i] > -Double.infinity else { continue }
            for edge in dag[i] {
                let newScore = bestScore[i] + edge.score
                if newScore > bestScore[edge.endIdx] {
                    bestScore[edge.endIdx] = newScore
                    bestPrev[edge.endIdx] = i
                    bestWord[edge.endIdx] = edge.word
                }
            }
        }

        // Reconstruct path
        guard bestScore[n] > -Double.infinity else { return "" }
        var path: [String] = []
        var pos = n
        while pos > 0 {
            path.insert(bestWord[pos], at: 0)
            pos = bestPrev[pos]
        }

        return path.joined()
    }

    /// Alternative: generate multiple sentence candidates with different segmentations
    private func composeSentenceAlt(from input: String) -> String {
        let syllables = splitPinyin(input)
        guard syllables.count >= 2 else { return "" }

        // Try a different strategy: prefer 2-char words (most common phrase length)
        var result = ""
        var i = 0
        while i < syllables.count {
            var found = false
            // Try 2-syllable combinations first
            if i + 1 < syllables.count {
                let combined = syllables[i] + syllables[i+1]
                let matches = queryWords(pinyin: combined, exact: true, limit: 1)
                if let first = matches.first {
                    result += first.0
                    i += 2
                    found = true
                }
            }
            if !found {
                let chars = queryWords(pinyin: syllables[i], exact: true, limit: 1)
                result += chars.first?.0 ?? syllables[i]
                i += 1
            }
        }
        return result
    }

    // MARK: - Database Query

    private func queryWords(pinyin: String, exact: Bool, limit: Int) -> [(String, Double)] {
        // Check cache first
        let cacheKey = "\(exact ? "=" : "~")\(pinyin)"
        if let cached = wordCache[cacheKey] { return cached }

        guard let db = db else { return [] }
        var results: [(String, Double)] = []
        var stmt: OpaquePointer?

        let sql = exact
            ? "SELECT simplified, frequency FROM entries WHERE pinyin_search = ? ORDER BY frequency DESC LIMIT ?"
            : "SELECT simplified, frequency FROM entries WHERE pinyin_search LIKE ? ORDER BY frequency DESC LIMIT ?"
        let param = exact ? pinyin : "\(pinyin)%"

        if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
            sqlite3_bind_text(stmt, 1, (param as NSString).utf8String, -1, nil)
            sqlite3_bind_int(stmt, 2, Int32(limit))
            while sqlite3_step(stmt) == SQLITE_ROW {
                if let c = sqlite3_column_text(stmt, 0) {
                    let word = String(cString: c)
                    let freq = sqlite3_column_double(stmt, 1)
                    results.append((word, freq))
                }
            }
        }
        sqlite3_finalize(stmt)

        // Cache results (limit cache size)
        if wordCache.count < 5000 {
            wordCache[cacheKey] = results
        }
        return results
    }

    // MARK: - Abbreviated Pinyin (首字母输入)
    // Handles "nhpl" → treat each consonant as initial of a syllable
    // n→你/那/能, h→好/很/会, p→漂/跑/朋, l→亮/了/来

    /// All valid pinyin initials (声母)
    private static let pinyinInitials: Set<Character> = Set("bpmfdtnlgkhjqxzcsryw")

    private func lookupAbbreviatedPinyin(_ input: String) -> [String] {
        guard let db = db else { return [] }
        let chars = Array(input.lowercased())

        // Check if this looks like abbreviated pinyin (mostly single consonants)
        let isAbbrev = chars.allSatisfy { Self.pinyinInitials.contains($0) || "aeiou".contains($0) }
        guard isAbbrev && chars.count >= 2 else { return [] }

        // Build SQL LIKE pattern: "nhpl" → "n%h%p%l%"
        let likePattern = chars.map { "\($0)%" }.joined()

        var results: [String] = []
        var stmt: OpaquePointer?
        // Search for phrases whose pinyin matches the abbreviation pattern
        let sql = "SELECT simplified, frequency FROM entries WHERE pinyin_search LIKE ? AND char_count = ? ORDER BY frequency DESC LIMIT 15"

        if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
            sqlite3_bind_text(stmt, 1, (likePattern as NSString).utf8String, -1, nil)
            sqlite3_bind_int(stmt, 2, Int32(chars.count))
            while sqlite3_step(stmt) == SQLITE_ROW {
                if let c = sqlite3_column_text(stmt, 0) {
                    results.append(String(cString: c))
                }
            }
        }
        sqlite3_finalize(stmt)

        // Also try without char_count constraint for longer phrases
        if results.count < 5 {
            if sqlite3_prepare_v2(db, "SELECT simplified, frequency FROM entries WHERE pinyin_search LIKE ? ORDER BY frequency DESC LIMIT 10", -1, &stmt, nil) == SQLITE_OK {
                sqlite3_bind_text(stmt, 1, (likePattern as NSString).utf8String, -1, nil)
                while sqlite3_step(stmt) == SQLITE_ROW {
                    if let c = sqlite3_column_text(stmt, 0) {
                        let word = String(cString: c)
                        if !results.contains(word) { results.append(word) }
                    }
                }
            }
            sqlite3_finalize(stmt)
        }

        return results
    }

    // MARK: - Partial Sentence Completion
    // Handles "nihaopiaol" → find "nihaopiaoliang" → 你好漂亮

    private func lookupPartialSentence(_ input: String) -> [String] {
        guard let db = db else { return [] }
        let py = input.lowercased()

        // Try splitting what we can, leaving trailing partial
        let syllables = splitPinyin(py)
        let matchedLen = syllables.joined().count

        if matchedLen < py.count && matchedLen > 0 {
            // There's a trailing partial: e.g., "nihaopiaol" → syllables=["ni","hao","piao"] + trailing "l"
            let trailing = String(py.suffix(py.count - matchedLen))

            // Build the sentence from matched syllables
            let matchedSentence = composeSentence(from: syllables.joined())

            // Search for words starting with the trailing partial
            var stmt: OpaquePointer?
            let sql = "SELECT simplified, frequency FROM entries WHERE pinyin_search LIKE ? AND char_count <= 3 ORDER BY frequency DESC LIMIT 10"
            let trailingPattern = "\(trailing)%"

            var completions: [String] = []
            if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
                sqlite3_bind_text(stmt, 1, (trailingPattern as NSString).utf8String, -1, nil)
                while sqlite3_step(stmt) == SQLITE_ROW {
                    if let c = sqlite3_column_text(stmt, 0) {
                        completions.append(String(cString: c))
                    }
                }
            }
            sqlite3_finalize(stmt)

            // Combine matched sentence + completions
            var results: [String] = []
            if !matchedSentence.isEmpty {
                for comp in completions.prefix(5) {
                    results.append(matchedSentence + comp)
                }
            }
            return results
        }

        // Also try prefix match on full pinyin (e.g., "nihaopiaoliang" starts with "nihaopiaol")
        var stmt: OpaquePointer?
        var results: [String] = []
        let sql = "SELECT simplified, frequency FROM entries WHERE pinyin_search LIKE ? ORDER BY frequency DESC LIMIT 10"
        if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
            sqlite3_bind_text(stmt, 1, ("\(py)%" as NSString).utf8String, -1, nil)
            while sqlite3_step(stmt) == SQLITE_ROW {
                if let c = sqlite3_column_text(stmt, 0) {
                    results.append(String(cString: c))
                }
            }
        }
        sqlite3_finalize(stmt)

        return results
    }

    // MARK: - Fuzzy Pinyin (模糊拼音)
    // Handles common pronunciation confusion pairs

    private static let fuzzyPairs: [(String, String)] = [
        ("zh", "z"), ("ch", "c"), ("sh", "s"),   // 平翘舌
        ("z", "zh"), ("c", "ch"), ("s", "sh"),
        ("n", "l"), ("l", "n"),                   // n/l 混淆
        ("ang", "an"), ("an", "ang"),             // 前后鼻音
        ("eng", "en"), ("en", "eng"),
        ("ing", "in"), ("in", "ing"),
        ("ong", "on"), ("on", "ong"),
        ("h", "f"), ("f", "h"),                   // h/f 混淆
    ]

    /// Generate fuzzy variants of a pinyin string
    private func fuzzyVariants(_ pinyin: String) -> [String] {
        var variants: [String] = []
        let py = pinyin.lowercased()
        for (from, to) in Self.fuzzyPairs {
            if py.contains(from) {
                variants.append(py.replacingOccurrences(of: from, with: to))
            }
        }
        return variants
    }

    // MARK: - QWERTY Adjacent Key Typo Correction
    // "m" and "n" are adjacent → "wohaoxiangmi" also matches "wohaoxiangni"

    private static let adjacentKeys: [Character: [Character]] = [
        "q": ["w","a"],           "w": ["q","e","a","s"],     "e": ["w","r","s","d"],
        "r": ["e","t","d","f"],   "t": ["r","y","f","g"],     "y": ["t","u","g","h"],
        "u": ["y","i","h","j"],   "i": ["u","o","j","k"],     "o": ["i","p","k","l"],
        "p": ["o","l"],
        "a": ["q","w","s","z"],   "s": ["a","w","e","d","z","x"],
        "d": ["s","e","r","f","x","c"], "f": ["d","r","t","g","c","v"],
        "g": ["f","t","y","h","v","b"], "h": ["g","y","u","j","b","n"],
        "j": ["h","u","i","k","n","m"], "k": ["j","i","o","l","m"],
        "l": ["k","o","p"],
        "z": ["a","s","x"],       "x": ["z","s","d","c"],     "c": ["x","d","f","v"],
        "v": ["c","f","g","b"],   "b": ["v","g","h","n"],     "n": ["b","h","j","m"],
        "m": ["n","j","k"],
    ]

    /// Generate typo variants by replacing each character with adjacent keys
    private func typoVariants(_ pinyin: String) -> [String] {
        let chars = Array(pinyin.lowercased())
        var variants: [String] = []

        // For each position, try replacing with adjacent keys
        for i in 0..<chars.count {
            guard let adjacent = Self.adjacentKeys[chars[i]] else { continue }
            for adj in adjacent {
                var newChars = chars
                newChars[i] = adj
                let variant = String(newChars)
                if variant != pinyin {
                    variants.append(variant)
                }
            }
        }

        // Also try swapping adjacent characters (transposition typo)
        for i in 0..<(chars.count - 1) {
            var newChars = chars
            newChars.swapAt(i, i + 1)
            let variant = String(newChars)
            if variant != pinyin {
                variants.append(variant)
            }
        }

        return variants
    }

    // MARK: - English Detection

    private static let commonEnglish: Set<String> = [
        "the", "is", "are", "was", "and", "or", "but", "not", "yes", "no",
        "ok", "hi", "hello", "bye", "thanks", "sorry", "please", "what",
        "how", "why", "when", "where", "who", "can", "will", "would",
        "do", "does", "did", "have", "has", "had", "get", "got",
        "go", "come", "see", "know", "think", "want", "need", "like",
        "good", "bad", "big", "small", "new", "old", "help", "love",
        "test", "app", "email", "phone", "time", "day", "work", "home",
    ]

    private func isLikelyEnglish(_ text: String) -> Bool {
        let lower = text.lowercased()
        if Self.commonEnglish.contains(lower) { return true }
        // Don't flag as English if it could be abbreviated pinyin (all consonants)
        let chars = Array(lower)
        if chars.allSatisfy({ Self.pinyinInitials.contains($0) || "aeiou".contains($0) }) {
            return false
        }
        // If no valid pinyin syllable matches, likely English
        if longestMatchingSyllable(lower) == nil && lower.count >= 3 { return true }
        return false
    }

    // MARK: - Pinyin Splitting

    private func longestMatchingSyllable(_ input: String) -> String? {
        let chars = Array(input)
        for len in stride(from: min(chars.count, 6), through: 1, by: -1) {
            let candidate = String(chars[0..<len])
            if validSyllables.contains(candidate) { return candidate }
        }
        return nil
    }

    /// Split continuous pinyin into valid syllables using dynamic programming
    /// e.g., "wohenkaixin" → ["wo", "hen", "kai", "xin"]
    func splitPinyin(_ input: String) -> [String] {
        let str = input.lowercased()
        let n = str.count
        guard n >= 2 else {
            return validSyllables.contains(str) ? [str] : []
        }
        let chars = Array(str)

        // DP: dp[i] = best previous split point (-1 = unreachable)
        // Prefer longer syllables (fewer splits = better)
        var dp = Array(repeating: -1, count: n + 1)
        var dpLen = Array(repeating: 0, count: n + 1) // track syllable length used
        dp[0] = 0

        for i in 0..<n {
            guard dp[i] >= 0 else { continue }
            for len in stride(from: min(6, n - i), through: 1, by: -1) {
                let syllable = String(chars[i..<(i+len)])
                if validSyllables.contains(syllable) {
                    // Prefer longer syllables
                    if dp[i + len] < 0 || len > dpLen[i + len] {
                        dp[i + len] = i
                        dpLen[i + len] = len
                    }
                }
            }
        }

        guard dp[n] >= 0 else { return [] }
        var result: [String] = []
        var pos = n
        while pos > 0 {
            let prev = dp[pos]
            result.insert(String(chars[prev..<pos]), at: 0)
            pos = prev
        }
        return result
    }
}
