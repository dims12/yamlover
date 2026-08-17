// Shared bits for the IR → concrete serializers (PLAN.md 2d). Port of ts/src/serialize-common.ts.

use crate::ir::{Anchor, EdgeKind, Entry, PointerBase, Step, Value};
use crate::pointer::{is_all_digits, escape_chars, render_pointer};
use std::fmt;

/// The target concrete cannot express this construct. The lossy policy (PLAN.md 2d) is
/// REFUSE: a serializer never drops or silently rewrites graph data — route inexpressible
/// metadata through the meta layer (docs/meta/attaching) or pick a fuller concrete instead.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LossyError(pub String);

impl LossyError {
    pub fn new(msg: impl Into<String>) -> Self {
        LossyError(msg.into())
    }
}

impl fmt::Display for LossyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for LossyError {}

pub type Result<T> = std::result::Result<T, LossyError>;

/// Double-quoted, JSON-escape style — the parser's dq escapes are a JSON superset.
///
/// This is `JSON.stringify` on a string, exactly: two-char escapes for the five named
/// controls, `\u00xx` for the rest below 0x20, `"` and `\` escaped, and **everything else
/// left literal** — DEL is not escaped and non-ASCII is never `\u`-encoded, which is what
/// keeps Cyrillic and emoji readable in the goldens.
pub fn dq(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\u{c}' => out.push_str("\\f"),
            '\r' => out.push_str("\\r"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The KEYLESS MARKER at the head of a block line — the ONE law, shared by the parser, every
/// serializer, and the server's line scanner (three places that must never disagree about
/// what opens an entry). Returns the marker's WIDTH, or None when the line opens no keyless
/// entry:
///
/// - `-` / `- value`   width 1 — the canonical spelling, the only one ever EMITTED
/// - `-:` / `-: value` width 2 — the explicit conversion sugar, an unquoted `-` in key
///   position is the marker, not a key
///
/// The colon sits TIGHT against the dash and must be followed by space or EOL, so `-:x` is a
/// plain scalar and `- : x` stays a keyless entry holding a NULL-KEYED one. A literal `-`
/// key is quoted (see [`key_text`]) — the same trade the plain numeric key makes.
///
/// `yaml` = the YAML concrete, where `-: v` is faithfully the string key `-` and only the
/// dash counts.
pub fn seq_mark_len(text: &str, yaml: bool) -> Option<usize> {
    if text == "-" || text.starts_with("- ") {
        return Some(1);
    }
    if !yaml && (text == "-:" || text.starts_with("-: ")) {
        return Some(2);
    }
    None
}

/// The content past a keyless marker, trimmed — None when the line opens no keyless entry.
pub fn strip_seq_mark(text: &str, yaml: bool) -> Option<&str> {
    seq_mark_len(text, yaml).map(|n| text[n..].trim())
}

/// The CANONICAL key emission. Plain keys carry the pointer-metachar escaping
/// (docs/language/pointers/escaping); keys the line grammar itself would misread are
/// double-quoted instead. A NUMERIC key is always quoted (the YAML-keys round): bare `1:` is
/// a position claim — a parse error — so the string key "1" round-trips as `"1":`.
///
/// Shared with the PARSER: an authored key token that differs from this emission is
/// representation worth keeping (`EntryMeta::key_raw`), and "differs" must be judged by the
/// one law.
pub fn key_text(key: &str) -> String {
    let needs_quote = key.is_empty()
        || key != key.trim()
        || key.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f)
        // split_kv would split at the inner colon
        || key.contains(": ")
        // the emitted line would open a KEYLESS entry, not a key
        || seq_mark_len(&format!("{key}: "), false).is_some()
        // a bare numeric key reads as a position — quote the string key
        || is_all_digits(key)
        || key.starts_with('\'')
        || key.starts_with('"')
        // plain keys are backslash-UNescaped on parse
        || key.contains('\\');

    if needs_quote {
        return dq(key);
    }
    // escape the pointer metachars (incl. the escaping reservations) — parse strips them back
    escape_chars(key, |c| {
        matches!(c, '/' | '[' | ']' | '*' | '&' | '#' | '~' | '?' | '!' | '(' | ')' | '<' | '>' | '=' | '|')
    })
}

/// The FLOW key emission: bare when word-like, single-quoted otherwise (the flow separators
/// make more tokens unsafe than the block line grammar does). A lone `-` is the KEYLESS
/// marker on both surfaces, so the literal key is quoted — but `-1` and `a-b` stay bare
/// word-like keys.
pub fn flow_key_text(k: &str) -> String {
    if k == "-" {
        return "'-'".to_string();
    }
    // JS `\w` is ASCII-only: [A-Za-z0-9_]. Cyrillic is NOT word-like here, so it quotes.
    let word_like = !k.is_empty()
        && k.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '$' | '/' | '-'));
    if word_like {
        k.to_string()
    } else {
        format!("'{}'", k.replace('\'', "''"))
    }
}

/// Is this authored key token REPRESENTATION worth keeping (`EntryMeta::key_raw`)? — iff
/// EITHER canonical emitter (block [`key_text`], flow [`flow_key_text`]) would spell the key
/// differently. A `{}` token key is `key_text`-canonical but flow would quote it: without
/// the raw, a flow round-trip drifts to `'{}'`.
pub fn key_raw_worth_keeping(raw: &str, key: &str) -> bool {
    raw != key_text(key) || raw != flow_key_text(key)
}

/// The CANONICAL (colon-form, spaced) path text of a bookmark token (after `&`):
/// re-rendered from base + steps — the dual window emits `:` regardless of how the bookmark
/// was authored — plus the ordinal trailing `-` segment.
pub fn anchor_body(a: &Anchor) -> String {
    let mut s = render_pointer(&a.path, true);
    if a.ordinal {
        s.push_str(": -");
    }
    s
}

/// Deprecated `~` back entries re-emit as `&` anchors (serializers emit anchors only) — but
/// ONLY the absolute-scoped ones: an anchor path resolves from the node's CONTAINER while a
/// back entry's pointer resolves from the node itself, so a current-/parent-scoped raw
/// cannot be transplanted verbatim. Those (none in the corpus) keep the `~` spelling through
/// the migration window.
pub fn is_anchorizable_back(e: &Entry) -> bool {
    e.edge == EdgeKind::Back
        && matches!(
            e.value.as_pointer().map(|p| &p.base),
            Some(PointerBase::Document) | Some(PointerBase::Link { .. })
        )
}

/// The bookmark-token body equivalent of a back entry, in canonical colon form:
/// `~k: *P` → `P: k`, `~- *P` → `P: -`.
pub fn back_anchor_body(e: &Entry) -> Result<String> {
    let Value::Pointer(p) = &e.value else {
        return Err(LossyError::new("a back entry must hold a pointer"));
    };
    match &e.key {
        None => Ok(format!("{}: -", render_pointer(p, true))),
        Some(k) => {
            let mut with_key = p.clone();
            with_key.steps.push(Step::Key { name: k.clone() });
            Ok(render_pointer(&with_key, true))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::{Node, Pointer};

    #[test]
    fn dq_matches_json_stringify() {
        assert_eq!(dq("plain"), "\"plain\"");
        assert_eq!(dq("a\"b"), "\"a\\\"b\"");
        assert_eq!(dq("a\\b"), "\"a\\\\b\"");
        assert_eq!(dq("a\nb\tc\rd"), "\"a\\nb\\tc\\rd\"");
        assert_eq!(dq("\u{8}\u{c}"), "\"\\b\\f\"");
        assert_eq!(dq("\u{1}"), "\"\\u0001\"", "other controls take the \\u00xx form");
        assert_eq!(dq("\u{7f}"), "\"\u{7f}\"", "DEL is NOT escaped by JSON.stringify");
        assert_eq!(dq("Алиса 🐱"), "\"Алиса 🐱\"", "non-ASCII stays literal");
        assert_eq!(dq("a/b"), "\"a/b\"", "the solidus is not escaped");
    }

    #[test]
    fn the_keyless_marker_is_one_law() {
        assert_eq!(seq_mark_len("-", false), Some(1));
        assert_eq!(seq_mark_len("- v", false), Some(1));
        assert_eq!(seq_mark_len("-:", false), Some(2));
        assert_eq!(seq_mark_len("-: v", false), Some(2));
        assert_eq!(seq_mark_len("-:x", false), None, "the colon must be followed by space or EOL");
        assert_eq!(seq_mark_len("-x", false), None);
        assert_eq!(seq_mark_len("-: v", true), None, "in YAML `-:` is the string key `-`");
        assert_eq!(seq_mark_len("- : x", false), Some(1), "a keyless entry holding a null-keyed one");
    }

    #[test]
    fn strip_seq_mark_trims_the_remainder() {
        assert_eq!(strip_seq_mark("-   v  ", false), Some("v"));
        assert_eq!(strip_seq_mark("-", false), Some(""));
        assert_eq!(strip_seq_mark("k: v", false), None);
    }

    #[test]
    fn a_numeric_key_is_quoted_because_bare_would_claim_a_position() {
        assert_eq!(key_text("1"), "\"1\"");
        assert_eq!(key_text("007"), "\"007\"");
        assert_eq!(key_text("1a"), "1a", "not pure digits — rides bare");
    }

    #[test]
    fn a_key_that_would_open_a_keyless_entry_is_quoted() {
        assert_eq!(key_text("-"), "\"-\"", "`- : v` would open a keyless entry");
        assert_eq!(key_text("-a"), "-a", "not the marker — rides bare");
        // `-:` emits BARE: the probe is seq_mark_len("-:: "), and "-:: " is neither "-:" nor
        // prefixed "-: " (the third char is a colon, not a space). So the line `-:: v`
        // reparses as the key `-:` — no marker, no ambiguity, no quoting needed.
        assert_eq!(key_text("-:"), "-:");
    }

    #[test]
    fn a_key_containing_colon_space_is_quoted_because_split_kv_would_cut_it() {
        assert_eq!(key_text("a: b"), "\"a: b\"");
        assert_eq!(key_text("a:b"), "a:b", "no space after the colon — safe bare");
    }

    #[test]
    fn key_text_escapes_slash_but_not_colon() {
        assert_eq!(key_text("a/b"), "a\\/b", "`/` is IN the key_text set");
        assert_eq!(key_text("a*b"), "a\\*b");
        assert_eq!(key_text("a\\b"), "\"a\\\\b\"", "a backslash forces quoting");
    }

    #[test]
    fn padded_and_empty_keys_quote() {
        assert_eq!(key_text(""), "\"\"");
        assert_eq!(key_text(" a"), "\" a\"");
        assert_eq!(key_text("a "), "\"a \"");
    }

    #[test]
    fn flow_keys_are_ascii_word_like_or_quoted() {
        assert_eq!(flow_key_text("abc"), "abc");
        assert_eq!(flow_key_text("a-b"), "a-b");
        assert_eq!(flow_key_text("-1"), "-1");
        assert_eq!(flow_key_text("-"), "'-'");
        assert_eq!(flow_key_text("a b"), "'a b'");
        assert_eq!(flow_key_text("имя"), "'имя'", "JS \\w is ASCII-only, so Cyrillic quotes in FLOW");
        assert_eq!(flow_key_text("it's"), "'it''s'");
    }

    #[test]
    fn an_anchor_body_renders_canonically_with_the_ordinal_tail() {
        let path = Pointer::new(
            PointerBase::Link { authority: "yamlover".into(), world: false },
            vec![Step::Key { name: "ontos".into() }, Step::Key { name: "верхушка".into() }],
        );
        assert_eq!(
            anchor_body(&Anchor { path: path.clone(), ordinal: true }),
            ":: yamlover: ontos: верхушка: -"
        );
        assert_eq!(
            anchor_body(&Anchor { path, ordinal: false }),
            ":: yamlover: ontos: верхушка"
        );
    }

    #[test]
    fn back_entries_convert_to_anchor_bodies() {
        let p = Pointer::new(PointerBase::Document, vec![Step::Key { name: "a".into() }]);

        let mut keyed = Entry::keyed("k", Value::Pointer(p.clone()));
        keyed.edge = EdgeKind::Back;
        assert_eq!(back_anchor_body(&keyed).unwrap(), ": a: k");

        let mut keyless = Entry::keyless(Value::Pointer(p));
        keyless.edge = EdgeKind::Back;
        assert_eq!(back_anchor_body(&keyless).unwrap(), ": a: -");
    }

    #[test]
    fn only_absolute_scoped_backs_are_anchorizable() {
        let doc = Pointer::new(PointerBase::Document, vec![]);
        let cur = Pointer::new(PointerBase::Current, vec![Step::Key { name: "a".into() }]);

        let mut a = Entry::keyed("k", Value::Pointer(doc));
        a.edge = EdgeKind::Back;
        assert!(is_anchorizable_back(&a));

        let mut b = Entry::keyed("k", Value::Pointer(cur));
        b.edge = EdgeKind::Back;
        assert!(!is_anchorizable_back(&b), "a current-scoped raw cannot be transplanted");

        let contain = Entry::keyed("k", Value::Node(Node::string("v")));
        assert!(!is_anchorizable_back(&contain));
    }

    #[test]
    fn key_raw_is_worth_keeping_when_either_emitter_disagrees() {
        assert!(!key_raw_worth_keeping("abc", "abc"));
        // `{}` is key_text-canonical but FLOW would quote it — so the raw matters
        assert!(key_raw_worth_keeping("{}", "{}"));
        assert!(key_raw_worth_keeping("\"a\"", "a"), "quoted-by-choice");
    }
}
