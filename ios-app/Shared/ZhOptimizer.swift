import Foundation
import SQLite3

/// Database-driven Chinese text token optimizer
/// Uses: goto456 stopwords (2,404), Chinese-Synonyms (60K+ pairs),
/// Chatopera word frequency (230K+), curated phrase shortenings
class ZhOptimizer {
    static let shared = ZhOptimizer()

    private var db: OpaquePointer?
    private var stopwords: Set<String> = []
    private var shortenings: [(String, String)] = []

    private init() {
        openDB()
        loadStopwords()
        loadShortenings()
    }

    deinit { if db != nil { sqlite3_close(db) } }

    private func openDB() {
        // Try keyboard bundle first, then main app bundle
        let paths = [
            Bundle.main.path(forResource: "zh_optimize", ofType: "db"),
        ].compactMap { $0 }
        for path in paths {
            if sqlite3_open_v2(path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK { return }
        }
        db = nil
    }

    private func loadStopwords() {
        guard let db = db else { return }
        var stmt: OpaquePointer?
        if sqlite3_prepare_v2(db, "SELECT word FROM stopwords", -1, &stmt, nil) == SQLITE_OK {
            while sqlite3_step(stmt) == SQLITE_ROW {
                if let c = sqlite3_column_text(stmt, 0) {
                    stopwords.insert(String(cString: c))
                }
            }
        }
        sqlite3_finalize(stmt)
    }

    private func loadShortenings() {
        guard let db = db else { return }
        var stmt: OpaquePointer?
        if sqlite3_prepare_v2(db, "SELECT verbose, concise FROM shortenings", -1, &stmt, nil) == SQLITE_OK {
            while sqlite3_step(stmt) == SQLITE_ROW {
                if let v = sqlite3_column_text(stmt, 0), let c = sqlite3_column_text(stmt, 1) {
                    shortenings.append((String(cString: v), String(cString: c)))
                }
            }
        }
        sqlite3_finalize(stmt)
    }

    // MARK: - Main Optimize

    /// Apply all Chinese token reduction techniques
    func optimize(_ text: String, aggressiveness: String) -> String {
        guard db != nil else { return text }
        var result = text

        // 1. Apply phrase shortenings (进行研究→研究, etc.)
        result = applyShortenings(result)

        // 2. Remove modal particles at sentence ends (啊呢吧嘛啦哦)
        result = removeModalParticles(result)

        // 3. Compress redundant punctuation
        result = compressPunctuation(result)

        // 4. Remove trailing ellipsis
        result = removeTrailingEllipsis(result)

        if aggressiveness == "balanced" || aggressiveness == "aggressive" {
            // 5. Replace words with shorter synonyms
            result = applySynonymReplacement(result)

            // 6. Remove redundant 的 between common adjective-noun pairs
            result = removeRedundantDe(result)
        }

        if aggressiveness == "aggressive" {
            // 7. Remove stopwords that don't change meaning
            result = removeContextualStopwords(result)
        }

        // 8. Compress whitespace
        result = result.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)

        return result
    }

    // MARK: - Technique 1: Phrase Shortenings

    private func applyShortenings(_ text: String) -> String {
        var result = text
        for (verbose, concise) in shortenings {
            result = result.replacingOccurrences(of: verbose, with: concise)
        }
        return result
    }

    // MARK: - Technique 2: Modal Particle Removal

    private func removeModalParticles(_ text: String) -> String {
        // Remove sentence-ending particles that add tone but not meaning
        // Keep them if they're the only character (standalone response like "嗯" or "啊")
        guard let regex = try? NSRegularExpression(
            pattern: "(?<=[\\x{4e00}-\\x{9fff}])[啊呀哇哦哎嘛啦哈嘿噢嘻哟呐](?=[,，。！？!?\\s]|$)",
            options: []
        ) else { return text }
        let range = NSRange(text.startIndex..., in: text)
        return regex.stringByReplacingMatches(in: text, range: range, withTemplate: "")
    }

    // MARK: - Technique 3: Punctuation Compression

    private func compressPunctuation(_ text: String) -> String {
        var result = text
        // Repeated punctuation → single
        if let regex = try? NSRegularExpression(pattern: "([。！？!?，,]){2,}") {
            result = regex.stringByReplacingMatches(in: result, range: NSRange(result.startIndex..., in: result), withTemplate: "$1")
        }
        return result
    }

    // MARK: - Technique 4: Trailing Ellipsis

    private func removeTrailingEllipsis(_ text: String) -> String {
        if let regex = try? NSRegularExpression(pattern: "[…\\.]{3,}\\s*$", options: .anchorsMatchLines) {
            return regex.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: "")
        }
        return text
    }

    // MARK: - Technique 5: Synonym Replacement (shorter synonym)

    private func applySynonymReplacement(_ text: String) -> String {
        guard let db = db else { return text }
        var result = text

        // Segment text into words (simple: scan for 2-4 char sequences)
        // Try replacing longer words with shorter synonyms
        var stmt: OpaquePointer?
        let sql = """
            SELECT s.synonym FROM synonyms s
            JOIN word_freq wf ON s.synonym = wf.word
            WHERE s.word = ? AND length(s.synonym) < length(s.word)
            ORDER BY wf.freq DESC LIMIT 1
        """

        // Find all 2-4 character Chinese substrings and try to shorten
        let chars = Array(text)
        var replacements: [(Range<String.Index>, String)] = []

        for wordLen in stride(from: 4, through: 2, by: -1) {
            var i = 0
            while i + wordLen <= chars.count {
                let startIdx = text.index(text.startIndex, offsetBy: i)
                let endIdx = text.index(text.startIndex, offsetBy: i + wordLen)
                let word = String(text[startIdx..<endIdx])

                // Only process Chinese words
                guard word.unicodeScalars.allSatisfy({ (0x4e00...0x9fff).contains($0.value) }) else {
                    i += 1; continue
                }

                if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
                    sqlite3_bind_text(stmt, 1, (word as NSString).utf8String, -1, nil)
                    if sqlite3_step(stmt) == SQLITE_ROW, let c = sqlite3_column_text(stmt, 0) {
                        let shorter = String(cString: c)
                        if shorter.count < word.count && shorter.count >= 1 {
                            result = result.replacingOccurrences(of: word, with: shorter)
                        }
                    }
                }
                sqlite3_finalize(stmt)
                stmt = nil
                i += wordLen
            }
        }

        return result
    }

    // MARK: - Technique 6: Redundant 的 Removal

    private func removeRedundantDe(_ text: String) -> String {
        // Pattern: common adjective + 的 + noun → adjective + noun
        // Only for known safe pairs (adjectives where 的 is optional)
        let adjectives = ["好","大","小","新","旧","快","慢","高","低","长","短",
                          "多","少","重要","简单","具体","主要","基本","特殊","一般","正常"]
        var result = text
        for adj in adjectives {
            // Only remove 的 when followed by a Chinese character (noun)
            if let regex = try? NSRegularExpression(pattern: "\(adj)的(?=[\\x{4e00}-\\x{9fff}])") {
                result = regex.stringByReplacingMatches(in: result, range: NSRange(result.startIndex..., in: result), withTemplate: adj)
            }
        }
        return result
    }

    // MARK: - Technique 7: Contextual Stopword Removal (aggressive only)

    private func removeContextualStopwords(_ text: String) -> String {
        // Only remove stopwords that are clearly filler (not structural)
        let removable: Set<String> = ["的话","一下","一些","一点","这个","那个","这些","那些",
                                       "什么的","之类的","等等","诸如此类"]
        var result = text
        for word in removable {
            result = result.replacingOccurrences(of: word, with: "")
        }
        return result
    }
}
