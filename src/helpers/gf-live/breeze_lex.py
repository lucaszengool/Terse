"""Breeze2's pronunciations, fixed where they blurred her words (user 10-21: "C4 有个别字吐字不清晰，或者糊掉了").

Breeze2-VITS reads text through sherpa-onnx: jieba (Melo's dictionary) splits it into words, each word is looked up in
Breeze2's lexicon (simplified keys → 注音), and a word that isn't there is read character by character — each with its
citation tone. Measured on 30 of her lines × 3 takes (Paraformer reading her back), that is where the systematic misses
came from:
  · 一 / 不 tone sandhi: 一下 / 一步 / 一次 aren't in the lexicon → yī xià instead of yí xià; 不用 is listed as bù yòng
  · the structural particles: 写得 / 睡得 → 得 read dé (its citation tone), 慢慢地 → 地 read dì; both are a neutral de
This builds a lexicon + jieba user dictionary that add those words (and correct the wrong ones) from data already
installed — Breeze2's own lexicon for every syllable, Melo's jieba dictionary for which words exist — by rule:
  · 一 before a 4th tone → yí, before 1st / 2nd / 3rd → yì; 不 before a 4th tone → bú (never for 一 as a number: 一月, 第一 …)
  · A不A (好不好, 累不累 …) → the same 不 rule
  · verb + 得 and adverb + 地 → neutral ˙de
  · the clause particles 呢 嘛 呀 啦 吧 吗 哦 in tone 1, as the Melo voice has them (melo_gpu.PARTICLES_T1, user 10-21 "不够嗲"):
    in the neutral tone Breeze2 says them short and soft, and at the end of a line they were swallowed (嘛 / 哦 missed in
    every take); in tone 1 they are voiced in full — the 撒娇 ending ("快来陪我嘛~")
Output: <models>/breeze2-vits/mia/{lexicon.txt, dict/…} — rebuilt only when missing or older than its inputs."""
import os, shutil

SANDHI_SKIP = set("月号楼二三四五六七八九十百千万亿零")   # 一 as a number / date / ordinal: yī, whatever follows
DE_VERBS = ("睡写说做长过吃玩跑唱笑哭来走看听想弄搞变讲学干打活住穿画跳哭气急忙累饿冷热美乖帅香甜好快慢早晚多少高低远近"
            "开关拿放带买卖用叫写读算记跑飞游坐站躺醒聊讲演表现弹拉推抱亲吻喊骂夸教问答交找等")
PARTICLES_T1 = "呢嘛呀啦吧吗哦"
DI_ADVS = ["慢慢", "轻轻", "好好", "静静", "悄悄", "默默", "偷偷", "紧紧", "深深", "甜甜", "乖乖", "早早", "远远", "高高", "大大",
           "开心", "认真", "温柔", "安静", "小心", "努力", "大声", "轻声", "仔细", "耐心", "用力", "拼命", "默默", "静悄悄", "不停",
           "悄悄", "慢吞吞", "傻傻", "痴痴", "呆呆", "狠狠", "牢牢", "稳稳", "暖暖", "淡淡", "轻柔", "温暖", "幸福", "开开心心"]


def _tone(syl):
    """the tone mark of one 注音 syllable (list of tokens) → 1–5 (5 = neutral)"""
    t = syl[-1]
    return {"ˉ": 1, "ˊ": 2, "ˇ": 3, "ˋ": 4, "˙": 5}.get(t, 1)


def _syllables(phones):
    """注音 token list → syllables (each ends with its tone mark)"""
    out, cur = [], []
    for p in phones:
        cur.append(p)
        if p in ("ˉ", "ˊ", "ˇ", "ˋ", "˙"):
            out.append(cur); cur = []
    if cur: out.append(cur)
    return out


def build(models):
    src = os.path.join(models, "breeze2-vits", "lexicon.txt")
    jdir = os.path.join(models, "vits-melo-tts-zh_en", "dict")
    out = os.path.join(models, "breeze2-vits", "mia")
    lex_out, dict_out = os.path.join(out, "lexicon.txt"), os.path.join(out, "dict")
    if not (os.path.exists(src) and os.path.isdir(jdir)): return None
    newest = max(os.path.getmtime(src), os.path.getmtime(__file__), os.path.getmtime(os.path.join(jdir, "jieba.dict.utf8")))
    if os.path.exists(lex_out) and os.path.getmtime(lex_out) >= newest and os.path.exists(os.path.join(dict_out, "user.dict.utf8")):
        return lex_out, dict_out
    lines, lex = [], {}
    for l in open(src, encoding="utf-8"):
        p = l.split()
        if len(p) >= 2:
            if p[0] not in lex: lex[p[0]] = p[1:]
            lines.append(p)
    char = {w: ph for w, ph in lex.items() if len(w) == 1}

    def read(word):                                    # citation reading of a word, char by char (what sherpa falls back to)
        if word in lex: return list(lex[word])
        ph = []
        for c in word:
            if c not in char: return None
            ph += char[c]
        return ph

    jwords = []
    for l in open(os.path.join(jdir, "jieba.dict.utf8"), encoding="utf-8"):
        p = l.split()
        if p and 2 <= len(p[0]) <= 4: jwords.append(p[0])
    jset = set(jwords)
    add, fix = {}, {}

    def yi_bu(word, ph, k):                            # word[k] is 一 / 不, ph its reading: apply sandhi from the next syllable
        syl = _syllables(ph)
        if k + 1 >= len(syl): return None
        nxt = _tone(syl[k + 1]) if word[k + 1] != "个" else 4         # 个 is ge4 underneath its neutral tone
        if word[k] == "一":
            if word[k + 1] in SANDHI_SKIP or (k > 0 and word[k - 1] in "第十统唯"): want = "ˉ"
            else: want = "ˊ" if nxt == 4 else "ˋ" if nxt in (1, 2, 3) else None
        else:
            want = "ˊ" if nxt == 4 else None
        if want is None or syl[k][-1] == want: return None
        syl[k] = syl[k][:-1] + [want]
        return [t for s in syl for t in s]

    for w in jwords:                                   # dictionary words with 一 / 不 in them
        if "一" not in w and "不" not in w: continue
        ph = read(w)
        if ph is None or len(_syllables(ph)) != len(w): continue
        new = ph
        for k, c in enumerate(w):
            if c in "一不":
                r = yi_bu(w, new, k)
                if r: new = r
        if new != ph:
            (fix if w in lex else add)[w] = new
    for a in "好对累是要会能想去来走吃喝睡忙怕冷热累饿痛疼爱行乖美帅香甜可".replace(" ", ""):  # A不A
        w = a + "不" + a; ph = read(w)
        if ph is None: continue
        r = yi_bu(w, ph, 1) or ph
        if w not in lex: add[w] = r
    for v in dict.fromkeys(DE_VERBS):                  # verb + 得 → ˙de
        w = v + "得"
        if w in lex or v not in char: continue
        add[w] = char[v] + ["ㄉ", "ㄜ", "˙"]
    for a in dict.fromkeys(DI_ADVS):                   # adverb + 地 → ˙de
        w = a + "地"; ph = read(a)
        if w in lex or ph is None: continue
        add[w] = ph + ["ㄉ", "ㄜ", "˙"]

    def particle_t1(w, ph):                            # a word ending in a neutral-tone clause particle → that syllable tone 1
        if not w or w[-1] not in PARTICLES_T1 or not ph or ph[-1] != "˙": return None
        return ph[:-1] + ["ˉ"]
    for w, ph in list(lex.items()):
        r = particle_t1(w, fix.get(w, ph))
        if r: fix[w] = r
    for w, ph in list(add.items()):
        r = particle_t1(w, ph)
        if r: add[w] = r

    os.makedirs(dict_out, exist_ok=True)
    tmp = lex_out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        for p in lines:
            f.write(" ".join([p[0]] + (fix[p[0]] if p[0] in fix else p[1:])) + "\n")
        for w, ph in add.items():
            f.write(" ".join([w] + ph) + "\n")
    for fn in os.listdir(jdir):                        # jieba: Melo's dictionary + these words, so they come out whole
        s = os.path.join(jdir, fn)
        if os.path.isfile(s) and fn != "user.dict.utf8": shutil.copy2(s, os.path.join(dict_out, fn))
    old = open(os.path.join(jdir, "user.dict.utf8"), encoding="utf-8").read() if os.path.exists(os.path.join(jdir, "user.dict.utf8")) else ""
    with open(os.path.join(dict_out, "user.dict.utf8"), "w", encoding="utf-8") as f:
        f.write(old.rstrip("\n") + ("\n" if old.strip() else ""))
        for w in add:
            if w not in jset: f.write(f"{w} 50000 n\n")
    os.replace(tmp, lex_out)
    print(f"[gf-live] Breeze2 pronunciations: +{len(add)} words, {len(fix)} corrected", flush=True)
    return lex_out, dict_out


if __name__ == "__main__":
    import sys
    print(build(os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else "~/.terse/gf-live/models")))
