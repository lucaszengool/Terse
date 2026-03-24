import Foundation

// MARK: - Multi-Language Optimization Dictionaries
// Each language has: filler words, politeness, hedging, meta-language, phrase shortening

struct TerseMultiLang {

    // MARK: - Spanish (ES)
    static let esFillers = ["\\bbásicamente\\b[,]?\\s*","\\brealmente\\b[,]?\\s*","\\bsimplemente\\b\\s+","\\btotalmente\\b\\s+","\\bliteralmente\\b[,]?\\s*","\\bobviamente\\b[,]?\\s*","\\bclaramente\\b[,]?\\s*","\\bhonestamente\\b[,]?\\s*","\\bde hecho\\b[,]?\\s*","\\ben realidad\\b[,]?\\s*","\\bla verdad es que\\b[,]?\\s*","\\bdigamos\\b[,]?\\s*","\\bpues\\b[,]?\\s*","\\bbueno\\b[,]?\\s*"]
    static let esPoliteness = ["\\bpor favor\\b[,]?\\s*","\\b¿?podrías\\b\\s*","\\b¿?serías tan amable de\\b\\s*","\\bsi no es molestia\\b[,]?\\s*","\\bdisculpa (por|si)\\b[^.!?]*","\\bperdón por\\b[^.!?]*","\\bte agradecería (si|que)\\b[^.!?]*","\\bsi fueras tan amable\\b[,]?\\s*"]
    static let esHedging = ["\\bcreo que\\b[,]?\\s*","\\bme parece que\\b[,]?\\s*","\\btal vez\\b[,]?\\s*","\\bquizás\\b[,]?\\s*","\\bposiblemente\\b[,]?\\s*","\\ba lo mejor\\b[,]?\\s*","\\ben mi opinión\\b[,]?\\s*","\\bprobablemente\\b[,]?\\s*"]
    static let esMeta = ["\\bquiero que\\b\\s*","\\bnecesito que\\b\\s*","\\bme gustaría que\\b\\s*","\\blo que busco es\\b\\s*","\\bmi pregunta es\\b[,:]?\\s*","\\bestoy buscando\\b\\s*","\\bme pregunto\\b\\s*"]
    static let esShorten: [(String, String)] = [("\\bcon el fin de\\b","para"),("\\bdebido al hecho de que\\b","porque"),("\\ben este momento\\b","ahora"),("\\basegurarse de\\b","verificar"),("\\buna gran cantidad de\\b","muchos"),("\\bcon respecto a\\b","sobre"),("\\bla mayoría de\\b","la mayoría"),("\\ben el futuro cercano\\b","pronto"),("\\btiene la capacidad de\\b","puede"),("\\bes capaz de\\b","puede"),("\\btener en cuenta\\b","considerar"),("\\bcon anterioridad\\b","antes")]

    // MARK: - Chinese (ZH) — comprehensive token reduction

    // 1. Filler words (口头禅/废话) — removed entirely
    static let zhFillers = [
        // Common verbal fillers
        "其实[,，]?\\s*","基本上[,，]?\\s*","说实话[,，]?\\s*","老实说[,，]?\\s*",
        "实际上[,，]?\\s*","事实上[,，]?\\s*","坦白说[,，]?\\s*","总之[,，]?\\s*",
        "反正[,，]?\\s*","就是说[,，]?\\s*","怎么说呢[,，]?\\s*","然后呢[,，]?\\s*",
        // Extended fillers
        "那个[,，]?\\s*","嗯[,，]?\\s*","就是[,，]?\\s*","然后[,，]?\\s*",
        "对吧[,，]?\\s*","你知道吗[,，]?\\s*","我跟你说[,，]?\\s*",
        "简单来说[,，]?\\s*","换句话说[,，]?\\s*","说白了[,，]?\\s*",
        "不瞒你说[,，]?\\s*","说到底[,，]?\\s*","归根结底[,，]?\\s*",
        "严格来说[,，]?\\s*","一般来说[,，]?\\s*","总的来说[,，]?\\s*",
        "客观来说[,，]?\\s*","从某种意义上说[,，]?\\s*",
    ]

    // 2. Politeness (客气话) — removed in prompt context
    static let zhPoliteness = [
        "请[你您]?\\s*","麻烦[你您]?\\s*","劳驾\\s*","不好意思[,，]?\\s*",
        "打扰[一下了]?[,，]?\\s*","抱歉[,，]?\\s*","能不能帮我\\s*",
        "可以帮我\\s*","如果方便的话[,，]?\\s*","你能不能\\s*",
        // Extended politeness
        "能否请你\\s*","可否\\s*","烦请\\s*","有劳\\s*",
        "感谢你的帮助[,，。]?\\s*","谢谢你[,，。]?\\s*","非常感谢[,，。]?\\s*",
        "辛苦了[,，。]?\\s*","多谢[,，。]?\\s*",
        "不胜感激[,，。]?\\s*","万分感谢[,，。]?\\s*",
    ]

    // 3. Hedging (犹豫/模糊语) — removed for directness
    static let zhHedging = [
        "我觉得\\s*","我认为\\s*","我想\\s*","可能\\s*","也许\\s*",
        "大概\\s*","应该\\s*","好像\\s*","似乎\\s*","看起来\\s*","估计\\s*",
        // Extended hedging
        "或许\\s*","恐怕\\s*","大约\\s*","差不多\\s*","几乎\\s*",
        "不确定但\\s*","如果我没记错\\s*","据我所知\\s*",
        "我个人认为\\s*","依我看\\s*","照我看来\\s*","按我的理解\\s*",
        "在我看来[,，]?\\s*","以我的经验[,，]?\\s*",
    ]

    // 4. Meta-language (元语言) — the instruction about the instruction
    static let zhMeta = [
        "我想问\\s*","我的问题是[,，:]?\\s*","我想知道\\s*","我需要你\\s*",
        "我希望你能\\s*","帮我\\s*","我在找\\s*","我想让你\\s*",
        // Extended meta
        "请你帮我\\s*","我想请你\\s*","我有一个问题[,，:]?\\s*",
        "我想咨询一下\\s*","我想了解\\s*","我想确认\\s*",
        "我的意思是\\s*","我想表达的是\\s*","我要说的是\\s*",
        "接下来我想说的是\\s*","关于这个问题\\s*","就这个问题\\s*",
    ]

    // 5. Phrase shortening (缩写/精简)
    static let zhShorten: [(String, String)] = [
        // Wordy → concise
        ("为了能够","为了"), ("由于…的原因","因为"), ("在目前这个时候","现在"),
        ("在不久的将来","即将"), ("绝大多数的","大多数"), ("关于…方面","关于"),
        ("具有…的能力","能"),
        // Extended shortenings
        ("在这种情况下","此时"), ("从目前的情况来看","目前"),
        ("在很大程度上","很大程度"), ("在某种程度上","某种程度"),
        ("毫无疑问地","无疑"), ("与此同时","同时"),
        ("不管怎么说","总之"), ("无论如何","总之"),
        ("在此基础上","基于此"), ("鉴于以上情况","因此"),
        ("经过仔细考虑","考虑后"), ("通过这种方式","这样"),
        ("在一定程度上","部分"), ("就目前而言","目前"),
        ("换言之","即"), ("也就是说","即"),
        ("由此可见","可见"), ("综上所述","综上"),
        ("除此之外","另外"), ("不仅如此","且"),
        ("与此相关的是","相关的"),
        // Redundant constructions
        ("进行研究","研究"), ("进行分析","分析"), ("进行讨论","讨论"),
        ("进行调查","调查"), ("进行处理","处理"), ("进行修改","修改"),
        ("做出决定","决定"), ("做出改变","改变"), ("做出调整","调整"),
        ("给予帮助","帮助"), ("给予支持","支持"), ("给予回复","回复"),
        ("提出建议","建议"), ("提出问题","问"),
        ("进行了一次","做了"), ("开展了一项","做了"),
        // Verbose → direct
        ("是否可以","能否"), ("是否能够","能否"), ("有没有可能","能否"),
        ("有没有办法","能否"), ("能不能够","能否"),
        ("非常非常","极"), ("很多很多","大量"), ("越来越多的","更多"),
    ]

    // MARK: - French (FR)
    static let frFillers = ["\\bbasiquement\\b[,]?\\s*","\\bvraiment\\b\\s+","\\bjustement\\b[,]?\\s*","\\blittéralement\\b[,]?\\s*","\\bévidemment\\b[,]?\\s*","\\bclairement\\b[,]?\\s*","\\bhonnêtement\\b[,]?\\s*","\\ben fait\\b[,]?\\s*","\\ben réalité\\b[,]?\\s*","\\bfranchement\\b[,]?\\s*","\\beffectivement\\b[,]?\\s*","\\bbon\\b[,]?\\s*","\\bdonc\\b[,]?\\s*","\\bdu coup\\b[,]?\\s*"]
    static let frPoliteness = ["\\bs'il (vous|te) plaît\\b[,]?\\s*","\\bpourriez-vous\\b\\s*","\\bauriez-vous la gentillesse de\\b\\s*","\\bje vous prie de\\b\\s*","\\bexcusez-moi (de|si)\\b[^.!?]*","\\bpardon (de|pour)\\b[^.!?]*","\\bje vous serais reconnaissant\\b[^.!?]*"]
    static let frHedging = ["\\bje pense que\\b[,]?\\s*","\\bje crois que\\b[,]?\\s*","\\bpeut-être\\b[,]?\\s*","\\bprobablement\\b[,]?\\s*","\\bil me semble que\\b[,]?\\s*","\\bà mon avis\\b[,]?\\s*","\\bselon moi\\b[,]?\\s*"]
    static let frMeta = ["\\bje voudrais que\\b\\s*","\\bj'ai besoin que\\b\\s*","\\bce que je cherche c'est\\b\\s*","\\bma question est\\b[,:]?\\s*","\\bje me demande\\b\\s*"]
    static let frShorten: [(String, String)] = [("\\bafin de\\b","pour"),("\\ben raison du fait que\\b","car"),("\\bà ce moment-là\\b","maintenant"),("\\bune grande quantité de\\b","beaucoup"),("\\ben ce qui concerne\\b","sur"),("\\bla majorité de\\b","la plupart"),("\\bdans un avenir proche\\b","bientôt"),("\\best capable de\\b","peut"),("\\bprendre en considération\\b","considérer")]

    // MARK: - German (DE)
    static let deFillers = ["\\bgrundsätzlich\\b[,]?\\s*","\\beigentlich\\b[,]?\\s*","\\btatsächlich\\b[,]?\\s*","\\bwirklich\\b\\s+","\\behrlich gesagt\\b[,]?\\s*","\\bim Grunde\\b[,]?\\s*","\\bsozusagen\\b[,]?\\s*","\\bgewissermaßen\\b[,]?\\s*","\\bhalt\\b[,]?\\s*","\\beben\\b[,]?\\s*","\\bja\\b[,]?\\s*","\\bnun\\b[,]?\\s*"]
    static let dePoliteness = ["\\bbitte\\b[,]?\\s*","\\bkönnten Sie\\b\\s*","\\bwürden Sie\\b\\s*","\\bwären Sie so freundlich\\b\\s*","\\bentschuldigen Sie\\b[,]?\\s*","\\bverzeihen Sie\\b[,]?\\s*","\\bich wäre Ihnen dankbar\\b[^.!?]*"]
    static let deHedging = ["\\bich denke\\b[,]?\\s*","\\bich glaube\\b[,]?\\s*","\\bvielleicht\\b[,]?\\s*","\\bmöglicherweise\\b[,]?\\s*","\\bwahrscheinlich\\b[,]?\\s*","\\bes scheint\\b\\s*","\\bmeiner Meinung nach\\b[,]?\\s*"]
    static let deMeta = ["\\bich möchte, dass\\b\\s*","\\bich brauche\\b\\s*","\\bich suche\\b\\s*","\\bmeine Frage ist\\b[,:]?\\s*","\\bich frage mich\\b\\s*"]
    static let deShorten: [(String, String)] = [("\\bum zu\\b","zu"),("\\baufgrund der Tatsache, dass\\b","weil"),("\\bzum gegenwärtigen Zeitpunkt\\b","jetzt"),("\\beine große Anzahl von\\b","viele"),("\\bin Bezug auf\\b","über"),("\\bdie Mehrheit von\\b","die meisten"),("\\bin der nahen Zukunft\\b","bald"),("\\bin der Lage sein\\b","können"),("\\bberücksichtigen\\b","bedenken")]

    // MARK: - Japanese (JA)
    static let jaFillers = ["基本的に[、,]?\\s*","実は[、,]?\\s*","正直に言うと[、,]?\\s*","要するに[、,]?\\s*","つまり[、,]?\\s*","まあ[、,]?\\s*","ちょっと[、,]?\\s*","なんか[、,]?\\s*","やっぱり[、,]?\\s*","一応[、,]?\\s*","とりあえず[、,]?\\s*"]
    static let jaPoliteness = ["お願いします[。]?\\s*","していただけますか\\s*","していただけると幸いです\\s*","お手数ですが[、,]?\\s*","恐れ入りますが[、,]?\\s*","申し訳ありませんが[、,]?\\s*","ご面倒をおかけしますが[、,]?\\s*","もしよろしければ[、,]?\\s*"]
    static let jaHedging = ["と思います\\s*","かもしれません\\s*","おそらく\\s*","たぶん\\s*","多分\\s*","のように見えます\\s*","私の意見では[、,]?\\s*","のようです\\s*"]
    static let jaMeta = ["が知りたいです\\s*","を教えてください\\s*","質問ですが[、,:]?\\s*","について聞きたいのですが\\s*","を探しています\\s*"]
    static let jaShorten: [(String, String)] = [("するために","ため"),("という理由で","なので"),("現時点で","今"),("大多数の","ほとんどの"),("に関して","について"),("近い将来","もうすぐ"),("する能力がある","できる"),("考慮に入れる","考慮する")]

    // MARK: - Korean (KO)
    static let koFillers = ["기본적으로\\s*","사실\\s*","솔직히\\s*","어쨌든\\s*","아무튼\\s*","그러니까\\s*","뭐랄까\\s*","약간\\s*","진짜\\s*","좀\\s*","그냥\\s*"]
    static let koPoliteness = ["부탁드립니다\\s*","해주실 수 있나요\\s*","해주시면 감사하겠습니다\\s*","죄송합니다만\\s*","실례합니다만\\s*","번거로우시겠지만\\s*","괜찮으시다면\\s*"]
    static let koHedging = ["것 같습니다\\s*","아마\\s*","혹시\\s*","어쩌면\\s*","제 생각에는\\s*","인 것 같은데\\s*"]
    static let koMeta = ["알고 싶습니다\\s*","질문이 있습니다\\s*","궁금한 게 있는데\\s*","찾고 있습니다\\s*"]
    static let koShorten: [(String, String)] = [("하기 위해서","위해"),("때문에","라서"),("현재 시점에서","지금"),("대다수의","대부분"),("에 관해서","에 대해"),("가까운 미래에","곧"),("할 수 있는 능력","할 수 있음")]

    // MARK: - Portuguese (PT)
    static let ptFillers = ["\\bbasicamente\\b[,]?\\s*","\\brealmente\\b\\s+","\\bliteralmente\\b[,]?\\s*","\\bobviamente\\b[,]?\\s*","\\bclaramente\\b[,]?\\s*","\\bhonestamente\\b[,]?\\s*","\\bna verdade\\b[,]?\\s*","\\bna real\\b[,]?\\s*","\\bpra falar a verdade\\b[,]?\\s*","\\btipo\\b[,]?\\s*","\\bné\\b[,]?\\s*"]
    static let ptPoliteness = ["\\bpor favor\\b[,]?\\s*","\\bpoderia\\b\\s*","\\bseria tão gentil\\b\\s*","\\bdesculpe (por|se)\\b[^.!?]*","\\bperdão por\\b[^.!?]*","\\beu agradeceria (se|que)\\b[^.!?]*","\\bse possível\\b[,]?\\s*"]
    static let ptHedging = ["\\beu acho que\\b[,]?\\s*","\\beu acredito que\\b[,]?\\s*","\\btalvez\\b[,]?\\s*","\\bpossivelmente\\b[,]?\\s*","\\bprovavelmente\\b[,]?\\s*","\\bparece que\\b[,]?\\s*","\\bna minha opinião\\b[,]?\\s*"]
    static let ptMeta = ["\\beu quero que\\b\\s*","\\beu preciso que\\b\\s*","\\bestou procurando\\b\\s*","\\bminha pergunta é\\b[,:]?\\s*","\\beu gostaria de saber\\b\\s*"]
    static let ptShorten: [(String, String)] = [("\\bpara poder\\b","para"),("\\bdevido ao fato de que\\b","porque"),("\\bneste momento\\b","agora"),("\\buma grande quantidade de\\b","muitos"),("\\bcom relação a\\b","sobre"),("\\ba maioria de\\b","a maioria"),("\\bnum futuro próximo\\b","em breve"),("\\bé capaz de\\b","pode"),("\\blevar em consideração\\b","considerar")]

    // MARK: - Arabic (AR)
    static let arFillers = ["بشكل أساسي[،,]?\\s*","في الواقع[،,]?\\s*","بصراحة[،,]?\\s*","حرفياً[،,]?\\s*","بوضوح[،,]?\\s*","يعني[،,]?\\s*","طبعاً[،,]?\\s*","فعلاً[،,]?\\s*","أساساً[،,]?\\s*"]
    static let arPoliteness = ["من فضلك[،,]?\\s*","لو سمحت[،,]?\\s*","هل يمكنك\\s*","هل بإمكانك\\s*","آسف (على|إذا)\\s*","عذراً\\s*","أقدر لو\\s*","إذا ما عليك أمر[،,]?\\s*"]
    static let arHedging = ["أعتقد أن\\s*","أظن أن\\s*","ربما\\s*","من الممكن\\s*","يبدو أن\\s*","في رأيي[،,]?\\s*","على ما يبدو\\s*"]
    static let arMeta = ["أريد أن\\s*","أحتاج أن\\s*","سؤالي هو[،,:]?\\s*","أبحث عن\\s*","أتساءل\\s*"]
    static let arShorten: [(String, String)] = [("من أجل أن","لـ"),("بسبب حقيقة أن","لأن"),("في الوقت الحالي","الآن"),("عدد كبير من","كثير من"),("فيما يتعلق بـ","حول"),("غالبية","معظم"),("في المستقبل القريب","قريباً"),("لديه القدرة على","يستطيع")]

    // MARK: - Language Detection & Application

    static func detectLanguage(_ text: String) -> String {
        // Simple heuristic: check for CJK, Arabic, or Latin-based scripts
        let sample = String(text.prefix(200))
        let cjk = sample.unicodeScalars.filter { (0x4E00...0x9FFF).contains($0.value) || (0x3040...0x30FF).contains($0.value) }.count
        let hangul = sample.unicodeScalars.filter { (0xAC00...0xD7AF).contains($0.value) }.count
        let arabic = sample.unicodeScalars.filter { (0x0600...0x06FF).contains($0.value) }.count
        let total = sample.count
        guard total > 0 else { return "en" }

        if Double(cjk) / Double(total) > 0.15 {
            // Check if Japanese (has hiragana/katakana)
            let kana = sample.unicodeScalars.filter { (0x3040...0x30FF).contains($0.value) }.count
            return kana > 0 ? "ja" : "zh"
        }
        if Double(hangul) / Double(total) > 0.15 { return "ko" }
        if Double(arabic) / Double(total) > 0.15 { return "ar" }

        // Latin-based: check for language-specific words
        let lower = sample.lowercased()
        if lower.contains("estoy") || lower.contains("puedo") || lower.contains("quiero") || lower.contains("también") { return "es" }
        if lower.contains("je suis") || lower.contains("nous") || lower.contains("c'est") || lower.contains("être") { return "fr" }
        if lower.contains("ich bin") || lower.contains("können") || lower.contains("möchte") || lower.contains("dass") { return "de" }
        if lower.contains("estou") || lower.contains("você") || lower.contains("também") || lower.contains("não") { return "pt" }

        return "en"
    }

    static func applyFillers(_ text: String, lang: String) -> String {
        let patterns: [String]
        switch lang {
        case "es": patterns = esFillers
        case "zh": patterns = zhFillers
        case "fr": patterns = frFillers
        case "de": patterns = deFillers
        case "ja": patterns = jaFillers
        case "ko": patterns = koFillers
        case "pt": patterns = ptFillers
        case "ar": patterns = arFillers
        default: return text // English handled by existing code
        }
        var r = text
        for p in patterns { r = rxReplace(r, p, "") }
        return r
    }

    static func applyPoliteness(_ text: String, lang: String) -> String {
        let patterns: [String]
        switch lang {
        case "es": patterns = esPoliteness
        case "zh": patterns = zhPoliteness
        case "fr": patterns = frPoliteness
        case "de": patterns = dePoliteness
        case "ja": patterns = jaPoliteness
        case "ko": patterns = koPoliteness
        case "pt": patterns = ptPoliteness
        case "ar": patterns = arPoliteness
        default: return text
        }
        var r = text
        for p in patterns { r = rxReplace(r, p, "") }
        return r
    }

    static func applyHedging(_ text: String, lang: String) -> String {
        let patterns: [String]
        switch lang {
        case "es": patterns = esHedging
        case "zh": patterns = zhHedging
        case "fr": patterns = frHedging
        case "de": patterns = deHedging
        case "ja": patterns = jaHedging
        case "ko": patterns = koHedging
        case "pt": patterns = ptHedging
        case "ar": patterns = arHedging
        default: return text
        }
        var r = text
        for p in patterns { r = rxReplace(r, p, "") }
        return r
    }

    static func applyMeta(_ text: String, lang: String) -> String {
        let patterns: [String]
        switch lang {
        case "es": patterns = esMeta
        case "zh": patterns = zhMeta
        case "fr": patterns = frMeta
        case "de": patterns = deMeta
        case "ja": patterns = jaMeta
        case "ko": patterns = koMeta
        case "pt": patterns = ptMeta
        case "ar": patterns = arMeta
        default: return text
        }
        var r = text
        for p in patterns { r = rxReplace(r, p, "") }
        return r
    }

    static func applyShorten(_ text: String, lang: String) -> String {
        let pairs: [(String, String)]
        switch lang {
        case "es": pairs = esShorten
        case "zh": pairs = zhShorten
        case "fr": pairs = frShorten
        case "de": pairs = deShorten
        case "ja": pairs = jaShorten
        case "ko": pairs = koShorten
        case "pt": pairs = ptShorten
        case "ar": pairs = arShorten
        default: return text
        }
        var r = text
        for (p, rep) in pairs { r = rxReplace(r, p, rep) }
        return r
    }

    // MARK: - Regex Helper

    private static func rxReplace(_ text: String, _ pattern: String, _ replacement: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return text }
        let range = NSRange(text.startIndex..., in: text)
        return regex.stringByReplacingMatches(in: text, options: [], range: range, withTemplate: replacement)
    }
}
