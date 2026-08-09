//! Knowledge Graph store — the persistent model + serialization for Terse's
//! Graphify-style code knowledge graph, plus the two things that make it a
//! *Terse* feature rather than a clone:
//!
//!   1. an **overlay** layer so a human's manual edits (renames, hand-drawn
//!      edges, concept notes, hide/pin) survive every automatic re-extraction —
//!      extraction owns code-derived facts, the overlay owns human annotations,
//!      and [`merge`] combines them on read; and
//!   2. a **token-optimized digest** ([`write_digest`]) — a compact `.terse/graph.md`
//!      that an agent reads *instead of* grepping and reading whole files, plus a
//!      pointer block dropped into the repo's `CLAUDE.md`.
//!
//! The extractor lives in `graph_extract.rs`; this module is pure logic (no
//! Tauri) so it can be unit-tested. Persistence lives under `~/.terse/graph/`:
//!   - `<repo_hash>.json`         full extracted graph
//!   - `<repo_hash>.overlay.json` the human overlay
//!   - `state.json`               last-opened repo + watch flag

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

// ── Data model (mirrors Graphify's node/edge taxonomy + confidence tags) ──────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    Function,
    Method,
    Class,
    Module,
    Variable,
    Comment,
    Doc,
    External,
    /// User-authored note node (overlay only) — has no code location.
    Concept,
}

impl NodeKind {
    pub fn short(&self) -> &'static str {
        match self {
            NodeKind::Function => "fn",
            NodeKind::Method => "method",
            NodeKind::Class => "class",
            NodeKind::Module => "mod",
            NodeKind::Variable => "var",
            NodeKind::Comment => "note",
            NodeKind::Doc => "doc",
            NodeKind::External => "ext",
            NodeKind::Concept => "concept",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EdgeKind {
    Calls,
    Imports,
    Inherits,
    Uses,
    References,
    Method,
}

impl EdgeKind {
    pub fn short(&self) -> &'static str {
        match self {
            EdgeKind::Calls => "calls",
            EdgeKind::Imports => "imp",
            EdgeKind::Inherits => "inherits",
            EdgeKind::Uses => "uses",
            EdgeKind::References => "ref",
            EdgeKind::Method => "methods",
        }
    }
}

/// Graphify tags every edge as either explicit in source or resolved by
/// inference. We keep the exact same two-value vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Confidence {
    Extracted,
    Inferred,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Node {
    pub id: String,
    pub kind: NodeKind,
    pub name: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub line: u32,
    #[serde(default)]
    pub lang: String,
    #[serde(default)]
    pub community: Option<u32>,
    #[serde(default)]
    pub degree: u32,
    /// True for overlay-authored nodes (concepts) so the UI can style them.
    #[serde(default)]
    pub manual: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Edge {
    pub src: String,
    pub dst: String,
    pub kind: EdgeKind,
    pub confidence: Confidence,
    #[serde(default)]
    pub manual: bool,
}

impl Edge {
    /// Stable identity used for overlay add/remove bookkeeping.
    pub fn key(&self) -> String {
        format!("{}\u{1}{}\u{1}{}", self.src, self.dst, self.kind.short())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Community {
    pub id: u32,
    pub label: String,
    #[serde(default)]
    pub members: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct KnowledgeGraph {
    pub repo: String,
    pub repo_hash: String,
    #[serde(default)]
    pub built_at: u64,
    #[serde(default)]
    pub nodes: Vec<Node>,
    #[serde(default)]
    pub edges: Vec<Edge>,
    #[serde(default)]
    pub communities: Vec<Community>,
    #[serde(default)]
    pub lang_counts: HashMap<String, u32>,
    #[serde(default)]
    pub file_count: u32,
    /// Total bytes of source scanned — the basis for the token-saved estimate
    /// (what an agent would have paid to read those files instead of the digest).
    #[serde(default)]
    pub source_bytes: u64,
}

// ── Overlay: human edits that survive re-extraction ───────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ConceptNote {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub note: String,
    /// Node ids this concept is attached to (rendered as `uses` edges).
    #[serde(default)]
    pub links: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GraphOverlay {
    /// node id → user-chosen display name.
    #[serde(default)]
    pub renames: HashMap<String, String>,
    /// Hand-drawn edges (always tagged manual).
    #[serde(default)]
    pub added_edges: Vec<Edge>,
    /// Edge keys ([`Edge::key`]) the user removed from view.
    #[serde(default)]
    pub removed_edges: Vec<String>,
    /// Node ids hidden from the graph.
    #[serde(default)]
    pub hidden: Vec<String>,
    /// Node ids pinned (kept even when filters would drop them).
    #[serde(default)]
    pub pinned: Vec<String>,
    /// Free-standing concept notes authored by the user.
    #[serde(default)]
    pub notes: Vec<ConceptNote>,
}

// ── Registry: every repo Terse knows a graph for (auto-detected + manual) ─────

/// One tracked repository. Persisted so the last-viewed graph re-opens instantly
/// from cache and the switcher can list every known graph without a rescan.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RepoEntry {
    pub repo: String,
    pub hash: String,
    /// "auto" (detected from an agent's cwd) or "manual" (user-added folder).
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub built_at: u64,
    #[serde(default)]
    pub nodes: u32,
    #[serde(default)]
    pub edges: u32,
    #[serde(default)]
    pub files: u32,
    #[serde(default)]
    pub tokens_saved: u64,
    /// Last time an agent was seen working here.
    #[serde(default)]
    pub last_active: u64,
    /// Last time the user opened this graph in the UI.
    #[serde(default)]
    pub last_viewed: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Registry {
    #[serde(default)]
    pub repos: Vec<RepoEntry>,
    #[serde(default)]
    pub last_viewed: Option<String>,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Runtime state held in `AppState`: the loaded repo, watch flag, and the
/// on-disk registry of all known graphs.
pub struct GraphState {
    pub current_repo: Option<PathBuf>,
    pub watching: bool,
    pub registry: Registry,
    /// Throttle for last_active checkpoint writes (see upsert_active).
    last_active_flush: u64,
}

impl GraphState {
    pub fn new() -> Self {
        let registry = load_registry();
        let current_repo = registry
            .last_viewed
            .clone()
            .or_else(|| {
                load_state()
                    .get("currentRepo")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(String::from)
            })
            .map(PathBuf::from);
        GraphState { current_repo, watching: false, registry, last_active_flush: 0 }
    }

    pub fn set_repo(&mut self, repo: &Path) {
        self.current_repo = Some(repo.to_path_buf());
        save_state(&serde_json::json!({ "currentRepo": repo.to_string_lossy() }));
    }

    fn persist(&self) {
        save_registry(&self.registry);
    }

    /// Add a repo if unknown; `manual` upgrades but never downgrades the source.
    pub fn upsert(&mut self, repo: &Path, source: &str) {
        let rs = repo.to_string_lossy().to_string();
        if let Some(e) = self.registry.repos.iter_mut().find(|e| e.repo == rs) {
            if source == "manual" {
                e.source = "manual".into();
            }
        } else {
            self.registry.repos.push(RepoEntry {
                repo: rs,
                hash: repo_hash(repo),
                source: source.to_string(),
                ..Default::default()
            });
        }
        self.persist();
    }

    /// Bulk-register detected active repos and stamp their activity. Only writes
    /// to disk when the set actually changed (this runs on every graph_list call).
    pub fn upsert_active(&mut self, repos: &[String]) {
        let now = now_secs();
        let mut added = false;
        for r in repos {
            let path = Path::new(r);
            if let Some(e) = self.registry.repos.iter_mut().find(|e| &e.repo == r) {
                e.last_active = now;
            } else {
                self.registry.repos.push(RepoEntry {
                    repo: r.clone(),
                    hash: repo_hash(path),
                    source: "auto".into(),
                    last_active: now,
                    ..Default::default()
                });
                added = true;
            }
        }
        // Persist on new repos, or roughly once a minute to checkpoint last_active.
        if added || now.saturating_sub(self.last_active_flush) > 60 {
            self.last_active_flush = now;
            self.persist();
        }
    }

    pub fn mark_built(&mut self, g: &KnowledgeGraph, tokens_saved: u64) {
        let mut changed = false;
        if let Some(e) = self.registry.repos.iter_mut().find(|e| e.hash == g.repo_hash) {
            e.built_at = g.built_at;
            e.nodes = g.nodes.len() as u32;
            e.edges = g.edges.len() as u32;
            e.files = g.file_count;
            e.tokens_saved = tokens_saved;
            changed = true;
        }
        if changed {
            self.persist();
        }
    }

    pub fn set_viewed(&mut self, repo: &Path) {
        let rs = repo.to_string_lossy().to_string();
        self.registry.last_viewed = Some(rs.clone());
        let now = now_secs();
        if let Some(e) = self.registry.repos.iter_mut().find(|e| e.repo == rs) {
            e.last_viewed = now;
        }
        self.persist();
    }

    pub fn remove(&mut self, repo: &Path) {
        let rs = repo.to_string_lossy().to_string();
        self.registry.repos.retain(|e| e.repo != rs);
        if self.registry.last_viewed.as_deref() == Some(rs.as_str()) {
            self.registry.last_viewed = None;
        }
        self.persist();
    }
}

impl Default for GraphState {
    fn default() -> Self {
        Self::new()
    }
}

// ── Paths & persistence ───────────────────────────────────────────────────────

pub fn graph_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".terse").join("graph")
}

/// Short, filesystem-safe hash of the absolute repo path.
pub fn repo_hash(repo: &Path) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(repo.to_string_lossy().as_bytes());
    let out = h.finalize();
    hex16(&out)
}

fn hex16(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(16);
    for b in bytes.iter().take(8) {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

fn graph_json_path(hash: &str) -> PathBuf {
    graph_dir().join(format!("{}.json", hash))
}

fn overlay_json_path(hash: &str) -> PathBuf {
    graph_dir().join(format!("{}.overlay.json", hash))
}

fn state_path() -> PathBuf {
    graph_dir().join("state.json")
}

fn registry_path() -> PathBuf {
    graph_dir().join("registry.json")
}

pub fn load_registry() -> Registry {
    fs::read_to_string(registry_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_registry(r: &Registry) {
    let _ = fs::create_dir_all(graph_dir());
    if let Ok(s) = serde_json::to_string_pretty(r) {
        let _ = fs::write(registry_path(), s);
    }
}

/// True if a built graph is cached on disk for this repo hash.
pub fn cache_exists(hash: &str) -> bool {
    graph_json_path(hash).exists()
}

/// Remove the cached graph + overlay for a repo hash (registry entry handled separately).
pub fn delete_cache(hash: &str) {
    let _ = fs::remove_file(graph_json_path(hash));
    let _ = fs::remove_file(overlay_json_path(hash));
}

fn load_state() -> serde_json::Value {
    fs::read_to_string(state_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

fn save_state(v: &serde_json::Value) {
    let _ = fs::create_dir_all(graph_dir());
    if let Ok(s) = serde_json::to_string_pretty(v) {
        let _ = fs::write(state_path(), s);
    }
}

pub fn save_graph(g: &KnowledgeGraph) {
    let _ = fs::create_dir_all(graph_dir());
    if let Ok(json) = serde_json::to_string(g) {
        let _ = fs::write(graph_json_path(&g.repo_hash), json);
    }
}

pub fn load_graph(hash: &str) -> Option<KnowledgeGraph> {
    fs::read_to_string(graph_json_path(hash))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}

pub fn load_overlay(hash: &str) -> GraphOverlay {
    fs::read_to_string(overlay_json_path(hash))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_overlay(hash: &str, overlay: &GraphOverlay) {
    let _ = fs::create_dir_all(graph_dir());
    if let Ok(json) = serde_json::to_string_pretty(overlay) {
        let _ = fs::write(overlay_json_path(hash), json);
    }
}

// ── Merge: extracted graph + human overlay = the view everyone reads ──────────

/// Apply the overlay on top of the extracted graph. Renames adjust display
/// names, hidden nodes (and their edges) drop out, removed edges drop out,
/// hand-drawn edges and concept notes are added. Never mutates the inputs.
pub fn merge(graph: &KnowledgeGraph, overlay: &GraphOverlay) -> KnowledgeGraph {
    let hidden: HashSet<&String> = overlay.hidden.iter().collect();
    let removed: HashSet<&String> = overlay.removed_edges.iter().collect();
    let pinned: HashSet<&String> = overlay.pinned.iter().collect();

    let mut nodes: Vec<Node> = graph
        .nodes
        .iter()
        .filter(|n| !hidden.contains(&n.id))
        .cloned()
        .map(|mut n| {
            if let Some(new_name) = overlay.renames.get(&n.id) {
                n.name = new_name.clone();
            }
            n
        })
        .collect();

    // Concept notes become first-class nodes.
    for note in &overlay.notes {
        nodes.push(Node {
            id: note.id.clone(),
            kind: NodeKind::Concept,
            name: note.name.clone(),
            path: String::new(),
            line: 0,
            lang: String::new(),
            community: None,
            degree: note.links.len() as u32,
            manual: true,
        });
    }

    let live: HashSet<String> = nodes.iter().map(|n| n.id.clone()).collect();

    let mut edges: Vec<Edge> = graph
        .edges
        .iter()
        .filter(|e| !removed.contains(&e.key()))
        .filter(|e| live.contains(&e.src) && live.contains(&e.dst))
        .cloned()
        .collect();

    for e in &overlay.added_edges {
        let mut e = e.clone();
        e.manual = true;
        if live.contains(&e.src) && live.contains(&e.dst) {
            edges.push(e);
        }
    }
    // Concept → target links, drawn as `uses` edges.
    for note in &overlay.notes {
        for target in &note.links {
            if live.contains(target) {
                edges.push(Edge {
                    src: note.id.clone(),
                    dst: target.clone(),
                    kind: EdgeKind::Uses,
                    confidence: Confidence::Extracted,
                    manual: true,
                });
            }
        }
    }

    // Recompute degree over the merged edge set so god-node ranking stays honest.
    let mut deg: HashMap<String, u32> = HashMap::new();
    for e in &edges {
        *deg.entry(e.src.clone()).or_default() += 1;
        *deg.entry(e.dst.clone()).or_default() += 1;
    }
    for n in &mut nodes {
        n.degree = deg.get(&n.id).copied().unwrap_or(0);
    }

    // Communities filtered to surviving members.
    let communities: Vec<Community> = graph
        .communities
        .iter()
        .cloned()
        .map(|mut c| {
            c.members.retain(|m| live.contains(m));
            c
        })
        .filter(|c| !c.members.is_empty())
        .collect();

    let _ = pinned; // pinning is a render hint the UI consumes from the overlay directly.

    KnowledgeGraph {
        repo: graph.repo.clone(),
        repo_hash: graph.repo_hash.clone(),
        built_at: graph.built_at,
        nodes,
        edges,
        communities,
        lang_counts: graph.lang_counts.clone(),
        file_count: graph.file_count,
        source_bytes: graph.source_bytes,
    }
}

// ── Token-optimized digest: what the agent reads instead of the files ─────────

/// Rough token estimate (~4 chars/token) — good enough for a savings headline.
pub fn est_tokens(s: &str) -> u64 {
    (s.chars().count() as u64 + 3) / 4
}

pub struct DigestResult {
    pub digest: String,
    pub digest_path: PathBuf,
    /// Estimated tokens an agent would spend reading the scanned source.
    pub source_tokens: u64,
    /// Tokens the digest itself costs.
    pub digest_tokens: u64,
}

impl DigestResult {
    pub fn tokens_saved(&self) -> u64 {
        self.source_tokens.saturating_sub(self.digest_tokens)
    }
}

const CLAUDE_MD_BEGIN: &str = "<!-- TERSE-GRAPH:BEGIN -->";
const CLAUDE_MD_END: &str = "<!-- TERSE-GRAPH:END -->";

/// Render the compact digest, write it to `<repo>/.terse/graph.md`, and refresh
/// the pointer block in the repo's `CLAUDE.md` (created if absent). The `merged`
/// graph should already have the overlay applied.
pub fn write_digest(repo: &Path, merged: &KnowledgeGraph) -> std::io::Result<DigestResult> {
    let digest = render_digest(merged);

    let terse_dir = repo.join(".terse");
    fs::create_dir_all(&terse_dir)?;
    let digest_path = terse_dir.join("graph.md");
    fs::write(&digest_path, &digest)?;

    update_claude_md_pointer(repo);

    let source_tokens = merged.source_bytes / 4;
    let digest_tokens = est_tokens(&digest);
    Ok(DigestResult { digest, digest_path, source_tokens, digest_tokens })
}

/// The compact text. One line per code symbol; no bodies, no prose, abbreviated
/// edge labels, INFERRED links flagged with a trailing `?`.
pub fn render_digest(g: &KnowledgeGraph) -> String {
    let by_id: HashMap<&str, &Node> = g.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let name_of = |id: &str| -> String {
        by_id.get(id).map(|n| n.name.clone()).unwrap_or_else(|| id.to_string())
    };

    // Group outgoing edges per source node, keyed by edge kind.
    let mut out: HashMap<&str, HashMap<&'static str, Vec<String>>> = HashMap::new();
    for e in &g.edges {
        let label = {
            let n = name_of(&e.dst);
            if e.confidence == Confidence::Inferred {
                format!("{}?", n)
            } else {
                n.to_string()
            }
        };
        out.entry(e.src.as_str())
            .or_default()
            .entry(e.kind.short())
            .or_default()
            .push(label);
    }

    let mut s = String::new();
    let repo_name = Path::new(&g.repo)
        .file_name()
        .map(|x| x.to_string_lossy().to_string())
        .unwrap_or_else(|| g.repo.clone());
    let symbol_count = g
        .nodes
        .iter()
        .filter(|n| !matches!(n.kind, NodeKind::External))
        .count();

    s.push_str(&format!("# Terse Knowledge Graph — {}\n", repo_name));
    s.push_str(&format!(
        "# {} symbols · {} edges · {} clusters · {} files\n",
        symbol_count,
        g.edges.len(),
        g.communities.len(),
        g.file_count
    ));
    s.push_str("# Read this instead of grepping. Line = path › Name(kind) Cn → edges. `?`=inferred. Cn=cluster id.\n\n");

    // Clusters, with a suggested entry point (highest-degree member).
    if !g.communities.is_empty() {
        s.push_str("## Clusters\n");
        let mut comms = g.communities.clone();
        comms.sort_by_key(|c| c.id);
        for c in &comms {
            let entry = c
                .members
                .iter()
                .filter_map(|m| by_id.get(m.as_str()))
                .max_by_key(|n| n.degree)
                .map(|n| n.name.as_str())
                .unwrap_or("");
            let sample: Vec<&str> = c
                .members
                .iter()
                .filter_map(|m| by_id.get(m.as_str()))
                .filter(|n| !matches!(n.kind, NodeKind::External))
                .take(6)
                .map(|n| n.name.as_str())
                .collect();
            s.push_str(&format!(
                "C{} {}: {}{}\n",
                c.id,
                c.label,
                sample.join(", "),
                if entry.is_empty() { String::new() } else { format!("  (entry: {})", entry) }
            ));
        }
        s.push('\n');
    }

    // Symbols, grouped by file for locality.
    s.push_str("## Symbols\n");
    let mut symbols: Vec<&Node> = g
        .nodes
        .iter()
        .filter(|n| !matches!(n.kind, NodeKind::External | NodeKind::Concept))
        .collect();
    symbols.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)));
    let mut last_path = "";
    for n in symbols {
        if n.path != last_path {
            s.push_str(&format!("\n# {}\n", n.path));
            last_path = &n.path;
        }
        let cn = n.community.map(|c| format!(" C{}", c)).unwrap_or_default();
        let mut line = format!("{}({}){}", n.name, n.kind.short(), cn);
        if let Some(edges) = out.get(n.id.as_str()) {
            let mut kinds: Vec<(&&'static str, &Vec<String>)> = edges.iter().collect();
            kinds.sort_by_key(|(k, _)| *k);
            let parts: Vec<String> = kinds
                .iter()
                .map(|(k, vals)| format!("{}:{}", k, dedup(vals).join(",")))
                .collect();
            if !parts.is_empty() {
                line.push_str(" → ");
                line.push_str(&parts.join(" "));
            }
        }
        s.push_str(&line);
        s.push('\n');
    }
    s.push('\n');

    // God nodes — the most connected symbols, where reading pays off most.
    let mut ranked: Vec<&Node> = g
        .nodes
        .iter()
        .filter(|n| !matches!(n.kind, NodeKind::External))
        .collect();
    ranked.sort_by(|a, b| b.degree.cmp(&a.degree));
    let gods: Vec<String> = ranked
        .iter()
        .filter(|n| n.degree > 0)
        .take(12)
        .map(|n| format!("{}({})", n.name, n.degree))
        .collect();
    if !gods.is_empty() {
        s.push_str("## Hubs (most connected)\n");
        s.push_str(&gods.join(" · "));
        s.push('\n');
    }

    // User concept notes.
    let notes: Vec<&Node> = g.nodes.iter().filter(|n| matches!(n.kind, NodeKind::Concept)).collect();
    if !notes.is_empty() {
        s.push_str("\n## Concepts (human notes)\n");
        for n in notes {
            s.push_str(&format!("- {}\n", n.name));
        }
    }

    s
}

fn dedup(v: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    v.iter().filter(|x| seen.insert((*x).clone())).cloned().collect()
}

/// Idempotently insert/refresh the Terse pointer block in `<repo>/CLAUDE.md`.
fn update_claude_md_pointer(repo: &Path) {
    let block = format!(
        "{begin}\n\
## 🗺️ Terse Knowledge Graph\n\
A compact, always-current map of this repo's symbols and how they connect lives at `.terse/graph.md`.\n\
**Before grepping or reading files to understand structure, read `.terse/graph.md` first** — it lists every function/class, what it calls, and how modules relate, at a fraction of the token cost. Terse keeps it up to date automatically.\n\
{end}",
        begin = CLAUDE_MD_BEGIN,
        end = CLAUDE_MD_END
    );

    let path = repo.join("CLAUDE.md");
    let existing = fs::read_to_string(&path).unwrap_or_default();

    let updated = if let (Some(start), Some(end)) =
        (existing.find(CLAUDE_MD_BEGIN), existing.find(CLAUDE_MD_END))
    {
        if end >= start {
            let end = end + CLAUDE_MD_END.len();
            let mut s = String::new();
            s.push_str(&existing[..start]);
            s.push_str(&block);
            s.push_str(&existing[end..]);
            s
        } else {
            format!("{}\n\n{}\n", existing.trim_end(), block)
        }
    } else if existing.trim().is_empty() {
        format!("{}\n", block)
    } else {
        format!("{}\n\n{}\n", existing.trim_end(), block)
    };

    let _ = fs::write(&path, updated);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(id: &str, name: &str, kind: NodeKind) -> Node {
        Node {
            id: id.into(),
            kind,
            name: name.into(),
            path: "src/a.js".into(),
            line: 1,
            lang: "js".into(),
            community: Some(0),
            degree: 0,
            manual: false,
        }
    }

    #[test]
    fn merge_applies_rename_hide_and_concept() {
        let g = KnowledgeGraph {
            repo: "/tmp/x".into(),
            repo_hash: "abc".into(),
            nodes: vec![n("a", "foo", NodeKind::Function), n("b", "bar", NodeKind::Function)],
            edges: vec![Edge {
                src: "a".into(),
                dst: "b".into(),
                kind: EdgeKind::Calls,
                confidence: Confidence::Extracted,
                manual: false,
            }],
            ..Default::default()
        };
        let mut overlay = GraphOverlay::default();
        overlay.renames.insert("a".into(), "renamed".into());
        overlay.hidden.push("b".into());
        overlay.notes.push(ConceptNote {
            id: "concept:1".into(),
            name: "Auth flow".into(),
            note: "how login works".into(),
            links: vec!["a".into()],
        });

        let m = merge(&g, &overlay);
        // b hidden → its calls edge dropped; concept + concept→a edge added.
        assert!(m.nodes.iter().any(|x| x.id == "a" && x.name == "renamed"));
        assert!(!m.nodes.iter().any(|x| x.id == "b"));
        assert!(m.nodes.iter().any(|x| x.kind == NodeKind::Concept));
        assert!(m.edges.iter().any(|e| e.src == "concept:1" && e.dst == "a"));
        assert!(!m.edges.iter().any(|e| e.dst == "b"));
    }

    #[test]
    fn digest_is_smaller_and_flags_inferred() {
        let mut g = KnowledgeGraph {
            repo: "/tmp/proj".into(),
            repo_hash: "abc".into(),
            file_count: 1,
            source_bytes: 40_000,
            nodes: vec![n("a", "foo", NodeKind::Function), n("b", "bar", NodeKind::Function)],
            edges: vec![Edge {
                src: "a".into(),
                dst: "b".into(),
                kind: EdgeKind::Calls,
                confidence: Confidence::Inferred,
                manual: false,
            }],
            ..Default::default()
        };
        g.communities.push(Community { id: 0, label: "core".into(), members: vec!["a".into(), "b".into()] });
        let out = render_digest(&g);
        assert!(out.contains("bar?"), "inferred edge should be flagged: {}", out);
        assert!(est_tokens(&out) < g.source_bytes / 4);
    }
}
