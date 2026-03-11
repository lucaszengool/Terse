# Terse Token Optimization — Techniques & Algorithms

A comprehensive reference of every technique, algorithm, and heuristic used by the Terse optimizer to reduce LLM prompt tokens while preserving meaning.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Spell Correction Pipeline](#2-spell-correction-pipeline)
3. [Token Reduction Techniques — All Modes](#3-token-reduction-techniques--all-modes)
4. [Token Reduction Techniques — Balanced + Aggressive](#4-token-reduction-techniques--balanced--aggressive)
5. [Token Reduction Techniques — Aggressive Only](#5-token-reduction-techniques--aggressive-only)
6. [NLP-Powered Optimization](#6-nlp-powered-optimization)
7. [Multilingual Support](#7-multilingual-support)
8. [Algorithm Details](#8-algorithm-details)
9. [Benchmark Results](#9-benchmark-results)
10. [References & Research](#10-references--research)

---

## 1. Architecture Overview

Terse uses a **three-mode, multi-pass pipeline** that processes text through increasingly aggressive optimization stages. Each mode builds on the previous:

```
Input Text
    |
    v
[1] Spell Correction (all modes)
    |-- Hardcoded TYPOS dictionary (fast path, 400+ entries)
    |-- Norvig edit-distance corrector (keyboard-proximity weighted)
    |-- Context-aware real-word error correction (bigram analysis)
    |-- nspell/Hunspell fallback (full dictionary)
    |
    v
[2] Whitespace Compression (all modes)
    |
    v
[3] Pattern-Based Optimization (balanced + aggressive)
    |-- Self-context removal
    |-- Politeness/greeting stripping
    |-- Question-to-imperative conversion
    |-- Filler word removal
    |-- Hedging language removal
    |-- Meta-language removal
    |-- Phrase shortening (100+ patterns)
    |-- Vocabulary simplification
    |-- Relative clause compression
    |-- Modifier pair collapse
    |-- Passive voice removal
    |-- Formal contraction
    |
    v
[4] Redundancy Elimination (balanced + aggressive)
    |-- Sentence-level deduplication
    |-- Semantic clause deduplication (Jaccard similarity)
    |-- Repeated phrase compression (n-gram detection)
    |
    v
[5] NLP-Powered Optimization (balanced + aggressive)
    |-- POS-based adverb removal (compromise.js)
    |-- Passive-to-active voice conversion
    |-- Interjection removal (aggressive)
    |
    v
[6] Aggressive-Only Techniques
    |-- Technical abbreviations
    |-- Markdown stripping
    |-- Article removal
    |-- Extra abbreviations
    |-- Casual address/filler removal
    |-- Telegraph-style compression
    |-- Question consolidation
    |-- Low-information sentence dropping
    |
    v
[7] Final Cleanup
    |-- Whitespace normalization
    |-- Punctuation cleanup
    |-- Capitalization repair
    |-- Dangling conjunction removal
    |
    v
Output Text
```

### Three Optimization Modes

| Mode | Target Use | Typical Savings | Risk |
|------|-----------|----------------|------|
| **Soft (light)** | Typo correction + whitespace only | 0-5% | Zero meaning loss |
| **Normal (balanced)** | Filler, politeness, hedging, phrases | 20-50% | Minimal meaning loss |
| **Aggressive** | Everything + telegraph style, articles, abbreviations | 40-70% | May lose nuance |

---

## 2. Spell Correction Pipeline

Spell correction runs in ALL modes (including Soft/Light). It uses a four-stage pipeline:

### Stage 1: Hardcoded TYPOS Dictionary

**Algorithm**: O(1) hash-map lookup per word.

A curated dictionary of 400+ common typo-to-correction mappings, organized by category:

- **Keyboard-adjacent typos**: `swaht`->`what`, `mw`->`me`, `wiht`->`with` (keys physically near each other on QWERTY)
- **Transposition typos**: `soudl`->`should`, `taht`->`that`, `waht`->`what` (swapped adjacent letters)
- **Doubled/missing letters**: `goood`->`good`, `wrk`->`work`, `ned`->`need`
- **-ing suffix typos**: `workign`->`working`, `runnign`->`running` (all common verbs)
- **Programming terms**: `fucntion`->`function`, `databse`->`database`, `algortihm`->`algorithm`
- **Missing apostrophes**: `dont`->`don't`, `cant`->`can't`, `wouldnt`->`wouldn't`
- **Semicolon contractions**: `don;t`->`don't` (semicolon instead of apostrophe)
- **Internet shorthand**: `plz`->`please`, `bc`->`because`, `rly`->`really`, `ppl`->`people`
- **Compound splits**: `alot`->`a lot`, `aswell`->`as well`
- **Number substitutions**: `b4`->`before`, `2day`->`today`

**Why this exists**: Fastest possible correction for known patterns. Runs before any other correction and catches the most common typos instantly.

### Stage 2: Norvig Edit-Distance Corrector

**Algorithm**: Peter Norvig's spell corrector adapted with QWERTY keyboard proximity weighting.

**How it works**:

1. **Known-word check**: Word is checked against a set of ~3,000+ common English words (KNOWN_WORDS). If found, skip correction.
2. **External dictionary check**: If nspell (Hunspell) is loaded, check if the word is valid. If valid, skip.
3. **Safety guards**: Skip ALL-CAPS words (acronyms: TCP, UDP), Capitalized words (proper nouns: React, Python), words with dots/numbers (Node.js, v2).
4. **Edit-1 candidate generation**: Generate all strings within 1 edit of the input:
   - **Deletions**: Remove one character (`hello` -> `helo`, `ello`, `hllo`, `helo`, `hell`)
   - **Transpositions**: Swap adjacent characters (`hello` -> `ehllo`, `hlelo`, `hello`, `helol`)
   - **Replacements**: Replace one character with each letter a-z
   - **Insertions**: Insert each letter a-z at each position
   - For a 5-letter word, this generates ~280 candidates
5. **Candidate filtering**: Keep only candidates that are known words (in KNOWN_WORDS or nspell dictionary)
6. **QWERTY keyboard proximity scoring**: Candidates from keyboard-adjacent substitutions get a +200 score bonus:

```
QWERTY Layout Coordinates:
  q(0,0)  w(1,0)  e(2,0)  r(3,0)  t(4,0)  ...
   a(0.5,1) s(1.5,1) d(2.5,1) f(3.5,1) ...
    z(1,2)   x(2,2)   c(3,2)   v(4,2)  ...

keyDistance(a, b) = sqrt((row_a - row_b)^2 + (col_a - col_b)^2)
isAdjacent = keyDistance <= 1.5
```

7. **Edit-2 fallback**: If no edit-1 candidates found and word <= 7 chars, generate edit-2 candidates (edits of edits). Only accept candidates with frequency >= 400 (very common words).
8. **Ranking**: Sort candidates by `score` (word frequency + keyboard bonus) descending, then by edit distance ascending. Return the top candidate.

**Key design decision**: Edit-distance correction ONLY runs when nspell is available. Without an external dictionary, we can't distinguish uncommon-but-valid words from typos, so we rely solely on the TYPOS dictionary.

### Stage 3: Context-Aware Real-Word Error Correction

**Algorithm**: Bigram context analysis with confusion-set lookup.

This is the most novel technique — it catches **valid English words used in the wrong context** (e.g., "what souls I do" where "souls" should be "should").

**How it works**:

1. Tokenize text preserving whitespace
2. For each token, check against a curated **confusion set** (REAL_WORD_FIXES)
3. Each entry specifies: `{ wrong: "word", right: "correction", leftCtx: regex, rightCtx: regex }`
4. Build left context (6 tokens before) and right context (6 tokens after)
5. If BOTH context patterns match, apply the correction

**Example entries**:

| Wrong | Right | Left Context | Right Context |
|-------|-------|-------------|---------------|
| `souls` | `should` | `what\|i\|you\|we\|they` | `i\|you\|we\|they\|be\|do` |
| `whelp` | `help` | `please\|can\|to\|hey` | `me\|us\|with\|the` |
| `crap` | `craft` | `on\|of\|about\|the` | `what\|how\|and\|,` |
| `quantize` | `quantitative` | any | `research\|analysis\|data` |
| `dastard` | `standard` | any | any |
| `then` | `than` | comparative adjective | any |
| `loose` | `lose` | `will\|would\|to\|not` | any |
| `there` | `their` | any | possessive noun |

**Research basis**: This approach is inspired by the context-sensitive spell checking literature (Mays et al., 1991) and uses the insight that real-word errors can be detected by improbable word sequences.

### Stage 4: nspell/Hunspell Fallback

**Algorithm**: Hunspell dictionary lookup and suggestion.

If a word passes through Stages 1-3 uncorrected and nspell is loaded, try nspell's built-in `suggest()` method. This catches remaining misspellings using Hunspell's affix-based morphological analysis.

Supported languages: English, Spanish, French, German, Portuguese, Italian, Russian.

---

## 3. Token Reduction Techniques — All Modes

These run in Soft, Balanced, AND Aggressive modes.

### 3.1 Whitespace Compression

- Collapse 3+ consecutive newlines to 2
- Collapse 2+ consecutive spaces/tabs to 1
- Remove blank lines (whitespace-only lines)

**Typical savings**: 0-3%

---

## 4. Token Reduction Techniques — Balanced + Aggressive

### 4.1 Self-Context Removal

**What it does**: Strips self-referential preambles that waste tokens by telling the LLM about the user rather than the task.

**Patterns removed**:

| Pattern | Example |
|---------|---------|
| Self-introduction | "I am a developer working on..." |
| Project preamble | "I'm currently working on a project..." |
| Goal statements | "My goal is to..." |
| Seeking statements | "I'm looking for a way to..." |
| Know-how requests | "I want to know how..." |
| Context about self | "I have a project where I need..." |

**Algorithm**: Regex pattern matching with sentence-boundary awareness. Patterns are applied sequentially; each removes a specific self-referential structure.

### 4.2 Politeness & Greeting Removal

Strips social niceties that consume tokens but carry zero information for the LLM.

**Removed**:
- Greetings: "Hi", "Hello", "Hey there", "Dear assistant"
- Politeness: "please", "kindly", "if you don't mind"
- Appreciation: "I'd appreciate...", "Thank you so much", "Thanks in advance"
- Apologies: "Sorry to bother you", "Apologies for..."
- Hope phrases: "I hope this makes sense", "Let me know if you have questions"

### 4.3 Question-to-Imperative Conversion

**What it does**: Converts polite question forms to direct commands, which are shorter and equally effective for LLMs.

| Before | After |
|--------|-------|
| "Can you please help me write..." | "Write..." |
| "Could you explain how..." | "Explain how..." |
| "How do I..." | "How to..." |
| "What is the best way to..." | "Best way to..." |
| "Is it possible to..." | (removed) |
| "What should I start with?" | "Where to start?" |
| "What should I do next?" | "Next steps?" |

### 4.4 Filler Word Removal

Removes words that add no semantic content:

**Single words**: basically, essentially, actually, literally, really, very, quite, rather, somewhat, simply, obviously, clearly, certainly, definitely, absolutely, totally, completely, entirely, perfectly, honestly, frankly

**Phrases**: "I think that", "I believe that", "it seems like", "as a matter of fact", "at the end of the day", "the thing is", "for what it's worth", "as you know"

### 4.5 Hedging Language Removal

Strips uncertainty markers that LLMs don't need:

- "maybe", "perhaps", "possibly", "probably"
- "I'm not sure but", "if possible"
- "sort of", "kind of", "more or less"
- "I guess", "I suppose", "I imagine"

### 4.6 Meta-Language Removal

Removes self-referential instruction framing:

| Pattern | Replacement |
|---------|-------------|
| "I want you to..." | (removed) |
| "I want to..." / "I need to..." | (removed) |
| "The following is..." | (removed) |
| "Make sure to..." | (removed) |
| "Keep in mind that..." | (removed) |
| "What should I do..." | (removed) |
| "Tell me what/how to..." | (removed) |
| "Help me with it/this" | (removed) |

### 4.7 Phrase Shortening

**Algorithm**: Longest-match ordered replacement. 130+ verbose-to-concise phrase mappings sorted by pattern length (longest first to avoid partial matches).

**Categories**:

**Wordy prepositions** (30+ patterns):
| Verbose | Concise |
|---------|---------|
| "in the event that" | "if" |
| "due to the fact that" | "because" |
| "with regard to" | "about" |
| "in addition to" | "and" |
| "in close proximity to" | "near" |
| "by means of" | "using" |

**Nominalizations** (verb buried in noun phrase):
| Verbose | Concise |
|---------|---------|
| "make a decision" | "decide" |
| "give an explanation" | "explain" |
| "reach a conclusion" | "conclude" |
| "perform a search" | "search" |

**Casual/conversational** (30+ patterns):
| Verbose | Concise |
|---------|---------|
| "can you walk me through" | "explain" |
| "take a look at" | "check" |
| "get rid of" | "remove" |
| "come up with" | "create" |
| "figure out" | "determine" |
| "as quickly as possible" | "fast" |
| "I'm confused about" | (removed) |

### 4.8 Vocabulary Simplification

Replaces formal/academic words with shorter everyday equivalents:

| Formal | Simple |
|--------|--------|
| "utilize" | "use" |
| "facilitate" | "help" |
| "demonstrate" | "show" |
| "furthermore" | "also" |
| "consequently" | "so" |
| "approximately" | "about" |
| "commence" | "start" |
| "methodology" | "method" |
| "functionality" | "feature" |
| "significant" | "big" |

### 4.9 Relative Clause Compression

Removes unnecessary relative pronouns:

| Before | After |
|--------|-------|
| "files that are larger than" | "files larger than" |
| "the API, which is RESTful" | "the API, RESTful" |
| "users who are active" | "users active" |

### 4.10 Modifier Pair Collapse

Collapses redundant adjective pairs where one subsumes the other:

| Pair | Collapsed |
|------|-----------|
| "clear and concise" | "concise" |
| "simple and easy" | "simple" |
| "full and complete" | "complete" |
| "completely unique" | "unique" |
| "very essential" | "essential" |
| "extremely important" | "important" |

### 4.11 Passive Voice Indicators

Removes common passive constructions that add no information:

- "It should be noted that..." → (removed)
- "It has been determined that..." → (removed)
- "It is generally accepted that..." → (removed)
- "It is recommended to..." → (removed)

### 4.12 Formal Contraction

Contracts formal expansions to save tokens:

| Formal | Contracted |
|--------|-----------|
| "do not" | "don't" |
| "I am" | "I'm" |
| "you are" | "you're" |
| "it is" | "it's" |
| "I will" | "I'll" |
| "I would" | "I'd" |

### 4.13 Semantic Clause Deduplication

**Algorithm**: Jaccard similarity on word bags with comma/sentence splitting.

1. Split text on `.!?,;` boundaries into clauses
2. For each clause, create a word bag (set of words > 2 chars, lowercased)
3. Compare each new clause against all previously seen clauses
4. If Jaccard similarity > 0.40, drop the duplicate clause:

```
Jaccard(A, B) = |A ∩ B| / |A ∪ B|
```

**Example**: "what should I do to start" and "what should I start with" have high word overlap → second clause dropped.

### 4.14 Repeated Phrase Compression

**Algorithm**: N-gram frequency detection with first-occurrence preservation.

1. Split text into words
2. Scan for repeated 3-5 word sequences (trigrams through 5-grams)
3. Build a map of `phrase → first_occurrence_index`
4. For subsequent occurrences, mark word indices for removal
5. Reconstruct text with marked words removed

**Example**: "what should I do" appearing 3 times → only the first occurrence survives.

### 4.15 Numeral Conversion

Converts written numbers to digits:

| Word | Digit |
|------|-------|
| "one" | "1" |
| "twenty" | "20" |
| "hundred" | "100" |
| "thousand" | "1000" |

### 4.16 Structured Format Conversion

Converts ordinal preambles to numbered lists:

"The first thing is..." → "1. ..."
"The second point is..." → "2. ..."

---

## 5. Token Reduction Techniques — Aggressive Only

### 5.1 Technical Abbreviations

| Full | Abbreviated |
|------|------------|
| "function" | "fn" |
| "application" | "app" |
| "configuration" | "config" |
| "documentation" | "docs" |
| "repository" | "repo" |
| "information" | "info" |
| "environment" | "env" |
| "development" | "dev" |
| "authentication" | "auth" |
| "database" | "DB" |

### 5.2 Extra Abbreviations

| Full | Abbreviated |
|------|------------|
| "for example" | "e.g." |
| "approximately" | "~" |
| "maximum" | "max" |
| "minimum" | "min" |
| "specification" | "spec" |
| "temporary" | "temp" |
| "previous" | "prev" |
| "source" | "src" |
| "message" | "msg" |
| "response" | "resp" |
| "implementation" | "impl" |
| "performance" | "perf" |

### 5.3 Markdown Noise Stripping

Removes formatting that wastes tokens when the LLM doesn't need visual styling:

- `**bold**` → `bold`
- `*italic*` → `italic`
- `# Heading` → `Heading`

Code blocks are preserved (protected via placeholder substitution during all transformations).

### 5.4 Article Removal

Selectively removes "the", "a", "an" before common instruction-context nouns:

- "the following code" → "following code"
- "a list of items" → "list of items"

**Safety**: Only removes before a curated whitelist of ~50 common nouns (code, file, data, function, method, list, etc.) to avoid breaking meaning.

### 5.5 Casual Address & Filler Removal

Strips conversational noise:

- **Address terms**: "babe", "dude", "bro", "buddy", "mate", "fam"
- **Interjections**: "hey", "oh", "wow", "hmm", "umm", "uh"
- **Verbal tics**: "you know", "I mean", "like I said"
- **Tag questions**: ", right?", ", yeah?", ", ok?"

### 5.6 Telegraph-Style Compression

**Research basis**: Inspired by LLMLingua's token-level information scoring, but implemented as deterministic rules. The key insight: LLMs can reconstruct meaning from content words alone, much like telegraph messages.

**Pronoun dropping**:
- "I want" → "want"
- "I tried" → "tried"
- "I checked" → "checked"

**Copula verb dropping**:
- "It is important" → "important"
- "There are many options" → "many options"
- "I am trying" → "trying"

**Discourse marker dropping**:
- "You can use" → "use"
- "We need to" → (removed)
- "What you want to do is" → (removed)

**Time reference dropping**:
- "I've been working for a week" → (removed entirely)
- "for like a month" → (removed)

**Hedging opener dropping**:
- "OK so basically" → (removed)
- "The thing is" → (removed)
- "That being said" → (removed)

**Verbose self-reference compression**:
- "I've tried everything I can think of" → "tried everything"
- "I can't figure out" → "can't find"
- "I even tried restarting" → "tried restarting"
- "any advice you could give me" → "advice"

### 5.7 Question Consolidation

**Algorithm**: Word-overlap clustering with shortest-representative selection.

1. Extract all question segments (text ending in `?`)
2. For each pair of questions, compute word overlap:
   ```
   overlap = |words_A ∩ words_B| / min(|words_A|, |words_B|)
   ```
3. Group questions with overlap >= 0.4 into clusters
4. For each cluster with 2+ questions, keep only the **shortest** question (most concise phrasing)
5. Remove all other questions in the cluster from the text

**Example**:
- "How do I learn Python?" (5 words)
- "What is the best way to learn programming?" (8 words)
- "Where should I start learning to code?" (7 words)

Cluster overlap is high → keep "How do I learn Python?" (shortest), drop the other two.

### 5.8 Low-Information Sentence Dropping

**Algorithm**: Content-word ratio scoring (lightweight self-information heuristic).

This is a simplified, rule-based approximation of LLMLingua's perplexity-based token scoring, using word-class frequency instead of a language model.

1. Split text into sentences
2. For each sentence, compute:
   ```
   content_ratio = |content_words| / |total_words|
   ```
   Where `content_words` = words NOT in a 100-word filler set AND length > 2 chars

3. The filler set includes: pronouns (I, me, you, we, it), determiners (the, a, an), auxiliary verbs (is, am, are, was, have, do), prepositions (to, of, in, for, on, with), conjunctions (and, but, or, if), and common light verbs (want, need, know, think, get, go, make)

4. Drop sentences where:
   - `content_ratio < 0.10` AND `word_count < 8` (almost pure filler)
   - `word_count < 3` (tiny fragment after other processing)

5. **Safety**: Never drop the first sentence (always contains the main request)

**Example**: "I would really appreciate any advice you could give me." has content_ratio = 1/11 = 0.09 (only "advice" is a content word) → dropped.

---

## 6. NLP-Powered Optimization

Uses the [compromise.js](https://github.com/spencermountain/compromise) NLP library for part-of-speech analysis.

### 6.1 Adverb Removal (Balanced + Aggressive)

**Algorithm**: POS tagging via compromise, then selective removal.

1. Parse text with compromise NLP
2. Find all adverbs (#Adverb tag)
3. Filter against a **keep list** of essential adverbs: "not", "never", "always", "only", "also", "still", "here", "there", "when", "how", "then", "now", etc.
4. Remove all other adverbs (these typically add emphasis but not meaning)

**Example**: "The server is currently actively processing requests" → "The server is processing requests"

### 6.2 Passive-to-Active Voice (Balanced + Aggressive)

Uses compromise's `.verbs().toActive()` to convert passive constructions:

"The file was uploaded by the user" → "The user uploaded the file"

### 6.3 Interjection Removal (Aggressive only)

Removes tagged #Interjection words: "oh", "wow", "well", "ugh", etc.

---

## 7. Multilingual Support

### 7.1 Language Detection

**Algorithm**: Hybrid approach combining character-range detection and franc (ISO 639-3).

1. **Fast CJK detection**: Count Chinese (U+4E00-9FFF), Japanese (U+3040-30FF), Korean (UAC00-D7AF) characters. If ratio > threshold, classify directly.
2. **franc fallback**: For non-CJK text, use the franc-min library for statistical language classification.
3. **Mapping**: franc's ISO 639-3 codes mapped to 2-letter codes (eng→en, spa→es, etc.)

### 7.2 Multilingual Spell Checking

- nspell (Hunspell) dictionaries loaded per detected language
- Supported: English, Spanish, French, German, Portuguese, Italian, Russian

### 7.3 Multilingual Politeness Removal

Curated patterns for 10 languages:

| Language | Greetings | Politeness | Closings |
|----------|-----------|------------|----------|
| French | "bonjour", "salut" | "s'il vous plait" | "merci", "cordialement" |
| Spanish | "hola", "buenos dias" | "por favor" | "gracias", "muchas gracias" |
| German | "hallo", "guten tag" | "bitte", "konnten sie" | "vielen dank" |
| Chinese | "你好", "您好" | "请", "麻烦" | "谢谢", "非常感谢" |
| Japanese | "こんにちは" | "お願いします" | "ありがとうございます" |
| Korean | "안녕하세요" | "부탁드립니다" | "감사합니다" |
| + Portuguese, Italian, Russian | ... | ... | ... |

### 7.4 Multilingual Stopword Removal (Aggressive)

Uses the `stopword` library's per-language lists. Safety: only applies if filtered result retains >= 60% of original word count.

---

## 8. Algorithm Details

### 8.1 Token Estimation

Terse uses a heuristic token estimator (no tokenizer dependency):

```
For Latin text:  tokens = words * 1.3 + punctuation * 0.5
For CJK text:    tokens = cjk_chars * 1.5 + words * 1.3 + punctuation * 0.5
```

This approximates GPT/Claude tokenization within ~10% accuracy.

### 8.2 Code Block Protection

All transformations protect code blocks from modification:

1. Replace `` ```...``` `` blocks with `__CB_N__` placeholders
2. Run all optimizations on placeholder-substituted text
3. Restore original code blocks from placeholders

### 8.3 Processing Order Rationale

The technique ordering is carefully designed:

1. **Typos first**: Correcting typos allows subsequent pattern-matching to work (e.g., "plese" must become "please" before politeness removal can match it)
2. **Self-context before politeness**: "I have a project where I need..." should be caught as self-context before politeness strips "I need"
3. **Phrase shortening before NLP**: Rule-based patterns are faster and more predictable than NLP
4. **NLP after rules**: compromise.js catches patterns that regex can't (POS-dependent adverb removal)
5. **Aggressive techniques last**: Lossy techniques (article removal, telegraph) run after lossless ones
6. **Deduplication near the end**: Earlier techniques may create new duplicates that need catching

### 8.4 Safety Mechanisms

- **Minimum text threshold**: Texts < 3 words are returned unchanged
- **Code protection**: Code blocks are never modified
- **First-sentence preservation**: Low-info dropping never removes the first sentence
- **Acronym preservation**: ALL-CAPS words are never spell-corrected
- **Proper noun preservation**: Capitalized words are never spell-corrected
- **60% floor on stopword removal**: Prevents over-aggressive stopword stripping
- **Edit-distance conservative mode**: Without nspell loaded, edit-distance correction is disabled to prevent false corrections

---

## 9. Benchmark Results

Tested on representative prompt types (Aggressive mode):

| Prompt Type | Original Tokens | Optimized Tokens | Savings |
|-------------|----------------|-----------------|---------|
| Typo-heavy rambling | 68 | 33 | **51%** |
| Verbose Docker question | 100 | 40 | **60%** |
| Chatty debug request | 112 | 61 | **46%** |
| Mixed typos + filler | 28 | 10 | **64%** |
| Well-written (balanced mode) | 51 | 19 | **63%** |
| Repeated questions | 43 | 31 | **28%** |
| Clean technical prompt | 18 | 18 | **0%** (correct) |
| Light mode (typos only) | — | — | Preserves structure |

---

## 10. References & Research

### Academic Papers

- **Peter Norvig, "How to Write a Spelling Corrector"** (2007) — Foundation for the edit-distance corrector. [norvig.com/spell-correct.html](https://norvig.com/spell-correct.html)
- **Wolf Garbe, "SymSpell: 1 million times faster spelling correction"** (2012) — Symmetric delete algorithm that inspired our approach. [github.com/wolfgarbe/SymSpell](https://github.com/wolfgarbe/SymSpell)
- **Jiang et al., "LLMLingua: Compressing Prompts for Accelerated Inference"** (EMNLP 2023) — Self-information scoring for token-level compression; our telegraph-style and low-info dropping are rule-based approximations. [arxiv.org/abs/2310.05736](https://arxiv.org/abs/2310.05736)
- **Pan et al., "LLMLingua-2: Data Distillation for Efficient Prompt Compression"** (ACL 2024) — Token classification approach; JS implementation available at [@atjsh/llmlingua-2](https://www.npmjs.com/package/@atjsh/llmlingua-2)
- **Li et al., "Selective Context"** (2023) — Self-information filtering for redundant tokens
- **Li et al., "Prompt Compression for Large Language Models: A Survey"** (NAACL 2025) — Comprehensive taxonomy of compression techniques. [arxiv.org/abs/2410.12388](https://arxiv.org/abs/2410.12388)
- **Mays et al., "Context-based spelling correction"** (1991) — Foundation for real-word error detection using word n-gram probabilities

### Tools & Libraries Used

- **[compromise.js](https://github.com/spencermountain/compromise)** — Lightweight NLP for POS tagging, adverb detection, voice conversion
- **[nspell](https://github.com/wooorm/nspell)** — JavaScript Hunspell implementation for dictionary-based spell checking
- **[franc-min](https://github.com/wooorm/franc)** — Language detection from text
- **[stopword](https://github.com/fergiemcdowall/stopword)** — Multilingual stopword lists

### Technique Origins

| Technique | Inspiration |
|-----------|-------------|
| Telegraph compression | LLMLingua's perplexity-based filtering, adapted as rule-based |
| Phrase shortening | Classical readability research (Flesch, Gunning) |
| Question consolidation | Information retrieval query deduplication |
| Semantic dedup | Jaccard similarity from set theory / IR |
| Repeated phrase detection | N-gram analysis from computational linguistics |
| Keyboard proximity | Typo-distance models (Damerau-Levenshtein with weighted edits) |
| Real-word correction | Context-sensitive spell checking (Mays et al., 1991) |
| Low-info dropping | TF-IDF / self-information scoring, simplified |
| Content-word ratio | Information density metrics from corpus linguistics |

---

*Document generated for Terse v1.0 — March 2026*
