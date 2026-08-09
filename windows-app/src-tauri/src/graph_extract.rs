//! Knowledge-graph extractor — the local, deterministic core that mirrors
//! Graphify's tree-sitter approach: parse JS/TS with tree-sitter, pull out
//! functions / methods / classes / modules and the `calls` / `imports` /
//! `inherits` edges between them, tagging each edge `EXTRACTED` (explicit in the
//! same file) or `INFERRED` (resolved by name across files). No LLM, no network.
//!
//! Community structure uses **label propagation** (pure Rust) rather than
//! Graphify's Leiden — comparable clustering without a native dependency.
//!
//! v1 languages: JavaScript / TypeScript (incl. JSX/TSX). The per-file walk is
//! language-agnostic over node-kind names, so adding a grammar is mostly a
//! matter of registering it in [`language_for`].

use crate::graph_store::{
    Community, Confidence, Edge, EdgeKind, KnowledgeGraph, Node, NodeKind,
};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use tree_sitter::{Language, Node as TsNode, Parser};

const MAX_FILES: usize = 4000;
const MAX_FILE_BYTES: u64 = 800_000;
const SOURCE_EXTS: &[&str] = &["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"];

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

fn language_for(ext: &str) -> Option<(Language, &'static str)> {
    match ext {
        "ts" | "mts" | "cts" => {
            Some((tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(), "ts"))
        }
        "tsx" => Some((tree_sitter_typescript::LANGUAGE_TSX.into(), "tsx")),
        "js" | "jsx" | "mjs" | "cjs" => {
            Some((tree_sitter_javascript::LANGUAGE.into(), "js"))
        }
        _ => None,
    }
}

// ── Per-file extraction result, before cross-file resolution ──────────────────

struct RawFile {
    rel: String,
    lang: String,
    bytes: u64,
    module_id: String,
    nodes: Vec<Node>,
    /// name → node id defined in this file (first definition wins).
    local: HashMap<String, String>,
    /// (owner node id, callee name)
    calls: Vec<(String, String)>,
    /// (module id, import source spec)
    imports: Vec<String>,
    /// (class node id, superclass name)
    inherits: Vec<(String, String)>,
}

/// Build the full graph for a repository by walking every source file.
pub fn build(repo: &Path) -> KnowledgeGraph {
    let hash = crate::graph_store::repo_hash(repo);
    let files = collect_files(repo);

    let mut raws: Vec<RawFile> = Vec::new();
    for rel in &files {
        let abs = repo.join(rel);
        let bytes = std::fs::metadata(&abs).map(|m| m.len()).unwrap_or(0);
        if bytes > MAX_FILE_BYTES {
            continue;
        }
        let Ok(src) = std::fs::read_to_string(&abs) else { continue };
        let ext = ext_of(rel);
        if let Some((lang, lang_tag)) = language_for(ext) {
            if let Some(raw) = extract_file(rel, lang, lang_tag, &src) {
                raws.push(raw);
            }
        }
    }

    combine(repo, &hash, raws)
}

fn ext_of(rel: &str) -> &str {
    Path::new(rel).extension().and_then(|e| e.to_str()).unwrap_or("")
}

/// True if a filesystem path is a source file the graph cares about. Used by the
/// live watcher to decide whether a change warrants a rebuild — note that our own
/// digest (`.terse/graph.md`) and `CLAUDE.md` are non-source extensions, so
/// writing them never re-triggers the watcher (no rebuild loop).
pub fn is_source_path(path: &Path) -> bool {
    let s = path.to_string_lossy().replace('\\', "/");
    if s.contains("/node_modules/")
        || s.contains("/.git/")
        || s.contains("/dist/")
        || s.contains("/build/")
        || s.contains("/.terse/")
        || s.contains(".min.")
    {
        return false;
    }
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    SOURCE_EXTS.contains(&ext)
}

fn collect_files(repo: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let walker = ignore::WalkBuilder::new(repo)
        .hidden(false) // let .gitignore decide, but we still skip dotdirs below
        .git_ignore(true)
        .git_global(false)
        .parents(true)
        .build();
    for entry in walker.flatten() {
        if out.len() >= MAX_FILES {
            break;
        }
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let rel = match path.strip_prefix(repo) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        // Skip obvious noise even if not gitignored.
        if rel.starts_with(".git/")
            || rel.contains("/node_modules/")
            || rel.starts_with("node_modules/")
            || rel.contains("/dist/")
            || rel.contains("/build/")
            || rel.contains(".min.")
            || rel.contains("/vendor/")
        {
            continue;
        }
        if SOURCE_EXTS.contains(&ext_of(&rel)) {
            out.push(rel);
        }
    }
    out.sort();
    out
}

// ── Single-file AST walk ──────────────────────────────────────────────────────

fn extract_file(rel: &str, lang: Language, lang_tag: &str, src: &str) -> Option<RawFile> {
    let mut parser = Parser::new();
    parser.set_language(&lang).ok()?;
    let tree = parser.parse(src, None)?;
    let root = tree.root_node();
    let bytes_src = src.as_bytes();

    let module_id = format!("mod::{}", rel);
    let module_name = Path::new(rel)
        .file_name()
        .map(|x| x.to_string_lossy().to_string())
        .unwrap_or_else(|| rel.to_string());

    let mut raw = RawFile {
        rel: rel.to_string(),
        lang: lang_tag.to_string(),
        bytes: src.len() as u64,
        module_id: module_id.clone(),
        nodes: vec![Node {
            id: module_id.clone(),
            kind: NodeKind::Module,
            name: module_name,
            path: rel.to_string(),
            line: 0,
            lang: lang_tag.to_string(),
            community: None,
            degree: 0,
            manual: false,
        }],
        local: HashMap::new(),
        calls: Vec::new(),
        imports: Vec::new(),
        inherits: Vec::new(),
    };

    walk(root, bytes_src, rel, lang_tag, &module_id, &mut raw);
    Some(raw)
}

fn node_text<'a>(n: TsNode, src: &'a [u8]) -> &'a str {
    n.utf8_text(src).unwrap_or("")
}

fn line_of(n: TsNode) -> u32 {
    (n.start_position().row + 1) as u32
}

/// Recursive descent. `owner` is the id of the nearest enclosing definition
/// (module, function, method, or class), used to attribute calls/imports.
fn walk(node: TsNode, src: &[u8], rel: &str, lang: &str, owner: &str, raw: &mut RawFile) {
    let kind = node.kind();

    match kind {
        "function_declaration"
        | "generator_function_declaration"
        | "function_signature" => {
            if let Some(id) = define(node, src, rel, lang, NodeKind::Function, raw) {
                walk_children(node, src, rel, lang, &id, raw);
                return;
            }
        }
        "class_declaration" | "abstract_class_declaration" | "class" => {
            if let Some(id) = define(node, src, rel, lang, NodeKind::Class, raw) {
                collect_inherits(node, src, &id, raw);
                walk_children(node, src, rel, lang, &id, raw);
                return;
            }
        }
        "interface_declaration" => {
            if let Some(id) = define(node, src, rel, lang, NodeKind::Class, raw) {
                walk_children(node, src, rel, lang, &id, raw);
                return;
            }
        }
        "method_definition" | "method_signature" | "public_field_definition" => {
            // Methods live under a class; attribute a `method` edge from the
            // enclosing class (the current owner) to this method.
            if let Some(name) = field_name_text(node, src) {
                let line = line_of(node);
                let id = mk_id(rel, &name, line);
                if !raw.local.contains_key(&name) {
                    raw.local.insert(name.clone(), id.clone());
                }
                raw.nodes.push(Node {
                    id: id.clone(),
                    kind: NodeKind::Method,
                    name,
                    path: rel.to_string(),
                    line,
                    lang: lang.to_string(),
                    community: None,
                    degree: 0,
                    manual: false,
                });
                // owner is the class → record method containment as an edge later.
                raw.calls.push((owner.to_string(), format!("\u{2}method:{}", id)));
                walk_children(node, src, rel, lang, &id, raw);
                return;
            }
        }
        "variable_declarator" => {
            // `const foo = () => {}` / `const Foo = class {}` — treat the bound
            // name as a function/class definition.
            if let (Some(name_n), Some(val_n)) =
                (node.child_by_field_name("name"), node.child_by_field_name("value"))
            {
                let vk = val_n.kind();
                let nk = match vk {
                    "arrow_function" | "function" | "function_expression"
                    | "generator_function" => Some(NodeKind::Function),
                    "class" | "class_expression" => Some(NodeKind::Class),
                    _ => None,
                };
                if let Some(nk) = nk {
                    let name = node_text(name_n, src).to_string();
                    if !name.is_empty() {
                        let line = line_of(node);
                        let id = mk_id(rel, &name, line);
                        raw.local.entry(name.clone()).or_insert_with(|| id.clone());
                        raw.nodes.push(Node {
                            id: id.clone(),
                            kind: nk,
                            name,
                            path: rel.to_string(),
                            line,
                            lang: lang.to_string(),
                            community: None,
                            degree: 0,
                            manual: false,
                        });
                        if nk == NodeKind::Class {
                            collect_inherits(val_n, src, &id, raw);
                        }
                        walk_children(val_n, src, rel, lang, &id, raw);
                        return;
                    }
                }
            }
        }
        "call_expression" => {
            if let Some(func) = node.child_by_field_name("function") {
                // require('x') → an import edge from the module.
                if func.kind() == "identifier" && node_text(func, src) == "require" {
                    if let Some(spec) = first_string_arg(node, src) {
                        raw.imports.push(spec);
                    }
                } else if let Some(callee) = callee_name(func, src) {
                    raw.calls.push((owner.to_string(), callee));
                }
            }
        }
        "import_statement" => {
            if let Some(spec) = import_source(node, src) {
                raw.imports.push(spec);
            }
        }
        _ => {}
    }

    walk_children(node, src, rel, lang, owner, raw);
}

fn walk_children(node: TsNode, src: &[u8], rel: &str, lang: &str, owner: &str, raw: &mut RawFile) {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        walk(child, src, rel, lang, owner, raw);
    }
}

/// Create a Node for a named definition (function/class). Returns its id.
fn define(
    node: TsNode,
    src: &[u8],
    rel: &str,
    lang: &str,
    kind: NodeKind,
    raw: &mut RawFile,
) -> Option<String> {
    let name = field_name_text(node, src)?;
    let line = line_of(node);
    let id = mk_id(rel, &name, line);
    raw.local.entry(name.clone()).or_insert_with(|| id.clone());
    raw.nodes.push(Node {
        id: id.clone(),
        kind,
        name,
        path: rel.to_string(),
        line,
        lang: lang.to_string(),
        community: None,
        degree: 0,
        manual: false,
    });
    Some(id)
}

fn field_name_text(node: TsNode, src: &[u8]) -> Option<String> {
    let n = node.child_by_field_name("name")?;
    let t = node_text(n, src).trim().to_string();
    if t.is_empty() { None } else { Some(t) }
}

fn mk_id(rel: &str, name: &str, line: u32) -> String {
    format!("{}::{}#{}", rel, name, line)
}

/// Resolve the called name from a call_expression's `function` child.
fn callee_name(func: TsNode, src: &[u8]) -> Option<String> {
    match func.kind() {
        "identifier" => {
            let t = node_text(func, src);
            if t.is_empty() { None } else { Some(t.to_string()) }
        }
        "member_expression" => {
            let prop = func.child_by_field_name("property")?;
            let t = node_text(prop, src);
            if t.is_empty() { None } else { Some(t.to_string()) }
        }
        _ => None,
    }
}

fn first_string_arg(call: TsNode, src: &[u8]) -> Option<String> {
    let args = call.child_by_field_name("arguments")?;
    let mut cursor = args.walk();
    for child in args.children(&mut cursor) {
        if child.kind() == "string" {
            return Some(strip_quotes(node_text(child, src)));
        }
    }
    None
}

fn import_source(node: TsNode, src: &[u8]) -> Option<String> {
    let s = node.child_by_field_name("source")?;
    Some(strip_quotes(node_text(s, src)))
}

fn strip_quotes(s: &str) -> String {
    s.trim().trim_matches(|c| c == '"' || c == '\'' || c == '`').to_string()
}

/// Find the superclass identifier under a class heritage clause.
fn collect_inherits(class_node: TsNode, src: &[u8], class_id: &str, raw: &mut RawFile) {
    let mut cursor = class_node.walk();
    for child in class_node.children(&mut cursor) {
        if child.kind() == "class_heritage" {
            if let Some(name) = first_identifier(child, src) {
                raw.inherits.push((class_id.to_string(), name));
            }
        }
    }
}

fn first_identifier(node: TsNode, src: &[u8]) -> Option<String> {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        match child.kind() {
            "identifier" | "type_identifier" => {
                let t = node_text(child, src);
                if !t.is_empty() {
                    return Some(t.to_string());
                }
            }
            "member_expression" => {
                if let Some(p) = child.child_by_field_name("property") {
                    let t = node_text(p, src);
                    if !t.is_empty() {
                        return Some(t.to_string());
                    }
                }
            }
            _ => {
                if let Some(x) = first_identifier(child, src) {
                    return Some(x);
                }
            }
        }
    }
    None
}

// ── Cross-file resolution + communities ───────────────────────────────────────

fn combine(repo: &Path, hash: &str, raws: Vec<RawFile>) -> KnowledgeGraph {
    let mut nodes: Vec<Node> = Vec::new();
    let mut edges: Vec<Edge> = Vec::new();
    let mut lang_counts: HashMap<String, u32> = HashMap::new();
    let mut source_bytes: u64 = 0;
    let file_count = raws.len() as u32;

    // rel path (no ext) → module id, for relative-import resolution.
    let mut modules_by_rel: HashMap<String, String> = HashMap::new();
    // global name → node id (first definition wins).
    let mut global: HashMap<String, String> = HashMap::new();
    // external nodes deduped by name.
    let mut externals: HashMap<String, String> = HashMap::new();

    for raw in &raws {
        *lang_counts.entry(raw.lang.clone()).or_default() += 1;
        source_bytes += raw.bytes;
        let stem = strip_ext(&raw.rel);
        modules_by_rel.insert(stem, raw.module_id.clone());
        for n in &raw.nodes {
            nodes.push(n.clone());
            if !matches!(n.kind, NodeKind::Module) {
                global.entry(n.name.clone()).or_insert_with(|| n.id.clone());
            }
        }
    }

    let ensure_external = |name: &str, externals: &mut HashMap<String, String>, nodes: &mut Vec<Node>| -> String {
        if let Some(id) = externals.get(name) {
            return id.clone();
        }
        let id = format!("ext::{}", name);
        externals.insert(name.to_string(), id.clone());
        nodes.push(Node {
            id: id.clone(),
            kind: NodeKind::External,
            name: name.to_string(),
            path: String::new(),
            line: 0,
            lang: String::new(),
            community: None,
            degree: 0,
            manual: false,
        });
        id
    };

    for raw in &raws {
        // Calls (and the special method-containment marker).
        for (owner, callee) in &raw.calls {
            if let Some(method_id) = callee.strip_prefix('\u{2}') {
                // "\u{2}method:<id>" — class → method containment.
                if let Some(mid) = method_id.strip_prefix("method:") {
                    edges.push(Edge {
                        src: owner.clone(),
                        dst: mid.to_string(),
                        kind: EdgeKind::Method,
                        confidence: Confidence::Extracted,
                        manual: false,
                    });
                }
                continue;
            }
            if let Some(local) = raw.local.get(callee) {
                if local != owner {
                    edges.push(Edge {
                        src: owner.clone(),
                        dst: local.clone(),
                        kind: EdgeKind::Calls,
                        confidence: Confidence::Extracted,
                        manual: false,
                    });
                }
            } else if let Some(gid) = global.get(callee) {
                edges.push(Edge {
                    src: owner.clone(),
                    dst: gid.clone(),
                    kind: EdgeKind::Calls,
                    confidence: Confidence::Inferred,
                    manual: false,
                });
            }
            // Unresolved names (builtins like console/Math, DOM, etc.) are dropped
            // to keep the graph about the project rather than the platform.
        }

        // Inherits.
        for (class_id, super_name) in &raw.inherits {
            if let Some(local) = raw.local.get(super_name) {
                edges.push(Edge {
                    src: class_id.clone(),
                    dst: local.clone(),
                    kind: EdgeKind::Inherits,
                    confidence: Confidence::Extracted,
                    manual: false,
                });
            } else if let Some(gid) = global.get(super_name) {
                edges.push(Edge {
                    src: class_id.clone(),
                    dst: gid.clone(),
                    kind: EdgeKind::Inherits,
                    confidence: Confidence::Inferred,
                    manual: false,
                });
            } else {
                let ext = ensure_external(super_name, &mut externals, &mut nodes);
                edges.push(Edge {
                    src: class_id.clone(),
                    dst: ext,
                    kind: EdgeKind::Inherits,
                    confidence: Confidence::Inferred,
                    manual: false,
                });
            }
        }

        // Imports.
        for spec in &raw.imports {
            if spec.starts_with('.') {
                if let Some(target) = resolve_relative(&raw.rel, spec, &modules_by_rel) {
                    edges.push(Edge {
                        src: raw.module_id.clone(),
                        dst: target,
                        kind: EdgeKind::Imports,
                        confidence: Confidence::Extracted,
                        manual: false,
                    });
                }
            } else {
                // Bare specifier → external package.
                let pkg = package_root(spec);
                let ext = ensure_external(&pkg, &mut externals, &mut nodes);
                edges.push(Edge {
                    src: raw.module_id.clone(),
                    dst: ext,
                    kind: EdgeKind::Imports,
                    confidence: Confidence::Inferred,
                    manual: false,
                });
            }
        }
    }

    // Dedup identical edges.
    let mut seen: HashSet<String> = HashSet::new();
    edges.retain(|e| seen.insert(e.key()));

    // Degrees.
    let mut deg: HashMap<String, u32> = HashMap::new();
    for e in &edges {
        *deg.entry(e.src.clone()).or_default() += 1;
        *deg.entry(e.dst.clone()).or_default() += 1;
    }
    for n in &mut nodes {
        n.degree = deg.get(&n.id).copied().unwrap_or(0);
    }

    let communities = detect_communities(&nodes, &edges);
    // Stamp community id onto nodes.
    let mut node_comm: HashMap<String, u32> = HashMap::new();
    for c in &communities {
        for m in &c.members {
            node_comm.insert(m.clone(), c.id);
        }
    }
    for n in &mut nodes {
        n.community = node_comm.get(&n.id).copied();
    }

    KnowledgeGraph {
        repo: repo.to_string_lossy().to_string(),
        repo_hash: hash.to_string(),
        built_at: now_secs(),
        nodes,
        edges,
        communities,
        lang_counts,
        file_count,
        source_bytes,
    }
}

fn strip_ext(rel: &str) -> String {
    match rel.rfind('.') {
        Some(i) if i > rel.rfind('/').map(|s| s + 1).unwrap_or(0) => rel[..i].to_string(),
        _ => rel.to_string(),
    }
}

fn package_root(spec: &str) -> String {
    if let Some(scoped) = spec.strip_prefix('@') {
        // @scope/name
        let mut it = scoped.splitn(3, '/');
        let scope = it.next().unwrap_or("");
        let name = it.next().unwrap_or("");
        format!("@{}/{}", scope, name)
    } else {
        spec.split('/').next().unwrap_or(spec).to_string()
    }
}

/// Resolve a relative import spec against the importing file to a known module.
fn resolve_relative(
    from_rel: &str,
    spec: &str,
    modules_by_rel: &HashMap<String, String>,
) -> Option<String> {
    let from_dir = Path::new(from_rel).parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    let mut parts: Vec<String> = if from_dir.is_empty() {
        Vec::new()
    } else {
        from_dir.split('/').map(|s| s.to_string()).collect()
    };
    for seg in spec.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other.to_string()),
        }
    }
    let base = parts.join("/");
    let base_stripped = strip_ext(&base);
    // Try exact stem, then index.
    let candidates = [base_stripped.clone(), format!("{}/index", base_stripped)];
    for c in candidates {
        if let Some(id) = modules_by_rel.get(&c) {
            return Some(id.clone());
        }
    }
    None
}

// ── Label-propagation community detection (deterministic order) ───────────────

fn detect_communities(nodes: &[Node], edges: &[Edge]) -> Vec<Community> {
    // Build undirected adjacency over node ids that have at least one edge.
    let mut adj: HashMap<&str, Vec<&str>> = HashMap::new();
    for e in edges {
        adj.entry(e.src.as_str()).or_default().push(e.dst.as_str());
        adj.entry(e.dst.as_str()).or_default().push(e.src.as_str());
    }
    // Deterministic node ordering.
    let mut ids: Vec<&str> = adj.keys().copied().collect();
    ids.sort_unstable();
    if ids.is_empty() {
        return Vec::new();
    }

    // Each node starts in its own label (index).
    let mut label: HashMap<&str, usize> = ids.iter().enumerate().map(|(i, id)| (*id, i)).collect();

    for _ in 0..12 {
        let mut changed = false;
        for id in &ids {
            let neighbors = match adj.get(id) {
                Some(v) => v,
                None => continue,
            };
            let mut counts: HashMap<usize, usize> = HashMap::new();
            for nb in neighbors {
                if let Some(l) = label.get(nb) {
                    *counts.entry(*l).or_default() += 1;
                }
            }
            // Most frequent label, ties broken by smallest label for determinism.
            if let Some((best, _)) = counts
                .iter()
                .max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(a.0)))
                .map(|(l, c)| (*l, *c))
            {
                if label.get(id).copied() != Some(best) {
                    label.insert(id, best);
                    changed = true;
                }
            }
        }
        if !changed {
            break;
        }
    }

    // Group node ids by final label.
    let mut groups: HashMap<usize, Vec<String>> = HashMap::new();
    for id in &ids {
        groups.entry(label[id]).or_default().push((*id).to_string());
    }
    // Drop singletons into no community; renumber the rest 0..k.
    let node_by_id: HashMap<&str, &Node> = nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let mut groups: Vec<Vec<String>> = groups.into_values().filter(|g| g.len() >= 2).collect();
    // Stable order: largest first, then by first member id.
    groups.sort_by(|a, b| b.len().cmp(&a.len()).then(a[0].cmp(&b[0])));

    groups
        .into_iter()
        .enumerate()
        .map(|(id, mut members)| {
            members.sort();
            // Label = name of the highest-degree, non-external member.
            let label = members
                .iter()
                .filter_map(|m| node_by_id.get(m.as_str()))
                .filter(|n| !matches!(n.kind, NodeKind::External))
                .max_by_key(|n| n.degree)
                .map(|n| clean_label(&n.name))
                .unwrap_or_else(|| format!("cluster-{}", id));
            Community { id: id as u32, label, members }
        })
        .collect()
}

fn clean_label(name: &str) -> String {
    let n = name.trim();
    if n.len() > 24 {
        n.chars().take(24).collect()
    } else {
        n.to_string()
    }
}

/// How recently a Claude session must have been touched to count as "active".
const RECENT_SECS: u64 = 2 * 24 * 3600; // 2 days
/// Cap on how many distinct repos we auto-track, newest first.
const MAX_ACTIVE_REPOS: usize = 12;

/// Detect **every** repo a coding agent has recently worked in, newest first, by
/// scanning `~/.claude/projects/*/*.jsonl` for recently-modified sessions and
/// pulling each session's `cwd`. Deduplicated by path, recency-filtered, capped.
/// Cross-platform. This is what drives auto-build + the repo switcher.
pub fn detect_active_repos() -> Vec<String> {
    let projects = match dirs::home_dir() {
        Some(h) => h.join(".claude").join("projects"),
        None => return Vec::new(),
    };
    let now = std::time::SystemTime::now();
    let recent = std::time::Duration::from_secs(RECENT_SECS);
    let mut found: Vec<(std::time::SystemTime, String)> = Vec::new();

    let rd = match std::fs::read_dir(&projects) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    for proj in rd.flatten() {
        let pdir = proj.path();
        if !pdir.is_dir() {
            continue;
        }
        // Newest .jsonl in this project dir.
        let mut newest: Option<(std::time::SystemTime, std::path::PathBuf)> = None;
        if let Ok(files) = std::fs::read_dir(&pdir) {
            for f in files.flatten() {
                let path = f.path();
                if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                if let Ok(mt) = f.metadata().and_then(|m| m.modified()) {
                    if newest.as_ref().map(|(t, _)| mt > *t).unwrap_or(true) {
                        newest = Some((mt, path));
                    }
                }
            }
        }
        if let Some((mt, path)) = newest {
            let is_recent = now.duration_since(mt).map(|d| d <= recent).unwrap_or(false);
            if is_recent {
                if let Some(cwd) = read_session_cwd(&path) {
                    found.push((mt, cwd));
                }
            }
        }
    }

    found.sort_by(|a, b| b.0.cmp(&a.0)); // newest first
    let mut seen = HashSet::new();
    let mut repos = Vec::new();
    for (_, cwd) in found {
        if std::path::Path::new(&cwd).is_dir() && seen.insert(cwd.clone()) {
            repos.push(cwd);
            if repos.len() >= MAX_ACTIVE_REPOS {
                break;
            }
        }
    }
    repos
}

/// The single most-recently-active repo (used as the resolution fallback).
pub fn detect_active_repo() -> Option<String> {
    detect_active_repos().into_iter().next()
}

fn read_session_cwd(path: &Path) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    for line in content.lines().take(200) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            if let Some(cwd) = v.get("cwd").and_then(|c| c.as_str()) {
                if !cwd.is_empty() {
                    return Some(cwd.to_string());
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_calls_imports_inherits() {
        let dir = std::env::temp_dir().join(format!("terse-graph-test-{}", now_secs()));
        let src = dir.join("src");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(
            src.join("util.js"),
            "export function helper() { return 1; }\nexport class Base {}\n",
        )
        .unwrap();
        std::fs::write(
            src.join("main.js"),
            "import { helper, Base } from './util';\nimport _ from 'lodash';\n\
             class Widget extends Base { render() { return helper(); } }\n\
             function boot() { const w = new Widget(); w.render(); }\n",
        )
        .unwrap();

        let g = build(&dir);

        // Nodes for both files' modules + defs.
        assert!(g.nodes.iter().any(|n| n.name == "helper" && n.kind == NodeKind::Function));
        assert!(g.nodes.iter().any(|n| n.name == "Widget" && n.kind == NodeKind::Class));
        assert!(g.nodes.iter().any(|n| n.name == "render" && n.kind == NodeKind::Method));

        // helper() called from render() → resolved across files as INFERRED.
        assert!(g.edges.iter().any(|e| e.kind == EdgeKind::Calls
            && g.nodes.iter().any(|n| n.id == e.dst && n.name == "helper")));

        // Widget extends Base → inherits edge.
        assert!(g.edges.iter().any(|e| e.kind == EdgeKind::Inherits));

        // import './util' → EXTRACTED module import; 'lodash' → external.
        assert!(g.edges.iter().any(|e| e.kind == EdgeKind::Imports
            && e.confidence == Confidence::Extracted));
        assert!(g.nodes.iter().any(|n| n.kind == NodeKind::External && n.name == "lodash"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rebuild_is_deterministic() {
        let dir = std::env::temp_dir().join(format!("terse-graph-det-{}", now_secs()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.ts"), "export const f = () => 2;\nfunction g(){ return f(); }\n").unwrap();
        let g1 = build(&dir);
        let g2 = build(&dir);
        assert_eq!(g1.nodes.len(), g2.nodes.len());
        assert_eq!(g1.edges.len(), g2.edges.len());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
