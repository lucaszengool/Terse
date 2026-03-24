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

        // 2. Sentence composition via Forward Maximum Matching
        let sentence = composeSentence(from: py)
        if !sentence.isEmpty && !seen.contains(sentence) {
            results.insert(seen.isEmpty ? sentence : sentence, at: min(1, results.count))
            seen.insert(sentence)
        }

        // 3. Alternative sentence compositions (shorter words)
        let altSentence = composeSentenceAlt(from: py)
        if !altSentence.isEmpty && !seen.contains(altSentence) {
            results.append(altSentence); seen.insert(altSentence)
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

        return results
    }

    // MARK: - Sentence Composition (Forward Maximum Matching)

    /// Compose a full sentence from continuous pinyin using longest-word-first matching
    /// e.g., "wohenkaixin" → "我很开心"
    private func composeSentence(from input: String) -> String {
        let syllables = splitPinyin(input)
        guard syllables.count >= 2 else { return "" }

        // Try to greedily match longest phrases first
        var result = ""
        var i = 0

        while i < syllables.count {
            var bestWord = ""
            var bestLen = 0

            // Try matching 4, 3, 2, 1 syllables (longest first)
            for len in stride(from: min(4, syllables.count - i), through: 1, by: -1) {
                let combined = syllables[i..<(i+len)].joined()
                let matches = queryWords(pinyin: combined, exact: true, limit: 1)
                if let first = matches.first {
                    bestWord = first.0
                    bestLen = len
                    break
                }
            }

            if bestLen > 0 {
                result += bestWord
                i += bestLen
            } else {
                // No match — use first character of the syllable
                let chars = queryWords(pinyin: syllables[i], exact: true, limit: 1)
                result += chars.first?.0 ?? syllables[i]
                i += 1
            }
        }

        return result
    }

    /// Alternative composition: prefer 2-char words (common in Chinese)
    private func composeSentenceAlt(from input: String) -> String {
        let syllables = splitPinyin(input)
        guard syllables.count >= 2 else { return "" }

        var result = ""
        var i = 0

        while i < syllables.count {
            // Try 2-syllable words first (most common phrase length)
            if i + 1 < syllables.count {
                let combined = syllables[i] + syllables[i+1]
                let matches = queryWords(pinyin: combined, exact: true, limit: 1)
                if let first = matches.first, first.0.count == 2 {
                    result += first.0
                    i += 2
                    continue
                }
            }
            // Fall back to single char
            let chars = queryWords(pinyin: syllables[i], exact: true, limit: 1)
            if let first = chars.first, first.0.count == 1 {
                result += first.0
            }
            i += 1
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
