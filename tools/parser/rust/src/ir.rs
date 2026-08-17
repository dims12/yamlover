// The yamlover instance-graph IR. Normative spec: IR.md
//
// Parsers (json5p, yamlover) emit a Document; the engine consumes it. Pointers are
// stored UNRESOLVED (the engine resolves lazily). Positions are the array index of an
// entry — derived, not double-stored.
//
// Divergence from ts/src/ir.ts, and why: TypeScript spells `Node = Mapping | Scalar | Blob`
// as three interfaces that each extend NodeBase, because a node is *value + fields* and any
// of the three may also carry entries. Rust says the same thing more directly with one
// struct whose `kind` is an enum — the shared fields stop being duplicated three ways and
// `entries`/`array`/`meta` become unconditionally reachable, which is what every caller
// wanted anyway. The graph this describes is identical.

use std::fmt;

/// The document's source language — the whole file/stream this Document was parsed from.
/// This is the DOCUMENT-level vocabulary; the richer PER-NODE storage taxonomy (file/…,
/// dir/.yo, inlined languages) lives on the materialized nodes — see docs/language/concretes.
/// `MultiYaml` / `MultiYamlover` are reserved for multi-document streams (Phase 2c).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Concrete {
    Json,
    Json5,
    Json5p,
    Yaml,
    Yamlover,
    Dir,
    MultiYaml,
    MultiYamlover,
}

impl Concrete {
    pub fn as_str(self) -> &'static str {
        match self {
            Concrete::Json => "json",
            Concrete::Json5 => "json5",
            Concrete::Json5p => "json5p",
            Concrete::Yaml => "yaml",
            Concrete::Yamlover => "yamlover",
            Concrete::Dir => "dir",
            Concrete::MultiYaml => "multi-yaml",
            Concrete::MultiYamlover => "multi-yamlover",
        }
    }
}

impl fmt::Display for Concrete {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceInfo {
    pub concrete: Concrete,
    pub uri: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Span {
    pub uri: String,
    pub start: usize,
    pub end: usize,
}

/// `Leading` — own line(s) above the entry it decorates; `Trailing` — on the entry's last
/// line, after the value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Placement {
    Leading,
    Trailing,
}

/// `Line` (`#` or `//`) vs `Block` (a json5p slash-star comment). yamlover is always `Line`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommentStyle {
    Line,
    Block,
}

/// A retained source comment (IR.md). Comments are TYPOGRAPHY: the parsers capture them so
/// an editor can round-trip a file, but they are NOT part of graph identity (canonical
/// IR-equality ignores them) and serializers emit them only on request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Comment {
    /// The comment body with its sigils stripped — no leading `#` / `//`, no block fences.
    pub text: String,
    pub span: Option<Span>,
    pub placement: Placement,
    pub style: CommentStyle,
    /// A blank line immediately precedes this comment (a standalone remark, not tucked
    /// against the line above).
    pub blank_before: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Document {
    pub root: Node,
    pub source: SourceInfo,
    /// Head-of-file comments: a banner at the top, set off from the body by a blank line.
    /// Comments that run straight into the first entry attach to it (`EntryMeta.comments`).
    pub head: Vec<Comment>,
}

impl Document {
    pub fn new(root: Node, concrete: Concrete, uri: impl Into<String>) -> Self {
        Document {
            root,
            source: SourceInfo { concrete, uri: uri.into() },
            head: Vec::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

/// A scalar's value. JS numbers are f64 end to end, so this keeps one numeric arm; the
/// authored spelling survives separately in `NodeKind::Scalar::raw`, which is what the
/// serializer's raw-first law re-emits. NaN / ±Infinity / -0 are representable here and are
/// refused by the serializer, not by the type.
#[derive(Debug, Clone)]
pub enum ScalarValue {
    Str(String),
    Num(f64),
    Bool(bool),
    Null,
}

impl PartialEq for ScalarValue {
    /// Total equality, unlike f64's: two NaNs compare equal and -0 differs from 0, because
    /// this is graph identity, not arithmetic. `canon.ts` draws the same distinction when it
    /// encodes them as `{$num: 'nan'}` / `{$num: '-0'}` sentinels for `ir.json`.
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (ScalarValue::Str(a), ScalarValue::Str(b)) => a == b,
            (ScalarValue::Bool(a), ScalarValue::Bool(b)) => a == b,
            (ScalarValue::Null, ScalarValue::Null) => true,
            (ScalarValue::Num(a), ScalarValue::Num(b)) => {
                if a.is_nan() && b.is_nan() {
                    true
                } else {
                    a == b && a.is_sign_negative() == b.is_sign_negative()
                }
            }
            _ => false,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum NodeKind {
    Mapping,
    Scalar {
        value: ScalarValue,
        /// Verbatim source token (lossless round-trip). Empty string = MINTED, i.e. no
        /// authored spelling to preserve, so the serializer chooses the canonical one.
        raw: String,
    },
    Blob {
        /// The bytes' media type / named constraint (`image/png`, `application/pdf`) — what
        /// the value MEANS, never how it decodes; decoding rides `NodeMeta::concrete` (the
        /// concrete/format split, docs/meta). `application/octet-stream` = unknown.
        format: String,
        /// Content hash (`xxh64:…`), or None when the bytes have not been hashed yet — a
        /// large blob's identity is (path, size, mtime); the engine's background hasher
        /// fills this in.
        content_hash: Option<String>,
        size: u64,
    },
}

/// Every node may carry, INDEPENDENTLY of its `kind`:
///  - `entries`: ordered fields — keyless (positional) and/or keyed — the "one ordered
///    container". So a Scalar or Blob can ALSO have fields: a node is *value + fields*, and
///    a single node can be at once a scalar, partially positioned, and partially keyed.
///  - `array`: projection hint (true ⇒ all-keyless, a pure sequence).
///
/// A pure scalar/mapping/blob is the degenerate case (only a value, or only entries).
#[derive(Debug, Clone, PartialEq)]
pub struct Node {
    pub kind: NodeKind,
    pub entries: Vec<Entry>,
    pub array: bool,
    pub meta: NodeMeta,
}

impl Node {
    pub fn mapping(entries: Vec<Entry>) -> Self {
        Node { kind: NodeKind::Mapping, entries, array: false, meta: NodeMeta::default() }
    }

    /// A pure sequence: a mapping whose entries are all keyless.
    pub fn sequence(entries: Vec<Entry>) -> Self {
        Node { kind: NodeKind::Mapping, entries, array: true, meta: NodeMeta::default() }
    }

    /// A MINTED scalar — no authored spelling, so the serializer picks the canonical one
    /// (and may fold a long string to `>-`). This is the constructor an importer wants.
    pub fn scalar(value: ScalarValue) -> Self {
        Node {
            kind: NodeKind::Scalar { value, raw: String::new() },
            entries: Vec::new(),
            array: false,
            meta: NodeMeta::default(),
        }
    }

    pub fn string(s: impl Into<String>) -> Self {
        Node::scalar(ScalarValue::Str(s.into()))
    }

    /// A scalar carrying its authored spelling. The serializer's raw-first law re-emits
    /// `raw` verbatim when it reparses to the same value.
    pub fn scalar_raw(value: ScalarValue, raw: impl Into<String>) -> Self {
        Node {
            kind: NodeKind::Scalar { value, raw: raw.into() },
            entries: Vec::new(),
            array: false,
            meta: NodeMeta::default(),
        }
    }

    pub fn blob(format: impl Into<String>, content_hash: Option<String>, size: u64) -> Self {
        Node {
            kind: NodeKind::Blob { format: format.into(), content_hash, size },
            entries: Vec::new(),
            array: false,
            meta: NodeMeta::default(),
        }
    }

    pub fn is_mapping(&self) -> bool {
        matches!(self.kind, NodeKind::Mapping)
    }

    pub fn is_scalar(&self) -> bool {
        matches!(self.kind, NodeKind::Scalar { .. })
    }

    pub fn is_blob(&self) -> bool {
        matches!(self.kind, NodeKind::Blob { .. })
    }

    pub fn scalar_value(&self) -> Option<&ScalarValue> {
        match &self.kind {
            NodeKind::Scalar { value, .. } => Some(value),
            _ => None,
        }
    }

    /// The authored spelling, or None when the scalar was minted (or this is not a scalar).
    pub fn raw(&self) -> Option<&str> {
        match &self.kind {
            NodeKind::Scalar { raw, .. } if !raw.is_empty() => Some(raw),
            _ => None,
        }
    }

    /// Builder sugar: attach a `!!<…>` schema tag.
    pub fn with_schema(mut self, schema: Value) -> Self {
        self.meta.schema = Some(Box::new(schema));
        self
    }

    pub fn with_entries(mut self, entries: Vec<Entry>) -> Self {
        self.entries = entries;
        self
    }
}

/// Node metadata. Every field is optional and most are DERIVED by the engine rather than
/// authored; the doc comments say which, because that decides whether a serializer may emit
/// it and whether canonical IR-equality counts it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct NodeMeta {
    pub span: Option<Span>,
    /// Bookmarks (`&P/k` / `&P: -`, docs/language/pointers/bookmarks): this node ALSO lives
    /// at that path — the container at the path's parent gains an entry (the last segment as
    /// key; a positional member for `[]`) that is a ref edge to this node. Anchors are NOT
    /// entries: they never count toward the node's kind. Realized by the resolver.
    pub anchors: Vec<Anchor>,
    /// A schema/meta attached via the `!!<…>` tag (yamlover). Its contents are themselves
    /// yamlover, so the schema is any Value: a Pointer to a hosted schema
    /// (`!!<*yamlover: $defs: chapter>`) OR an inline schema Node
    /// (`!!<format: text/x-plantuml>`). Stored unresolved — ALWAYS the authored tag, never a
    /// derived one. Boxed because a Value contains a Node, which contains this.
    pub schema: Option<Box<Value>>,
    /// The format the ENGINE derived for this node (walk.ts: a file's extension, a `meta.yo`
    /// `format:`, or the resolved target of an authored `!!<…>` tag). Kept apart from
    /// `schema` so the authored tag stays faithful in views and serialization; never
    /// authored, never emitted. Where both could speak, this derived value wins.
    pub derived_format: Option<String>,
    /// This node is a DOCUMENT root — a self-contained instance: a parsed file, a directory
    /// with a `.yo/` overlay, or the served root. The `:` pointer scope resolves to the
    /// nearest enclosing such node, so a reference is depth-independent. STORAGE opens a
    /// document this way; a TAG can open one too, for references only (a `!!yo` island).
    pub document_root: bool,
    /// POSITIONAL PREFIX length (a dir-backed node whose `body.yo` is a pointer-array): the
    /// first N entries are body-ordered (positional) members; keyed entries past N are the
    /// keyed-only remainder the body never granted a position. Derived by the engine's graft
    /// (walk.ts applyBody), never authored.
    pub positional: Option<usize>,
    /// SET semantics (`!!set` tag / `uniqueItems: true` in meta): an element appears at most
    /// once, so duplicate memberships collapse to one. Unlike `!!mix` (a parse permission
    /// visible in the node's shape), this must survive into the graph.
    pub set: bool,
    /// The `!!yo` tag (formerly `!!var`/`!!omni` — read forever as aliases, emitted as
    /// `!!yo`): this node is PLAIN YAMLOVER, exempt from the enclosing document's schema. A
    /// structured consumer (the chapter renderer/editor) must not interpret it by that
    /// schema. Semantic, so it survives into the graph and is part of IR identity.
    pub yo: bool,
    /// RESOLVABLE (indexed, addressable by pointers) but HIDDEN from listings: the TOC, the
    /// directory explorer projection, and visible child counts omit it. Set on the `.yo`
    /// overlay-dir node so its derived sidecars resolve via `*:.yo:…` without cluttering
    /// the UI.
    pub hidden: bool,
    /// DIRECTORY-backed document (a dir with a `.yo/body.yo` overlay): the node's STORAGE is
    /// a directory, which is container shape — schema shape-routing reads a dir-backed
    /// member as a container even when its body is momentarily a bare title. Derived by the
    /// walk, never authored, never serialized.
    pub dir_backed: bool,
    /// DEGRADED — the source file failed to parse and what stands here is the fallback (a
    /// data file's raw text, a directory's plain filesystem mapping). A consumer must treat
    /// the node as read-only: re-serializing the degraded shape would overwrite the user's
    /// original text. Derived by the walk, never serialized; not part of IR identity.
    pub parse_error: Option<ParseError>,
    /// Comments with no entry to attach to: a comment after the last entry of a block, or
    /// inside an empty container; the document root also collects any otherwise-unplaced.
    pub comments: Vec<Comment>,
    /// A document root's head-of-file banner, carried onto the node when a file/body is
    /// assembled into a larger tree so it survives past the parse.
    pub head: Vec<Comment>,
    /// For an OMNI node (a scalar self-value carried alongside `entries`): the display
    /// position of the self-value line among the entries — the count of entries authored
    /// BEFORE it. The value itself is positionless data, but this preserves where the line
    /// was written so serialize + the renderer show it in place. None ⇒ first (0).
    pub self_at: Option<usize>,
    /// FLOW STYLE (typography, not graph): this container was AUTHORED on one line —
    /// `{k: v, …}` / `[v, …]`. Recorded so the serializer re-emits what was written.
    /// `array` remains the sole source of truth for WHICH bracket — this only says "one
    /// line". Not part of IR identity.
    pub style_flow: bool,
    /// The node's DECLARED/OBSERVED decode concrete — the language/codec axis. Two producers:
    /// the yamlover reader's INLINE CONCRETE SWITCH (`json5p`, a flow token spanning lines),
    /// and the directory walk when `.yo/meta.yo` declares a member's decode concrete
    /// (`yamlover/stream`, `base64`, `binary/int32/le`, `text/utf-8`). Typography-adjacent
    /// authored provenance, NOT part of IR identity.
    pub concrete: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError {
    /// Root-relative POSIX path of the unparsable source.
    pub file: String,
    /// The parser's reason.
    pub message: String,
}

/// One `&` BOOKMARK declaration (docs/language/pointers/bookmarks; historically "path
/// anchor"). For a keyed bookmark the path's LAST step is the key the target container
/// gains; an ordinal bookmark (`&path: -`, the trailing keyless segment) points at the
/// container itself and appends a keyless member. `path.span` covers the whole `&…` token;
/// `path.raw` is the authored path text (the trailing `-` rides in raw, not in steps —
/// `ordinal` carries it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Anchor {
    pub path: Pointer,
    /// True for `&path: -` — keyless appended membership.
    pub ordinal: bool,
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EdgeKind {
    Contain,
    Ref,
    Back,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    /// String key, or None for a keyless (`- `) entry — see also `null_key`.
    pub key: Option<String>,
    /// The NULL KEY (YAML's rule, adopted 2026-08-01): `: v` ≡ `~: v` is a KEYED entry whose
    /// key is the null value — distinct from the keyless `- v` (positional only) and from
    /// the empty-string key `"": v`. When true, `key` is None but the entry is NOT keyless;
    /// the pointer spelling of the null key is the bare `~` portion. Canonical: `~: v`.
    pub null_key: bool,
    pub edge: EdgeKind,
    pub value: Value,
    pub meta: EntryMeta,
}

impl Entry {
    /// A keyed containment entry — the ordinary `key: value`.
    pub fn keyed(key: impl Into<String>, value: Value) -> Self {
        Entry {
            key: Some(key.into()),
            null_key: false,
            edge: EdgeKind::Contain,
            value,
            meta: EntryMeta::default(),
        }
    }

    /// A keyless containment entry — the ordinary `- value`.
    pub fn keyless(value: Value) -> Self {
        Entry {
            key: None,
            null_key: false,
            edge: EdgeKind::Contain,
            value,
            meta: EntryMeta::default(),
        }
    }

    /// A keyless REF entry — `- *: pointer`. This is the pointer chunk an importer writes to
    /// name a member file or a subchapter directory.
    pub fn keyless_ref(ptr: Pointer) -> Self {
        Entry {
            key: None,
            null_key: false,
            edge: EdgeKind::Ref,
            value: Value::Pointer(ptr),
            meta: EntryMeta::default(),
        }
    }

    /// Keyless = positional-only: no string key AND not the null key. The one test every
    /// "is this a `- ` entry" site must use — `key.is_none()` alone conflates the null key.
    pub fn is_keyless(&self) -> bool {
        self.key.is_none() && !self.null_key
    }
}

/// The key was authored on a FLAT row (docs/language/flattening): every path segment after
/// the first carries `yamlover/key/flat` — a representation concrete like `style`/`concrete`
/// on NodeMeta: typography, not graph. The serializer re-emits the fold when it is still
/// lossless, else drops it silently.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyConcrete {
    YamloverKeyFlat,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct EntryMeta {
    /// Source range of the WHOLE entry — from the key / `-` / `~` marker through the end of
    /// its value (post-strip: a trailing comment / whitespace is excluded).
    pub span: Option<Span>,
    /// Comments decorating this entry: `Leading` ones on the line(s) above, the lone
    /// `Trailing` one on the entry's last line. Source order preserved.
    pub comments: Vec<Comment>,
    /// A blank source line immediately precedes this entry (vertical separation worth
    /// keeping when re-rendering).
    pub blank_before: bool,
    /// The AUTHORED key token, recorded only when it differs from the canonical emission
    /// (`"a": 1` quoted-by-choice, `{}: 12` a token key). The serializer prefers it —
    /// guarded by a reparse (a stale key_raw must never change the key it spells).
    pub key_raw: Option<String>,
    pub key_concrete: Option<KeyConcrete>,
}

// ---------------------------------------------------------------------------
// Values and pointers
// ---------------------------------------------------------------------------

/// `Node` iff `edge == Contain`; `Pointer` iff `Ref`/`Back`.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Node(Node),
    Pointer(Pointer),
}

impl Value {
    pub fn as_node(&self) -> Option<&Node> {
        match self {
            Value::Node(n) => Some(n),
            Value::Pointer(_) => None,
        }
    }

    pub fn as_pointer(&self) -> Option<&Pointer> {
        match self {
            Value::Pointer(p) => Some(p),
            Value::Node(_) => None,
        }
    }

    pub fn is_pointer(&self) -> bool {
        matches!(self, Value::Pointer(_))
    }
}

impl From<Node> for Value {
    fn from(n: Node) -> Self {
        Value::Node(n)
    }
}

impl From<Pointer> for Value {
    fn from(p: Pointer) -> Self {
        Value::Pointer(p)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pointer {
    pub base: PointerBase,
    pub steps: Vec<Step>,
    /// Verbatim pointer text after `*` (round-trip + diagnostics). Empty = minted, so the
    /// serializer renders the canonical spelling from `base` + `steps`.
    pub raw: String,
    /// Source extent of the WHOLE deref token — from the `*` sigil through the end of the
    /// (possibly quoted) pointer text. The engine's `mv` rewrites exactly this range
    /// (surgical, format-preserving).
    pub span: Option<Span>,
}

impl Pointer {
    /// A minted pointer — no authored text, so the serializer renders it canonically.
    pub fn new(base: PointerBase, steps: Vec<Step>) -> Self {
        Pointer { base, steps, raw: String::new(), span: None }
    }

    /// `*: name` — document scope, one key step. The form an importer uses to name a member
    /// of the directory this overlay describes.
    pub fn document_key(name: impl Into<String>) -> Self {
        Pointer::new(PointerBase::Document, vec![Step::Key { name: name.into() }])
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PointerBase {
    /// Bare name/index: current mapping.
    Current,
    /// `:` — current document root.
    Document,
    /// `..` — parent node (then steps).
    Parent,
    /// `::` — project scope: authority = the first portion, an INTERNAL key at the served
    /// root (an import or a mounted authority). It is intra-project by definition, so an
    /// unresolved authority is a DANGLING typo, not an external reference. `world` marks the
    /// `:::`-spelled WORLD scope — the only form that may name content outside the loaded
    /// tree, so it alone stays external on a miss.
    Link { authority: String, world: bool },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// `name` / `'quoted'` — string key.
    Key { name: String },
    /// A bare integer segment — the integer key (position); `[n]` reads as an alias.
    Index { n: i64 },
    /// `~` — the NULL key (YAML's rule).
    NullKey,
    /// `[.±k]` — RELATIVE position: the host's own position at this depth ± k.
    RelIndex { k: i64 },
    /// `..` — up one node.
    Parent,
    /// `-` — the keyless segment: a bookmark's trailing append (replaces the removed `[]`);
    /// mid-path reserved; in queries = any position.
    Append,
}

// ---------------------------------------------------------------------------
// Plain projection
// ---------------------------------------------------------------------------

/// A plain JS-shaped projection of a pointer-free node, for JSON comparison / debugging.
#[derive(Debug, Clone, PartialEq)]
pub enum Plain {
    Scalar(ScalarValue),
    Seq(Vec<Plain>),
    Map(Vec<(String, Plain)>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlainError {
    Blob,
    UnresolvedPointer,
}

impl fmt::Display for PlainError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PlainError::Blob => f.write_str("to_plain: a blob has no plain JSON form"),
            PlainError::UnresolvedPointer => {
                f.write_str("to_plain: unresolved pointer has no plain form")
            }
        }
    }
}

impl std::error::Error for PlainError {}

/// Project a pointer-free Node to a plain value. A node with both a scalar value and fields
/// projects to a map with the self-value under the reserved `$value` key; keyless entries
/// project under their integer position; the NULL key under `~` (JSON has no null key — the
/// pointer spelling stands in).
pub fn to_plain(node: &Node) -> Result<Plain, PlainError> {
    if node.entries.is_empty() {
        return match &node.kind {
            NodeKind::Scalar { value, .. } => Ok(Plain::Scalar(value.clone())),
            NodeKind::Blob { .. } => Err(PlainError::Blob),
            // empty array vs empty mapping (keep the projection hint)
            NodeKind::Mapping => {
                Ok(if node.array { Plain::Seq(Vec::new()) } else { Plain::Map(Vec::new()) })
            }
        };
    }

    // pure sequence (a mapping projected as an array): all-keyless and no scalar self-value
    if node.is_mapping() && (node.array || node.entries.iter().all(Entry::is_keyless)) {
        let mut out = Vec::with_capacity(node.entries.len());
        for e in &node.entries {
            out.push(entry_plain(e)?);
        }
        return Ok(Plain::Seq(out));
    }

    let mut out: Vec<(String, Plain)> = Vec::with_capacity(node.entries.len() + 1);
    if let NodeKind::Scalar { value, .. } = &node.kind {
        out.push(("$value".to_string(), Plain::Scalar(value.clone())));
    }
    for (i, e) in node.entries.iter().enumerate() {
        let key = if e.null_key {
            "~".to_string()
        } else {
            e.key.clone().unwrap_or_else(|| i.to_string())
        };
        out.push((key, entry_plain(e)?));
    }
    Ok(Plain::Map(out))
}

fn entry_plain(e: &Entry) -> Result<Plain, PlainError> {
    match &e.value {
        Value::Pointer(_) => Err(PlainError::UnresolvedPointer),
        Value::Node(n) => to_plain(n),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keyless_is_not_the_null_key() {
        let keyless = Entry::keyless(Node::string("v").into());
        let mut null_keyed = Entry::keyless(Node::string("v").into());
        null_keyed.null_key = true;

        assert!(keyless.is_keyless());
        assert!(!null_keyed.is_keyless(), "`~: v` is KEYED — key.is_none() alone conflates them");
    }

    #[test]
    fn empty_array_and_empty_mapping_keep_their_projection_hint() {
        assert_eq!(to_plain(&Node::sequence(vec![])).unwrap(), Plain::Seq(vec![]));
        assert_eq!(to_plain(&Node::mapping(vec![])).unwrap(), Plain::Map(vec![]));
    }

    #[test]
    fn an_omni_node_projects_its_self_value_under_dollar_value() {
        let mut n = Node::string("the title");
        n.entries = vec![Entry::keyed("k", Node::string("v").into())];

        let Plain::Map(pairs) = to_plain(&n).unwrap() else { panic!("expected a map") };
        assert_eq!(pairs[0].0, "$value");
        assert_eq!(pairs[0].1, Plain::Scalar(ScalarValue::Str("the title".into())));
        assert_eq!(pairs[1].0, "k");
    }

    #[test]
    fn keyless_entries_project_under_their_position_when_mixed_with_keys() {
        let n = Node::mapping(vec![
            Entry::keyed("a", Node::string("x").into()),
            Entry::keyless(Node::string("y").into()),
        ]);
        let Plain::Map(pairs) = to_plain(&n).unwrap() else { panic!("expected a map") };
        assert_eq!(pairs[0].0, "a");
        assert_eq!(pairs[1].0, "1", "the keyless entry takes its array index as the key");
    }

    #[test]
    fn scalar_identity_is_total_not_arithmetic() {
        assert_eq!(ScalarValue::Num(f64::NAN), ScalarValue::Num(f64::NAN), "NaN is one value here");
        assert_ne!(ScalarValue::Num(-0.0), ScalarValue::Num(0.0), "-0 is a distinct authoring");
        assert_ne!(ScalarValue::Num(1.0), ScalarValue::Str("1".into()));
    }

    #[test]
    fn a_blob_has_no_plain_form() {
        let b = Node::blob("image/png", Some("xxh64:abc".into()), 12);
        assert_eq!(to_plain(&b), Err(PlainError::Blob));
    }

    #[test]
    fn minted_scalars_report_no_raw() {
        assert_eq!(Node::string("x").raw(), None);
        assert_eq!(Node::scalar_raw(ScalarValue::Num(1.0), "1.0").raw(), Some("1.0"));
    }
}
