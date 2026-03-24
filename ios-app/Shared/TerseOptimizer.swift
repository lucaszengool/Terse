import Foundation

// MARK: - Result Types

struct OptimizationResult {
    let optimized: String
    let stats: OptimizationStats
    let suggestions: [Suggestion]
}

struct OptimizationStats {
    let originalChars: Int
    let optimizedChars: Int
    let originalTokens: Int
    let optimizedTokens: Int
    let tokensSaved: Int
    let percentSaved: Int
    let techniquesApplied: [String]
}

struct Suggestion {
    let type: String
    let text: String
}

// MARK: - Typo Dictionaries

private let SPLIT_TYPOS: [(String, String)] = [
    ("int he", "in the"), ("th e", "the"), ("wit h", "with"), ("fro m", "from"),
    ("som e", "some"), ("hav e", "have"), ("whe n", "when"), ("the n", "then"),
    ("the y", "they"), ("the re", "there"), ("the ir", "their"), ("whe re", "where"),
    ("sho w", "show"), ("sho uld", "should"), ("cou ld", "could"), ("wou ld", "would"),
]

private let TYPOS: [String: String] = [
    "teh": "the", "hte": "the", "thn": "then", "thne": "then",
    "thier": "their", "theri": "their", "taht": "that", "htat": "that",
    "thta": "that", "tath": "that", "tha": "that", "thsi": "this",
    "tihs": "this", "htis": "this", "thsoe": "those", "thsee": "these",
    "adn": "and", "nad": "and", "anf": "and", "andd": "and",
    "aer": "are", "rae": "are", "wsa": "was",
    "wwant": "want", "wan": "want", "wnat": "want", "watn": "want",
    "wnt": "want", "wanr": "want", "wantd": "wanted", "wnet": "went",
    "wetn": "went", "wiht": "with", "wtih": "with", "iwth": "with",
    "wih": "with", "whit": "with", "witht": "with", "waht": "what",
    "whta": "what", "wath": "what", "hwat": "what", "wehn": "when",
    "whne": "when", "whn": "when", "wehre": "where", "wheer": "where",
    "wher": "where", "whcih": "which", "wich": "which", "whihc": "which",
    "whch": "which", "whlei": "while", "whiel": "while",
    "woudl": "would", "wuold": "would", "woud": "would", "wouldd": "would",
    "shoudl": "should", "shuold": "should", "shoud": "should", "shold": "should",
    "coudl": "could", "cuold": "could", "coud": "could", "cld": "could",
    "hav": "have", "ahve": "have", "hvae": "have", "haev": "have",
    "hsa": "has", "ahs": "has",
    "buil": "build", "biuld": "build", "buidl": "build", "bulid": "build",
    "buld": "build", "bulit": "built", "bilt": "built",
    "becuase": "because", "becasue": "because", "beacuse": "because",
    "becouse": "because", "becuz": "because", "becuse": "because", "becaues": "because",
    "definately": "definitely", "definatly": "definitely", "definetly": "definitely",
    "defintely": "definitely", "defintiely": "definitely",
    "recieve": "receive", "recevie": "receive", "receiev": "receive",
    "acheive": "achieve", "achive": "achieve", "acheiv": "achieve",
    "occured": "occurred", "occurence": "occurrence", "occurance": "occurrence",
    "seperate": "separate", "seperately": "separately", "sepreate": "separate",
    "neccessary": "necessary", "neccesary": "necessary", "necessery": "necessary", "necesary": "necessary",
    "accomodate": "accommodate", "apparantly": "apparently", "apparenly": "apparently",
    "calender": "calendar", "commited": "committed", "comitted": "committed",
    "concious": "conscious", "enviroment": "environment", "enviorment": "environment",
    "goverment": "government", "governmnet": "government",
    "immediatly": "immediately", "immediatlely": "immediately", "immeadiately": "immediately",
    "independant": "independent", "knowlege": "knowledge", "knowledeg": "knowledge",
    "manualy": "manually", "noticable": "noticeable", "occassion": "occasion",
    "persistant": "persistent", "postion": "position", "positon": "position",
    "possibilty": "possibility", "prefered": "preferred", "privledge": "privilege",
    "proffesional": "professional", "profesional": "professional", "publically": "publicly",
    "recomend": "recommend", "recomendation": "recommendation", "recommed": "recommend",
    "refering": "referring", "relevent": "relevant", "relavant": "relevant",
    "reponse": "response", "resposne": "response", "responsne": "response", "responce": "response",
    "succesful": "successful", "successfull": "successful", "sucess": "success", "succes": "success",
    "suprise": "surprise", "surprize": "surprise",
    "tecnology": "technology", "technoogy": "technology",
    "tommorow": "tomorrow", "tomorow": "tomorrow",
    "togehter": "together", "togather": "together",
    "untill": "until", "unitl": "until",
    "usally": "usually", "ususally": "usually", "usaully": "usually",
    "wierd": "weird", "writting": "writing", "writeing": "writing",
    "wirte": "write", "wrtie": "write",
    "pleae": "please", "pleas": "please", "plesae": "please", "plese": "please",
    "pelase": "please", "pealse": "please",
    "anser": "answer", "answr": "answer", "anwser": "answer", "awner": "answer",
    "abot": "about", "abut": "about", "wuld": "would", "wud": "would",
    "qick": "quick", "quik": "quick", "quck": "quick",
    "yuo": "you", "yoru": "your", "yuor": "your", "yur": "your",
    "fo": "of", "ot": "to", "si": "is", "ti": "it", "ni": "in", "os": "so",
    "nto": "not", "ont": "not", "cna": "can", "cane": "can",
    "jsut": "just", "juts": "just", "jst": "just",
    "liek": "like", "lkie": "like", "likee": "like",
    "knwo": "know", "konw": "know", "nkow": "know",
    "amke": "make", "mkae": "make", "maek": "make",
    "tkae": "take", "teka": "take",
    "godo": "good", "goood": "good", "nwe": "new", "enw": "new",
    "owrk": "work", "wokr": "work", "wrk": "work",
    "tiem": "time", "tmie": "time", "itme": "time",
    "sued": "used", "uesd": "used",
    "alos": "also", "aslo": "also", "evne": "even", "eevn": "even",
    "onyl": "only", "olny": "only", "veyr": "very", "vrey": "very",
    "somthing": "something", "soemthing": "something", "somethign": "something",
    "eveything": "everything", "evreything": "everything", "everythign": "everything",
    "anythign": "anything", "anythin": "anything",
    "abuot": "about", "abotu": "about", "baout": "about",
    "agian": "again", "agin": "again",
    "alraedy": "already", "alredy": "already", "alreayd": "already",
    "alrayd": "already", "alrady": "already",
    "alwyas": "always", "alwasy": "always", "alaways": "always",
    "befoer": "before", "befroe": "before", "beign": "being", "bieng": "being",
]

private let FILLER_WORDS: Set<String> = [
    "i", "me", "my", "you", "your", "we", "our", "it", "its", "the", "a", "an",
    "is", "am", "are", "was", "were", "be", "been", "being",
    "do", "does", "did", "have", "has", "had", "will", "would", "could", "should",
    "can", "may", "might", "to", "of", "in", "for", "on", "with", "at", "by",
    "from", "up", "out", "so", "and", "but", "or", "if", "that", "this",
    "just", "also", "very", "really", "much", "well", "still", "too",
    "here", "there", "then", "now", "want", "need", "know", "think", "like",
    "get", "go", "come", "make", "take", "see", "look", "give", "tell", "say",
    "try", "help", "let", "please", "about", "what", "how", "when", "where",
    "who", "why", "which", "not", "no", "any", "some", "all",
]

// MARK: - TerseOptimizer

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

    func optimize(_ text: String) -> OptimizationResult {
        let originalTokens = estimateTokens(text)
        let wordCount = text.trimmingCharacters(in: .whitespacesAndNewlines).split(whereSeparator: { $0.isWhitespace }).count
        if wordCount < 3 {
            let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
            return OptimizationResult(optimized: t, stats: OptimizationStats(originalChars: text.count, optimizedChars: t.count, originalTokens: originalTokens, optimizedTokens: estimateTokens(t), tokensSaved: 0, percentSaved: 0, techniquesApplied: []), suggestions: genSuggestions(text, []))
        }

        var o = text; var a: [String] = []; let lvl = aggressiveness

        // Detect language and apply multi-language optimization
        let lang = TerseMultiLang.detectLanguage(o)
        if lang != "en" && lvl != "light" {
            let b = o
            if removeFillerWords { o = TerseMultiLang.applyFillers(o, lang: lang) }
            if removePoliteness { o = TerseMultiLang.applyPoliteness(o, lang: lang) }
            if removeHedging { o = TerseMultiLang.applyHedging(o, lang: lang) }
            if removeMetaLanguage { o = TerseMultiLang.applyMeta(o, lang: lang) }
            if shortenPhrases { o = TerseMultiLang.applyShorten(o, lang: lang) }
            if o != b { a.append("Multi-lang optimization (\(lang))") }
        }

        // Chinese-specific: database-driven optimization (60K+ synonyms, 2K+ stopwords, 230K+ word freq)
        // ZhOptimizer is only available in keyboard extension (has SQLite DB bundled)
        // For main app, the regex-based TerseMultiLang patterns above handle Chinese

        if correctTypos { let b = o; o = correctTyposFn(o); if o != b { a.append("Corrected typos") } }
        if compressWhitespace { let b = o; o = rx(o, "\\n{3,}", "\n\n"); o = rx(o, "[ \\t]{2,}", " "); o = rx(o, "^\\s+$", "", [.anchorsMatchLines]); if o != b { a.append("Compressed whitespace") } }

        let (safe, blocks) = protectCode(o); o = safe

        if lvl == "light" { applyLight(&o, &a); capFirst(&o) }
        if lvl != "light" {
            applyBalanced(&o, &a)
            if removeRedundancy { let b = o; o = removeRedundantContent(o); if o != b { a.append("Removed redundancy") } }
            if deduplicateContent { let b = o; o = deduplicateSentences(o); if o != b { a.append("Deduplicated") } }
            let bc = o; o = deduplicateClauses(o); if o != bc { a.append("Merged similar clauses") }
            if compressLists { let b = o; o = rx(o, "^\\s*[-\u{2022}]\\s+", "- ", [.anchorsMatchLines]); o = rx(o, "^\\s*(\\d+)\\.\\s+", "$1. ", [.anchorsMatchLines]); if o != b { a.append("Compressed lists") } }
            if compressCodeBlocks { let b = o; o = compressCodeFn(o); if o != b { a.append("Compressed code") } }
            let bn = o; o = numeralize(o); if o != bn { a.append("Numeralized") }
            let bs = o; o = convertToStructured(o); if o != bs { a.append("Structured format") }
            let bk = o; o = contractFormal(o); if o != bk { a.append("Contracted") }
        }
        if lvl == "aggressive" { applyAggressive(&o, &a) }

        o = restoreCode(o, blocks: blocks); o = cleanup(o)
        let ot = estimateTokens(o); let saved = originalTokens - ot
        let pct = originalTokens > 0 ? Int(round(Double(saved) / Double(originalTokens) * 100)) : 0
        return OptimizationResult(optimized: o, stats: OptimizationStats(originalChars: text.count, optimizedChars: o.count, originalTokens: originalTokens, optimizedTokens: ot, tokensSaved: saved, percentSaved: pct, techniquesApplied: a), suggestions: genSuggestions(text, a))
    }

    func estimateTokens(_ text: String) -> Int {
        let w = text.split(whereSeparator: { $0.isWhitespace }).count
        let p = text.filter { !$0.isLetter && !$0.isNumber && !$0.isWhitespace }.count
        let cjk = text.unicodeScalars.filter { (0x3040...0x9FFF).contains($0.value) || (0xAC00...0xD7AF).contains($0.value) }.count
        if cjk > 0 { return Int(ceil(Double(cjk) * 1.5 + Double(w) * 1.3 + Double(p) * 0.5)) }
        return Int(ceil(Double(w) * 1.3 + Double(p) * 0.5))
    }

    // MARK: - Typo Correction
    private func correctTyposFn(_ text: String) -> String {
        var r = text
        for (bad, good) in SPLIT_TYPOS { r = rx(r, "\\b\(NSRegularExpression.escapedPattern(for: bad))\\b", good, [.caseInsensitive]) }
        return r.components(separatedBy: " ").map { word -> String in
            let stripped = word.lowercased().replacingOccurrences(of: "[^a-z]", with: "", options: .regularExpression)
            guard let fix = TYPOS[stripped] else { return word }
            let trailing = word.replacingOccurrences(of: "^[a-zA-Z]+", with: "", options: .regularExpression)
            return (word.first?.isUppercase == true ? fix.prefix(1).uppercased() + fix.dropFirst() : fix) + trailing
        }.joined(separator: " ")
    }

    // MARK: - Code Protection
    private func protectCode(_ text: String) -> (String, [String]) {
        var r = text; var blocks: [String] = []
        for pat in ["```[\\s\\S]*?```", "`[^`]+`", "https?://[^\\s]+"] {
            guard let regex = try? NSRegularExpression(pattern: pat) else { continue }
            let matches = regex.matches(in: r, range: NSRange(r.startIndex..., in: r))
            for m in matches.reversed() {
                if let range = Range(m.range, in: r) {
                    blocks.insert(String(r[range]), at: 0)
                    r.replaceSubrange(range, with: "\u{27E6}CODE\(blocks.count - 1)\u{27E7}")
                }
            }
        }
        return (r, blocks)
    }
    private func restoreCode(_ text: String, blocks: [String]) -> String {
        var r = text; for (i, b) in blocks.enumerated() { r = r.replacingOccurrences(of: "\u{27E6}CODE\(i)\u{27E7}", with: b) }; return r
    }

    // MARK: - Light
    private func applyLight(_ t: inout String, _ a: inout [String]) {
        var b = t; t = contractFormal(t); if t != b { a.append("Contracted") }
        b = t; t = rx(t, "\\bin order to\\b", "to", [.caseInsensitive]); if t != b { a.append("Shortened phrases") }
        b = t; t = rx(t, "^(hi|hello|hey)\\s*(there|assistant|AI|Claude|GPT|ChatGPT)?[,!.]?\\s*", "", [.caseInsensitive]); if t != b { a.append("Removed greeting") }
        b = t; t = rx(t, "\\b(thanks in advance|thank you in advance|thanks so much|thank you so much)\\b[^.!?\\n]*[.!?]?\\s*$", "", [.caseInsensitive, .anchorsMatchLines]); t = rx(t, "\\b(thanks!?|thank you!?)\\s*[.!]?\\s*$", "", [.caseInsensitive, .anchorsMatchLines]); if t != b { a.append("Removed closing thanks") }
        b = t; t = rx(t, "\\bI hope you('re| are) doing well\\s*(\\w+)?\\s*[.!]?\\s*", "", [.caseInsensitive]); if t != b { a.append("Removed fluff") }
        b = t; t = rx(t, "\\b(as a matter of fact|at the end of the day|for what it's worth|at this point in time)\\b[,]?\\s*", "", [.caseInsensitive]); if t != b { a.append("Removed filler phrases") }
    }

    // MARK: - Balanced
    private func applyBalanced(_ t: inout String, _ a: inout [String]) {
        // Detect language for multi-language optimization
        let lang = TerseMultiLang.detectLanguage(t)

        var b = t; t = removeSelfCtx(t); if t != b { a.append("Removed self-context") }

        // English NLP
        if removePoliteness { b = t; t = removePolite(t); if t != b { a.append("Removed politeness") } }
        b = t; t = q2imp(t); if t != b { a.append("Converted to imperative") }
        if removeFillerWords { b = t; t = rmFillers(t); if t != b { a.append("Removed filler words") } }
        if removeHedging { b = t; t = rmHedge(t); if t != b { a.append("Removed hedging") } }
        if removeMetaLanguage { b = t; t = rmMeta(t); if t != b { a.append("Removed meta-language") } }
        if shortenPhrases { b = t; t = shorten(t); if t != b { a.append("Shortened phrases") } }
        if simplifyInstructions { b = t; t = simplify(t); if t != b { a.append("Simplified vocabulary") } }

        // Multi-language NLP (applies if non-English detected)
        if lang != "en" {
            if removeFillerWords { b = t; t = TerseMultiLang.applyFillers(t, lang: lang); if t != b { a.append("Removed \(lang) fillers") } }
            if removePoliteness { b = t; t = TerseMultiLang.applyPoliteness(t, lang: lang); if t != b { a.append("Removed \(lang) politeness") } }
            if removeHedging { b = t; t = TerseMultiLang.applyHedging(t, lang: lang); if t != b { a.append("Removed \(lang) hedging") } }
            if removeMetaLanguage { b = t; t = TerseMultiLang.applyMeta(t, lang: lang); if t != b { a.append("Removed \(lang) meta") } }
            if shortenPhrases { b = t; t = TerseMultiLang.applyShorten(t, lang: lang); if t != b { a.append("Shortened \(lang) phrases") } }
        }
    }

    // MARK: - Aggressive
    private func applyAggressive(_ t: inout String, _ a: inout [String]) {
        if useAbbreviations { var b = t; t = abbrev(t); if t != b { a.append("Abbreviated terms") } }
        var b = t; t = stripMd(t); if t != b { a.append("Stripped formatting") }
        b = t; t = rmArticles(t); if t != b { a.append("Removed articles") }
        b = t; t = telegraph(t); if t != b { a.append("Telegraph compressed") }
        b = t; t = consolidateQ(t); if t != b { a.append("Consolidated questions") }
        b = t; t = dropLowInfo(t); if t != b { a.append("Dropped low-info") }
    }

    // MARK: - Techniques
    private func contractFormal(_ t: String) -> String {
        var r = t
        for (p, rep) in [("\\bdo not\\b","don't"),("\\bcannot\\b","can't"),("\\bwill not\\b","won't"),("\\bis not\\b","isn't"),("\\bare not\\b","aren't"),("\\bwould not\\b","wouldn't"),("\\bshould not\\b","shouldn't"),("\\bcould not\\b","couldn't"),("\\bdoes not\\b","doesn't"),("\\bdid not\\b","didn't"),("\\bhas not\\b","hasn't"),("\\bhave not\\b","haven't"),("\\bit is\\b","it's"),("\\bthat is\\b","that's"),("\\bthere is\\b","there's")] as [(String,String)] { r = rx(r, p, rep, [.caseInsensitive]) }
        return r
    }
    private func removeSelfCtx(_ t: String) -> String {
        var r = t
        for p in ["\\bI'm (a|an) \\w+ (who|that|and|working|trying|looking)\\b[^.!?]*[.!?]?\\s*","\\bI('m| am) (currently |)(working on|trying to|attempting to|looking to|building|developing|creating)\\b","\\bI have (been|a) (\\w+ )?(experience|background|years)\\b[^.!?]*[.!?]?\\s*"] { r = rx(r, p, "", [.caseInsensitive]) }
        return r
    }
    private func removePolite(_ t: String) -> String {
        var r = t
        for p in ["\\bplease\\b[,]?\\s*","\\bcould you (please )?","\\bwould you (kindly |please )?","\\bI was wondering if\\b[^.!?]*","\\bif you don't mind\\b[,]?\\s*","\\bwould you be (so kind|able) (as )?to\\b","\\bI('d| would) (really )?appreciate (it )?if\\b","\\bsorry (to bother|to ask|for asking|if this is)\\b[^.!?]*[.!?]?\\s*"] { r = rx(r, p, "", [.caseInsensitive]) }
        return r
    }
    private func q2imp(_ t: String) -> String {
        var r = t
        r = rx(r, "\\b[Cc]an you (please )?(explain|show|tell|help|give|provide|list|describe|write|create)", "$2")
        r = rx(r, "\\b[Cc]ould you (please )?(explain|show|tell|help|give|provide|list|describe|write|create)", "$2")
        r = rx(r, "\\b[Ww]ould you (mind )?(explain|show|tell|help|give|provide|list|describe|write|create)(ing)?", "$2")
        return r
    }
    private func rmFillers(_ t: String) -> String {
        var r = t
        for p in ["\\bbasically\\b[,]?\\s*","\\bactually\\b[,]?\\s*","\\bjust\\b\\s+","\\breally\\b\\s+","\\bvery\\b\\s+","\\bquite\\b\\s+","\\bpretty much\\b[,]?\\s*","\\bkind of\\b\\s*","\\bsort of\\b\\s*","\\bhonestly\\b[,]?\\s*","\\bfrankly\\b[,]?\\s*","\\bliterally\\b[,]?\\s*","\\bessentially\\b[,]?\\s*","\\bobviously\\b[,]?\\s*","\\bclearly\\b[,]?\\s*"] { r = rx(r, p, "", [.caseInsensitive]) }
        return r
    }
    private func rmHedge(_ t: String) -> String {
        var r = t
        for p in ["\\bI (think|believe|guess|suppose|imagine|feel like|reckon)\\b[,]?\\s*","\\bmaybe\\b[,]?\\s*","\\bperhaps\\b[,]?\\s*","\\bpossibly\\b[,]?\\s*","\\bit seems like\\b\\s*","\\bit appears that\\b\\s*","\\bto be honest\\b[,]?\\s*","\\bin my opinion\\b[,]?\\s*"] { r = rx(r, p, "", [.caseInsensitive]) }
        return r
    }
    private func rmMeta(_ t: String) -> String {
        var r = t
        for p in ["\\bI (want|need|would like) you to\\b\\s*","\\bwhat I (need|want|am looking for) is\\b\\s*","\\bI('m| am) looking for\\b\\s*","\\bmy question is\\b[,:]?\\s*","\\bI('d| would) like to ask\\b\\s*","\\bI('m| am) wondering\\b\\s*"] { r = rx(r, p, "", [.caseInsensitive]) }
        return r
    }
    private func shorten(_ t: String) -> String {
        var r = t
        for (p, rep) in [("\\bin order to\\b","to"),("\\bdue to the fact that\\b","because"),("\\bat this point in time\\b","now"),("\\bmake sure\\b","ensure"),("\\ba lot of\\b","many"),("\\bin the event that\\b","if"),("\\bfor the purpose of\\b","to"),("\\bprior to\\b","before"),("\\bsubsequent to\\b","after"),("\\bin spite of\\b","despite"),("\\bwith regard to\\b","about"),("\\bin terms of\\b","for"),("\\bthe majority of\\b","most"),("\\ba number of\\b","several"),("\\bat the present time\\b","now"),("\\bin the near future\\b","soon"),("\\bon a daily basis\\b","daily"),("\\bhas the ability to\\b","can"),("\\bis able to\\b","can"),("\\btake into account\\b","consider")] as [(String,String)] { r = rx(r, p, rep, [.caseInsensitive]) }
        return r
    }
    private func simplify(_ t: String) -> String {
        var r = t
        for (p, rep) in [("\\butilize\\b","use"),("\\bimplement\\b","add"),("\\bdemonstrate\\b","show"),("\\bapproximately\\b","about"),("\\bsufficient\\b","enough"),("\\bterminate\\b","end"),("\\binitiate\\b","start"),("\\bfacilitate\\b","help"),("\\bendeavor\\b","try"),("\\bcommence\\b","begin"),("\\bascertain\\b","find"),("\\bameliorate\\b","improve"),("\\belucidate\\b","explain"),("\\bsubsequently\\b","then"),("\\badditionally\\b","also"),("\\bfurthermore\\b","also"),("\\bnevertheless\\b","but")] as [(String,String)] { r = rx(r, p, rep, [.caseInsensitive]) }
        return r
    }
    private func removeRedundantContent(_ t: String) -> String {
        let hp = t.range(of: "[.!?]", options: .regularExpression) != nil
        guard let regex = try? NSRegularExpression(pattern: hp ? "(?<=[.!?])\\s+" : ",\\s*") else { return t }
        let clauses = regex.splitString(t); var seen: [Set<String>] = []; var filtered: [String] = []
        for c in clauses {
            let n = c.lowercased().replacingOccurrences(of: "[^\\w\\s]", with: "", options: .regularExpression).trimmingCharacters(in: .whitespaces)
            let w = Set(n.split(whereSeparator: { $0.isWhitespace }).map(String.init))
            if n.isEmpty || w.count < 3 { filtered.append(c); continue }
            if seen.contains(where: { Double(w.intersection($0).count) / Double(max(w.count, $0.count)) > 0.75 }) { continue }
            seen.append(w); filtered.append(c)
        }
        return filtered.joined(separator: hp ? " " : ", ")
    }
    private func deduplicateSentences(_ t: String) -> String {
        var seen = Set<String>(); return t.components(separatedBy: "\n").filter { line in
            let tr = line.trimmingCharacters(in: .whitespaces); if tr.isEmpty { return true }
            if seen.contains(tr.lowercased()) { return false }; seen.insert(tr.lowercased()); return true
        }.joined(separator: "\n")
    }
    private func deduplicateClauses(_ t: String) -> String {
        let parts = t.components(separatedBy: ", "); if parts.count < 2 { return t }
        var seen = Set<String>(); return parts.filter { let n = $0.lowercased().trimmingCharacters(in: .whitespaces); if seen.contains(n) { return false }; seen.insert(n); return true }.joined(separator: ", ")
    }
    private func compressCodeFn(_ t: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: "```(\\w*)\\n([\\s\\S]*?)```") else { return t }
        let ns = t as NSString; var r = t
        for m in regex.matches(in: t, range: NSRange(location: 0, length: ns.length)).reversed() {
            guard let fr = Range(m.range, in: r), let lr = Range(m.range(at: 1), in: r), let cr = Range(m.range(at: 2), in: r) else { continue }
            let lang = String(r[lr]); var code = String(r[cr])
            code = rx(code, "(?m)^\\s*//\\s*.*$", "")
            code = code.replacingOccurrences(of: "/\\*[\\s\\S]*?\\*/", with: "", options: .regularExpression)
            code = code.replacingOccurrences(of: "\\n{3,}", with: "\n\n", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
            r.replaceSubrange(fr, with: "```\(lang)\n\(code)\n```")
        }
        return r
    }
    private func numeralize(_ t: String) -> String {
        var r = t
        let numMap: [(String, String)] = [("zero","0"),("one","1"),("two","2"),("three","3"),("four","4"),("five","5"),("six","6"),("seven","7"),("eight","8"),("nine","9"),("ten","10"),("twenty","20"),("thirty","30"),("forty","40"),("fifty","50"),("hundred","100")]
        for (w, n) in numMap { r = rx(r, "\\b\(w)\\b", n, [.caseInsensitive]) }; return r
    }
    private func convertToStructured(_ t: String) -> String {
        var r = t; for (w, n) in ["first":"1","second":"2","third":"3","fourth":"4","fifth":"5"] { r = rx(r, "\\b[Tt]he \(w) (?:thing|point|step|item) is\\s+", "\(n). ") }; return r
    }
    private func abbrev(_ t: String) -> String {
        var r = t; for (p, rep) in [("\\bfunction\\b","fn"),("\\bapplication\\b","app"),("\\bconfiguration\\b","config"),("\\bdocumentation\\b","docs"),("\\brepository\\b","repo"),("\\bdirectory\\b","dir"),("\\binformation\\b","info"),("\\benvironment\\b","env"),("\\bdevelopment\\b","dev"),("\\bproduction\\b","prod"),("\\bauthentication\\b","auth"),("\\bauthorization\\b","authz"),("\\bdatabase\\b","DB")] as [(String,String)] { r = rx(r, p, rep, [.caseInsensitive]) }; return r
    }
    private func stripMd(_ t: String) -> String {
        var r = t; r = rx(r, "\\*{1,2}([^*]+)\\*{1,2}", "$1"); r = rx(r, "_{1,2}([^_]+)_{1,2}", "$1"); r = rx(r, "^#{1,4}\\s+", "", [.anchorsMatchLines]); return r
    }
    private func rmArticles(_ t: String) -> String {
        var r = t; r = rx(r, "\\bthe\\b\\s+", "", [.caseInsensitive]); r = rx(r, "\\ba\\b\\s+", "", [.caseInsensitive]); r = rx(r, "\\ban\\b\\s+", "", [.caseInsensitive]); return r
    }
    private func telegraph(_ t: String) -> String {
        var r = t
        r = rx(r, "\\bI (want|need|have|think|believe|know|see|feel|like|hope|wish|expect|prefer|suggest|recommend|understand|guess|suppose|wonder|remember|realize|imagine|consider|tried?)\\b", "$1", [.caseInsensitive])
        r = rx(r, "\\byou (can|could|should|might|may|will|would) (also )?(just )?(use|try|check|look|see|read|write|run|add|set|get|find|make|do|go|put|take|give|call|send|open|close|start|stop|move|create|build|install|update|change|remove|delete|test|debug|fix|deploy)\\b", "$4", [.caseInsensitive])
        r = rx(r, "\\b(we|you) (need|have|want) to\\b", "", [.caseInsensitive])
        r = rx(r, "\\bin order to\\b", "to", [.caseInsensitive])
        r = rx(r, "\\bit (would|could) be (good|nice|great|helpful|useful|better|best|ideal) (to|if)\\s*", "", [.caseInsensitive])
        r = rx(r, "\\bwhat (you|we|I) (want|need|have|should) to do is\\s*", "", [.caseInsensitive])
        r = rx(r, "\\bas (you can see|I said|mentioned|noted|shown|stated|described|explained)\\b[,]?\\s*", "", [.caseInsensitive])
        r = rx(r, "\\b(that being said|having said that|that said)\\b[,]?\\s*", "", [.caseInsensitive])
        r = rx(r, "\\bthe (thing|point|issue|problem|question|idea) is (that )?\\s*", "", [.caseInsensitive])
        r = rx(r, "\\bwhen it comes to\\b", "for", [.caseInsensitive])
        r = rx(r, "\\bas a result\\b", "so", [.caseInsensitive])
        r = rx(r, "\\bon the other hand\\b", "but", [.caseInsensitive])
        r = rx(r, "\\bat the end of the day\\b", "", [.caseInsensitive])
        r = rx(r, "\\b(OK|okay|alright|right) so\\b[,]?\\s*", "", [.caseInsensitive])
        return r
    }
    private func consolidateQ(_ t: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: "[^.!?\\n]*\\?") else { return t }
        let ns = t as NSString; let ms = regex.matches(in: t, range: NSRange(location: 0, length: ns.length))
        if ms.count < 2 { return t }
        let qs = ms.map { ns.substring(with: $0.range) }; var used = Set<Int>(); var groups: [[Int]] = []
        for i in 0..<qs.count {
            if used.contains(i) { continue }; var g = [i]
            let wi = Set(qs[i].lowercased().replacingOccurrences(of: "[^\\w\\s]", with: "", options: .regularExpression).split(whereSeparator: { $0.isWhitespace }).filter { $0.count > 2 }.map(String.init))
            for j in (i+1)..<qs.count {
                if used.contains(j) { continue }
                let wj = Set(qs[j].lowercased().replacingOccurrences(of: "[^\\w\\s]", with: "", options: .regularExpression).split(whereSeparator: { $0.isWhitespace }).filter { $0.count > 2 }.map(String.init))
                let mn = min(wi.count, wj.count); if mn > 0, Double(wi.intersection(wj).count) / Double(mn) >= 0.4 { g.append(j); used.insert(j) }
            }
            used.insert(i); groups.append(g)
        }
        if groups.allSatisfy({ $0.count == 1 }) { return t }
        var r = t; for g in groups where g.count >= 2 { let sorted = g.map { qs[$0] }.sorted { $0.count < $1.count }; for k in 1..<sorted.count { r = r.replacingOccurrences(of: sorted[k], with: "") } }
        return r.replacingOccurrences(of: " {2,}", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
    }
    private func dropLowInfo(_ t: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: "([.!?]+\\s*)") else { return t }
        let parts = regex.splitStringKeepingSeparators(t); if parts.count < 4 { return t }
        var sents: [String] = []; var i = 0; while i < parts.count { sents.append(parts[i] + (i+1 < parts.count ? parts[i+1] : "")); i += 2 }
        if sents.count < 3 { return t }
        let scored: [(s: String, score: Double, words: Int)] = sents.map { s in
            let w = s.lowercased().replacingOccurrences(of: "[^\\w\\s]", with: "", options: .regularExpression).split(whereSeparator: { $0.isWhitespace }).map(String.init).filter { !$0.isEmpty }
            if w.isEmpty { return (s, 0, 0) }; return (s, Double(w.filter { !FILLER_WORDS.contains($0) && $0.count > 2 }.count) / Double(w.count), w.count)
        }
        let kept = scored.enumerated().filter { i, item in i == 0 || (item.words >= 3 && !(item.score < 0.1 && item.words < 8)) }.map { $0.element }
        if kept.count == scored.count { return t }
        return kept.map { $0.s }.joined(separator: " ").replacingOccurrences(of: " {2,}", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
    }

    // MARK: - Helpers
    private func rx(_ t: String, _ p: String, _ r: String, _ o: NSRegularExpression.Options = []) -> String {
        guard let regex = try? NSRegularExpression(pattern: p, options: o) else { return t }
        return regex.stringByReplacingMatches(in: t, range: NSRange(t.startIndex..., in: t), withTemplate: r)
    }
    private func capFirst(_ t: inout String) { if !t.isEmpty, let f = t.first, f.isLowercase { t = f.uppercased() + t.dropFirst() } }
    private func cleanup(_ t: String) -> String {
        var r = t; r = r.replacingOccurrences(of: "\\n{3,}", with: "\n\n", options: .regularExpression)
        r = r.replacingOccurrences(of: " {2,}", with: " ", options: .regularExpression)
        r = r.replacingOccurrences(of: "\\.\\s*\\.", with: ".", options: .regularExpression)
        r = rx(r, "(?m)^\\s*[,.:]+\\s*", "")
        r = r.replacingOccurrences(of: "\\s+([,.])", with: "$1", options: .regularExpression)
        r = r.trimmingCharacters(in: .whitespacesAndNewlines)
        if !r.isEmpty, let f = r.first, f.isLowercase { r = f.uppercased() + r.dropFirst() }
        if let regex = try? NSRegularExpression(pattern: "([.!?]\\s+)([a-z])") {
            let ns = r as NSString; for m in regex.matches(in: r, range: NSRange(location: 0, length: ns.length)).reversed() {
                let lr = m.range(at: 2); r = (r as NSString).replacingCharacters(in: lr, with: ns.substring(with: lr).uppercased())
            }
        }
        r = r.replacingOccurrences(of: "\\b(and|also|but|or|additionally|furthermore|moreover)\\s*[,.]?\\s*$", with: "", options: [.regularExpression, .caseInsensitive])
        return r.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    private func genSuggestions(_ t: String, _ a: [String]) -> [Suggestion] {
        var s: [Suggestion] = []
        if t.count > 2000 { s.append(Suggestion(type: "structure", text: "Consider breaking this into smaller, focused prompts.")) }
        if t.range(of: "```[\\s\\S]{500,}```", options: .regularExpression) != nil { s.append(Suggestion(type: "code", text: "Large code blocks. Include only the relevant snippet.")) }
        if t.count < 200 { s.append(Suggestion(type: "routing", text: "Simple prompt — consider a smaller model.")) }
        if a.isEmpty { s.append(Suggestion(type: "info", text: "Already concise. No optimizations found.")) }
        return s
    }
}

// MARK: - NSRegularExpression Extensions
extension NSRegularExpression {
    func splitString(_ text: String) -> [String] {
        let ns = text as NSString; let ms = self.matches(in: text, range: NSRange(location: 0, length: ns.length))
        var result: [String] = []; var last = 0
        for m in ms { if m.range.location > last { result.append(ns.substring(with: NSRange(location: last, length: m.range.location - last))) }; last = m.range.location + m.range.length }
        if last < ns.length { result.append(ns.substring(from: last)) }; return result
    }
    func splitStringKeepingSeparators(_ text: String) -> [String] {
        let ns = text as NSString; let ms = self.matches(in: text, range: NSRange(location: 0, length: ns.length))
        var result: [String] = []; var last = 0
        for m in ms { if m.range.location > last { result.append(ns.substring(with: NSRange(location: last, length: m.range.location - last))) }; result.append(ns.substring(with: m.range)); last = m.range.location + m.range.length }
        if last < ns.length { result.append(ns.substring(from: last)) }; return result
    }
}
