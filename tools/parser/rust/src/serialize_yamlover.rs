// IR → yamlover text. Port of ts/src/serialize-yamlover.ts.
//
// FREE-FORM canonical emission: the IR keeps the graph, not the typography (comments, quote
// styles and block-scalar layout are not stored — IR.md), so the output is a clean
// re-rendering whose reparse is IR-EQUAL to the input: same values, entry order, keys, edge
// kinds, pointer texts, anchors, `!!set` and `!!<…>` schema tags. The no-op shape tags
// `!!mix` (a mixed keyed+keyless container) and `!!var` (a scalar-plus-fields) are NOT
// emitted — omni is the default, so an untagged mixture reparses to the same IR.
// Inexpressible content — blobs, an anchored document root — raises LossyError: refuse,
// never drop.

// NOT PORTED YET — the INLINE CONCRETE SWITCH (`NodeMeta::concrete == "json5p"`, a flow token
// that spans lines in K&R braces). ts/src/serialize-yamlover.ts routes those through
// `json5pLines` → `serialize-json5p.ts`, which this crate does not have yet. Omitting it is
// SAFE but not free: such a node degrades to block form, which reparses to the same IR (the
// concrete stamp is typography, ignored by canon) but is not byte-identical to the TS golden.
// So it is a known gap in the byte gate, not a correctness hole — it lands with the json5p
// serializer.

use crate::ir::{
    Comment, Document, EdgeKind, Entry, Node, Placement, Pointer, ScalarValue, Value,
};
use crate::number::js_number_to_string;
use crate::pointer::render_pointer;
use crate::scalar::{fold_lines, plain_scalar, split_kv, unquote_key};
use crate::serialize_common::{
    LossyError, Result, anchor_body, back_anchor_body, dq, flow_key_text, is_anchorizable_back,
    key_text, seq_mark_len,
};

const STEP: usize = 2;

/// Prose folds at this column when the serializer WRAPS a minted string (see [`folded_lines`])
/// — the source-file measure, independent of any reader's display width.
///
/// Counted in UTF-16 code units, because that is what JS `String.length` counts and the
/// goldens were produced there. For the Cyrillic prose this will mostly meet, a code unit is
/// a character; for astral text (emoji) it is two, and matching that is the whole point.
const FOLD_WIDTH: usize = 100;

/// Emit options. `comments` re-emits the retained comments (IR.md); off by default, so the
/// output stays byte-identical to a comment-free serialization.
#[derive(Debug, Clone, Copy, Default)]
pub struct SerializeOpts {
    pub comments: bool,
}

pub fn serialize_yamlover(doc: &Document, opts: SerializeOpts) -> Result<String> {
    Emitter { out: Vec::new(), doc, comments: opts.comments }.serialize()
}

struct Emitter<'a> {
    out: Vec<String>,
    doc: &'a Document,
    comments: bool,
}

// ---------------------------------------------------------------------------
// A block scalar's header line and its content lines
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct BlockText {
    header: String,
    lines: Vec<String>,
}

impl<'a> Emitter<'a> {
    fn serialize(mut self) -> Result<String> {
        let root = &self.doc.root;
        if root.is_blob() {
            return Err(LossyError::new(
                "a blob has no yamlover text form (its bytes live in a file)",
            ));
        }
        if self.comments && !self.doc.head.is_empty() {
            for c in &self.doc.head {
                self.out.push(format!("#{}", c.text));
            }
            // a blank line sets the head banner off from the body (round-trips as head)
            self.out.push(String::new());
        }
        if let Some(schema) = &root.meta.schema {
            let tok = schema_tag_token(schema)?;
            self.out.push(tok);
        }
        let ents = &root.entries;
        // conv backs re-emit as anchors
        let kept = ents.iter().filter(|e| !is_anchorizable_back(e)).count();

        let mut root_trailing_done: Option<usize> = None;

        if root.is_scalar() {
            // A root omni self-value is written among its entries at its AUTHORED position
            // (`meta.self_at`, 0 = first) — order-preserving, though the value stays
            // positionless DATA. The omni SHAPE needs no tag (omni is the default), but the
            // SEMANTIC tags (`!!yo`, `!!set`) ride their own lone line first — the "lone tag
            // marks the document root" form.
            for tag in container_tags(root) {
                self.out.push(tag);
            }
            let at = root.meta.self_at.unwrap_or(0).min(ents.len());
            self.entries(&ents[..at], 0)?;
            let self_line_at = self.out.len();
            self.self_line(root, 0);
            // the value-trailing remark rides the self LINE (emit_trailing's law, the root
            // twin) — a block-scalar self keeps it below via the end-of-file push, never lost
            if self.comments && self.out.len() == self_line_at + 1 {
                if let Some((i, t)) = root
                    .meta
                    .comments
                    .iter()
                    .enumerate()
                    .find(|(_, c)| c.placement == Placement::Trailing)
                {
                    self.out[self_line_at].push_str(&format!(" #{}", t.text));
                    root_trailing_done = Some(i);
                }
            }
            self.root_anchors(root)?;
            self.entries(&ents[at..], 0)?;
        } else if kept == 0 {
            // the semantic container tags ride their own lines here too — an emptied tagged
            // root (a cleared data island) must not shed its identity
            for tag in container_tags(root) {
                self.out.push(tag);
            }
            self.out.push(if root.array { "[]" } else { "{}" }.to_string());
            self.root_anchors(root)?;
        } else if root.meta.schema.is_none()
            && root.meta.style_flow
            && flow_text_or_null(root).is_some()
        {
            // a whole DOCUMENT authored as one flow token (`[12, 13, 14]`, `{a: 1}`) stays
            // one line
            let tok = flow_text_or_null(root).expect("just checked");
            self.out.push(tok);
            self.root_anchors(root)?;
        } else {
            for tag in container_tags(root) {
                self.out.push(tag);
            }
            self.root_anchors(root)?;
            self.entries(ents, 0)?;
        }

        // comments with no entry to host them (after the last entry, trailing-of-file)
        if self.comments {
            for (i, c) in root.meta.comments.iter().enumerate() {
                if Some(i) == root_trailing_done {
                    continue; // already on the self line
                }
                self.out.push(format!("#{}", c.text));
            }
        }
        let mut s = self.out.join("\n");
        s.push('\n');
        Ok(s)
    }

    /// Root anchors go on their own lines (there is no key line to share) — the node's own
    /// `&` anchors plus its deprecated `~` back entries re-emitted in anchor form. Own-line
    /// colon-form anchors ride UNQUOTED (the token runs to end of line).
    fn root_anchors(&mut self, root: &Node) -> Result<()> {
        for t in anchor_tokens(root, true)? {
            self.out.push(t);
        }
        Ok(())
    }

    fn entries(&mut self, ents: &[Entry], indent: usize) -> Result<()> {
        let pad = " ".repeat(indent);
        for e in ents {
            if self.comments {
                // a BLANK source line before the entry (or before its leading-comment block)
                // is part of the retained typography — re-emit it so blank_before round-trips
                let lead = leading_of(e);
                let blank = e.meta.blank_before || lead.first().is_some_and(|c| c.blank_before);
                if blank && self.out.last().is_some_and(|l| !l.is_empty()) {
                    self.out.push(String::new());
                }
                for c in lead {
                    self.out.push(format!("{pad}#{}", c.text));
                }
            }
            let before = self.out.len();
            if is_anchorizable_back(e) {
                // re-emitted as an `&` anchor in decorations()/root_anchors(), not as `~`
                continue;
            } else if e.is_keyless() && e.edge == EdgeKind::Back {
                // a RELATIVE-scoped keyless back-edge keeps the `~-` spelling
                let Value::Pointer(p) = &e.value else {
                    return Err(LossyError::new(
                        r#"a keyless back-edge ("~-") must hold a pointer"#,
                    ));
                };
                self.out.push(format!("{pad}~- *{}", ptr_text(p)));
            } else if e.null_key {
                // the NULL KEY: canonical emission `~:` (the empty `: v` spelling is an alias)
                self.keyed("~:", &e.value, indent)?;
            } else if e.key.is_none() {
                self.seq_item(&e.value, indent)?;
            } else {
                let key = e.key.as_ref().expect("just checked");
                let head = format!(
                    "{}{}:",
                    if e.edge == EdgeKind::Back { "~" } else { "" },
                    authored_key(e).unwrap_or_else(|| key_text(key))
                );
                // a FLAT fold: the entry's children were authored on flat rows and the fold
                // is still lossless — emit them as flat rows with this head as the repeated
                // prefix; otherwise the concrete drops silently and the nested form emits
                let unique = ents.iter().filter(|s| s.key.as_deref() == Some(key)).count() == 1;
                if e.edge != EdgeKind::Back && emits_flat(&e.value) && unique {
                    let children = e.value.as_node().expect("emits_flat implies a node");
                    for c in &children.entries {
                        self.flat_child(&[head.clone()], c, indent)?;
                    }
                } else {
                    self.keyed(&head, &e.value, indent)?;
                }
            }
            if self.comments {
                self.emit_trailing(e, indent, before);
            }
        }
        Ok(())
    }

    /// One FLAT segment: descend while the fold stays lossless, else emit the LEAF row — the
    /// joined prefix through the ordinary pair machinery at the ROW's own indent, so the
    /// leaf's continuation block lands ONE STEP under the row, exactly as a normal key's
    /// block would (the one-step indentation law — flattening does real re-indentation work,
    /// it is never a pure line fold). A keyless element with container content takes this
    /// leaf path too: the trailing `-:` row plus its block — the only APPEND spelling.
    fn flat_child(&mut self, prefix: &[String], e: &Entry, indent: usize) -> Result<()> {
        let seg = match &e.key {
            None => "-".to_string(),
            Some(k) => authored_key(e).unwrap_or_else(|| key_text(k)),
        };
        let head = format!("{seg}:");
        if e.key.is_some() && emits_flat(&e.value) {
            let children = e.value.as_node().expect("emits_flat implies a node");
            let mut next: Vec<String> = prefix.to_vec();
            next.push(head);
            for c in &children.entries {
                self.flat_child(&next, c, indent)?;
            }
            return Ok(());
        }
        let joined = format!("{} {head}", prefix.join(" "));
        self.keyed(&joined, &e.value, indent)
    }

    /// A `trailing` comment rides the entry's line when the entry emitted a single line;
    /// otherwise (a block scalar / nested block) it falls to its own line below — never lost.
    fn emit_trailing(&mut self, e: &Entry, indent: usize, before: usize) {
        let Some(t) = e.meta.comments.iter().find(|c| c.placement == Placement::Trailing) else {
            return;
        };
        if self.out.len() == before + 1 && !self.out[before].contains('\n') {
            self.out[before].push_str(&format!(" #{}", t.text));
        } else {
            self.out.push(format!("{}#{}", " ".repeat(indent), t.text));
        }
    }

    /// The self-value of an omni scalar as a BARE line (or block-scalar lines) at `indent` —
    /// used when the value sits AMONG the entries at its authored position, rather than
    /// folded onto a `key:`/`- ` head. A multi-line value becomes a block scalar (content one
    /// STEP deeper, so a dedent back to `indent` ends it and the following entries resume).
    fn self_line(&mut self, v: &Node, indent: usize) {
        let pad = " ".repeat(indent);
        let block = match v.scalar_value() {
            Some(ScalarValue::Str(_)) => block_of(v),
            _ => None,
        };
        match block {
            Some(b) => {
                self.out.push(format!("{pad}{}", b.header));
                for l in b.lines {
                    self.out
                        .push(if l.is_empty() { String::new() } else { format!("{}{l}", " ".repeat(indent + STEP)) });
                }
            }
            None => {
                let tok = inline(v, true);
                self.out.push(format!("{pad}{tok}"));
            }
        }
    }

    /// A container's LEFTOVER comments — own-line remarks after its last entry, attached to
    /// the node meta (the comments.ts tail rule) — re-emitted inside the block, at the
    /// block's own indent, so the round-trip re-attaches them identically.
    fn tail_comments(&mut self, value: &Value, indent: usize) {
        if !self.comments {
            return;
        }
        let Value::Node(n) = value else { return };
        let pad = " ".repeat(indent);
        for c in n.meta.comments.iter().filter(|c| c.placement == Placement::Leading) {
            self.out.push(format!("{pad}#{}", c.text));
        }
    }

    /// Emit `head <value>` at `indent` — `head` is `key:`, `~key:`, or the `-` seq marker
    /// (their value/indent grammar is identical: a deeper block belongs to the entry).
    fn keyed(&mut self, head: &str, value: &Value, indent: usize) -> Result<()> {
        self.keyed_inner(head, value, indent)?;
        self.tail_comments(value, indent + STEP);
        Ok(())
    }

    fn keyed_inner(&mut self, head: &str, value: &Value, indent: usize) -> Result<()> {
        let pad = " ".repeat(indent);
        let value = match value {
            Value::Pointer(p) => {
                self.out.push(format!("{pad}{head} *{}", ptr_text(p)));
                return Ok(());
            }
            Value::Node(n) => n,
        };
        if value.is_blob() {
            return Err(LossyError::new(
                "a blob has no yamlover text form (its bytes live in a file)",
            ));
        }
        let parts = decorations(value)?;
        let ents = &value.entries;
        // conv backs ride `parts` as anchors
        let kept = ents.iter().filter(|e| !is_anchorizable_back(e)).count();

        if value.is_scalar() && value.meta.self_at.unwrap_or(0) > 0 && kept > 0 {
            // the self-value was authored AMONG the fields, not on the key line: emit a bare
            // head, then the fields with the value line interleaved at its position
            let inner = indent + STEP;
            let at = value.meta.self_at.expect("just checked").min(ents.len());
            self.out.push(join_line(&format!("{pad}{head}"), &parts));
            self.entries(&ents[..at], inner)?;
            self.self_line(value, inner);
            self.anchor_lines(value, inner)?;
            self.entries(&ents[at..], inner)?;
        } else if value.is_scalar() {
            let block = match value.scalar_value() {
                Some(ScalarValue::Str(_)) => block_of(value),
                _ => None,
            };
            match block {
                Some(b) => {
                    // block-scalar content sits DEEPER than any fields, so the fields' dedent
                    // ends the block (the parser's rule) while staying deeper than the key.
                    // Anchors dedent-terminate the block exactly like fields do — content
                    // must sit deeper.
                    let deeper = kept > 0 || !anchor_tokens(value, false)?.is_empty();
                    let inner = indent + STEP + if deeper { STEP } else { 0 };
                    let mut all = parts.clone();
                    all.push(b.header);
                    self.out.push(join_line(&format!("{pad}{head}"), &all));
                    for l in b.lines {
                        self.out.push(if l.is_empty() {
                            String::new()
                        } else {
                            format!("{}{l}", " ".repeat(inner))
                        });
                    }
                    // (anchors follow below, after the block — the dedent ends the scalar)
                }
                None => {
                    // a NON-NULL value with anchors forces a TOKEN spelling too: an own-line
                    // `&…` sits deeper than the key, and a PLAIN scalar would absorb it as a
                    // continuation line on the next parse (a null keeps its bare `key:`
                    // spelling — nothing to continue)
                    let non_null = !matches!(value.scalar_value(), Some(ScalarValue::Null));
                    let need_token = kept > 0
                        || !parts.is_empty()
                        || (non_null && !anchor_tokens(value, false)?.is_empty());
                    let tok = inline(value, need_token);
                    let all = if tok.is_empty() {
                        parts.clone()
                    } else {
                        let mut v = parts.clone();
                        v.push(tok);
                        v
                    };
                    self.out.push(join_line(&format!("{pad}{head}"), &all));
                }
            }
            self.anchor_lines(value, indent + STEP)?;
            self.entries(ents, indent + STEP)?;
        } else if kept == 0 {
            let mut all = parts.clone();
            all.push(if value.array { "[]" } else { "{}" }.to_string());
            self.out.push(join_line(&format!("{pad}{head}"), &all));
            self.anchor_lines(value, indent + STEP)?;
        } else if self.flow_line(&format!("{pad}{head}"), value, &parts) {
            // an AUTHORED flow container rides the key line as one token — nothing further
        } else {
            self.out.push(join_line(&format!("{pad}{head}"), &parts));
            self.anchor_lines(value, indent + STEP)?;
            self.entries(ents, indent + STEP)?;
        }
        Ok(())
    }

    /// Emit `head [1, 2]` when the node was AUTHORED in flow form and flow can still hold it
    /// losslessly. False ⇒ nothing was emitted and the caller writes block form, which is how
    /// a flow container that has since grown an anchor, a tag or a multiline value degrades
    /// gracefully instead of producing invalid source.
    fn flow_line(&mut self, head: &str, value: &Node, parts: &[String]) -> bool {
        if !value.meta.style_flow {
            return false;
        }
        let Some(tok) = flow_text_or_null(value) else { return false };
        let mut all = parts.to_vec();
        all.push(tok);
        self.out.push(join_line(head, &all));
        true
    }

    fn seq_item(&mut self, value: &Value, indent: usize) -> Result<()> {
        self.seq_item_inner(value, indent)?;
        self.tail_comments(value, indent + STEP);
        Ok(())
    }

    fn seq_item_inner(&mut self, value: &Value, indent: usize) -> Result<()> {
        let pad = " ".repeat(indent);
        if let Value::Node(n) = value
            && n.is_mapping()
        {
            let parts = decorations(n)?;
            let ents = &n.entries;
            let kept: Vec<&Entry> = ents.iter().filter(|e| !is_anchorizable_back(e)).collect();
            if kept.is_empty() {
                let mut all = parts.clone();
                all.push(if n.array { "[]" } else { "{}" }.to_string());
                self.out.push(join_line(&format!("{pad}-"), &all));
                self.anchor_lines(n, indent + STEP)?;
                return Ok(());
            }
            if self.flow_line(&format!("{pad}-"), n, &parts) {
                return Ok(()); // `- [1, 2]`
            }
            let anchored = !anchor_tokens(n, false)?.is_empty();
            let first = kept[0];
            if parts.is_empty()
                && !anchored
                && (first.key.is_some() || first.null_key || first.edge == EdgeKind::Contain)
            {
                // compact `- key: …` / `- - item`: render the entries, then fold the first
                // line onto the dash (STEP === the `- ` marker width, so the columns line up
                // exactly). A keyless first entry folds only when it is containment — a
                // leading `~-` back-edge stays block.
                let at = self.out.len();
                self.entries(ents, indent + STEP)?;
                let tail = self.out[at][indent + STEP..].to_string();
                self.out[at] = format!("{pad}- {tail}");
                return Ok(());
            }
            // a bare `-` (a `!!set` seq item keeps its tag)
            self.out.push(join_line(&format!("{pad}-"), &parts));
            self.anchor_lines(n, indent + STEP)?;
            self.entries(ents, indent + STEP)?;
            return Ok(());
        }
        self.keyed("-", value, indent)
    }

    /// The canonical anchor placement: own lines at `indent`, right after the value line
    /// (`path: 12` then `  &: another: path`).
    fn anchor_lines(&mut self, node: &Node, indent: usize) -> Result<()> {
        let pad = " ".repeat(indent);
        for t in anchor_tokens(node, true)? {
            self.out.push(format!("{pad}{t}"));
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Free helpers
// ---------------------------------------------------------------------------

/// Every anchor token a node carries: meta anchors + anchorizable `~` back entries
/// (serializers emit anchors, never `~`, for absolute scopes). `own_line` tokens run to EOL
/// so colon bodies ride bare; same-line tokens (the decorations on a key line) quote them.
fn anchor_tokens(node: &Node, own_line: bool) -> Result<Vec<String>> {
    let mut bodies: Vec<String> = node.meta.anchors.iter().map(anchor_body).collect();
    for e in &node.entries {
        if is_anchorizable_back(e) {
            bodies.push(back_anchor_body(e)?);
        }
    }
    Ok(bodies
        .into_iter()
        .map(|b| if own_line { format!("&{b}") } else { anchor_token(&b) })
        .collect())
}

/// Value-position prefixes, in the parser's reading order: the `!!<…>` schema, `!!yo`
/// (plain-yamlover, exempt from the enclosing schema) and `!!set` — the shape tags with
/// semantics (omni/`!!mix` is the default and is never emitted). Anchors are NOT here —
/// canonical style puts them on own lines.
fn decorations(node: &Node) -> Result<Vec<String>> {
    let mut parts = Vec::new();
    if let Some(schema) = &node.meta.schema {
        parts.push(schema_tag_token(schema)?);
    }
    parts.extend(container_tags(node));
    Ok(parts)
}

/// `!!yo` and `!!set` carry semantics and are emitted; `!!mix` is the DEFAULT shape
/// (omni-by-default), so it is never emitted — an untagged mixture parses back to the same
/// IR. `!!var`/`!!omni` are read as deprecated aliases of `!!yo` and re-emit as `!!yo`.
fn container_tags(node: &Node) -> Vec<String> {
    let mut tags = Vec::new();
    if node.meta.yo {
        tags.push("!!yo".to_string());
    }
    if node.meta.set {
        tags.push("!!set".to_string());
    }
    tags
}

fn leading_of(e: &Entry) -> Vec<&Comment> {
    e.meta.comments.iter().filter(|c| c.placement == Placement::Leading).collect()
}

fn join_line(head: &str, parts: &[String]) -> String {
    if parts.is_empty() { head.to_string() } else { format!("{head} {}", parts.join(" ")) }
}

fn ptr_text(p: &Pointer) -> String {
    // the dual window emits CANONICAL colon form (spaced) regardless of authoring style;
    // pointer_token includes the `*`, and the head adds its own
    pointer_token(&render_pointer(p, true))[1..].to_string()
}

/// The full yamlover deref token for a pointer raw: `*` + the raw, quoted only when outer
/// whitespace could not survive the line (rendered colon raws self-delimit: spacey keys
/// arrive PORTION-quoted, `#` arrives escaped — both from render_pointer).
pub fn pointer_token(raw: &str) -> String {
    if raw != raw.trim() {
        return format!("*'{}'", raw.replace('\'', "''"));
    }
    format!("*{raw}")
}

/// The full yamlover anchor token for a path body: `&` + body, quoted when the plain token
/// would be cut — anchor tokens end at whitespace, so a path with spaces (e.g. a Cyrillic tag
/// name) needs the quoted form.
pub fn anchor_token(body: &str) -> String {
    if body.starts_with('\'') || body.starts_with('"') || has_unquoted_space(body) {
        return format!("&'{}'", body.replace('\'', "''"));
    }
    format!("&{body}")
}

/// Whitespace OUTSIDE quoted portions — a space inside a quoted key rides fine.
fn has_unquoted_space(s: &str) -> bool {
    let b: Vec<char> = s.chars().collect();
    let mut q: Option<char> = None;
    let mut i = 0usize;
    while i < b.len() {
        let c = b[i];
        if let Some(qc) = q {
            if c == qc {
                q = None;
            }
            i += 1;
            continue;
        }
        if c == '\\' {
            i += 2;
            continue;
        }
        if c == '\'' || c == '"' {
            q = Some(c);
            i += 1;
            continue;
        }
        if c == ' ' || c == '\t' {
            return true;
        }
        i += 1;
    }
    false
}

/// The token is structurally safe in every context we emit (after `key:`, after `- `, alone
/// on a line): no sigil/marker/comment/kv misreads. Says nothing about what VALUE it reparses
/// to — see [`plain_safe`] (strings) and the raw check in [`inline`] (numbers).
fn plain_token(text: &str) -> bool {
    if text.is_empty() || text != text.trim() {
        return false;
    }
    let first = text.chars().next().expect("non-empty");
    if "'\"*&~!|>{[".contains(first) {
        return false; // value-position sigils & quotes
    }
    if seq_mark_len(text, false).is_some() {
        return false; // would read as a seq marker (`-`, `- x`, `-: x`)
    }
    if has_comment_start(text) {
        return false; // comment stripping
    }
    if split_kv(text).is_some() {
        return false; // would read as `key: value` in a compact item
    }
    // NB: \t (0x09) and \n (0x0a) are deliberately OUTSIDE this set, matching the TS regex
    if text.chars().any(|c| {
        let n = c as u32;
        n <= 0x08 || (0x0b..=0x1f).contains(&n) || n == 0x7f
    }) {
        return false;
    }
    true
}

/// `/(^|[ \t])#/` — a `#` at the start or after a space/tab begins a comment.
fn has_comment_start(text: &str) -> bool {
    let b: Vec<char> = text.chars().collect();
    for (i, &c) in b.iter().enumerate() {
        if c == '#' && (i == 0 || b[i - 1] == ' ' || b[i - 1] == '\t') {
            return true;
        }
    }
    false
}

/// A string is safe to emit as a PLAIN scalar iff the reparse (in every context we emit)
/// returns the identical string.
fn plain_safe(text: &str) -> bool {
    plain_token(text) && plain_scalar(text) == ScalarValue::Str(text.to_string())
}

/// The YAML float-special literal for a non-finite number (yamlover follows YAML).
fn non_finite(v: f64) -> String {
    if v.is_nan() {
        ".nan"
    } else if v > 0.0 {
        ".inf"
    } else {
        "-.inf"
    }
    .to_string()
}

/// A single-line scalar token (never contains a newline — multiline strings go through
/// [`block_lines`] or the double-quoted fallback). `need_token`: an empty rendering (`key:`)
/// is not available — e.g. omni fields follow, which would otherwise become the value.
fn inline(n: &Node, need_token: bool) -> String {
    let raw_full = n.raw().unwrap_or("");
    let raw = raw_full.trim();
    match n.scalar_value() {
        Some(ScalarValue::Null) => {
            // the null twin of the number-raw rule: an authored null SPELLING (`~`, `null`, …)
            // re-emits verbatim — `a: ~` stays `a: ~`, never silently thins to `a:`. A MINTED
            // null spells the default.
            if matches!(raw, "~" | "null" | "Null" | "NULL") {
                return raw.to_string();
            }
            if need_token { "null".to_string() } else { String::new() }
        }
        Some(&ScalarValue::Bool(b)) => {
            // the boolean twin of the raw law: an authored casing (`True`, `FALSE`) that
            // reparses to the same boolean re-emits verbatim
            if !raw.is_empty() && plain_token(raw) && plain_scalar(raw) == ScalarValue::Bool(b) {
                return raw.to_string();
            }
            if b { "true" } else { "false" }.to_string()
        }
        Some(&ScalarValue::Num(v)) => {
            if !v.is_finite() {
                return non_finite(v);
            }
            // keep the authored spelling (0x1F, 1.0, .5, -0) when it reparses to the same
            // number — sign-aware, so `-0` keeps its sign. A MINTED number spells the default.
            if !raw.is_empty()
                && plain_token(raw)
                && plain_scalar(raw) == ScalarValue::Num(v)
            {
                return raw.to_string();
            }
            if v == 0.0 && v.is_sign_negative() {
                "-0".to_string()
            } else {
                js_number_to_string(v)
            }
        }
        Some(ScalarValue::Str(v)) => {
            // the STRING twin of the number/null raw law: an authored one-line SPELLING that
            // provably reparses to the same string re-emits verbatim — quoting is a choice the
            // author made. Only the three canonical forms are accepted.
            if !raw_full.contains('\n') {
                if raw == format!("'{}'", v.replace('\'', "''")) {
                    return raw.to_string();
                }
                if raw == dq(v) {
                    return raw.to_string();
                }
                if !raw.is_empty()
                    && plain_token(raw)
                    && plain_scalar(raw) == ScalarValue::Str(v.clone())
                {
                    return raw.to_string();
                }
            }
            if v.is_empty() {
                return "''".to_string();
            }
            if v.contains('\n')
                || v.chars().any(|c| {
                    let k = c as u32;
                    k <= 0x08 || (0x0b..=0x1f).contains(&k) || k == 0x7f
                })
            {
                return dq(v);
            }
            if plain_safe(v) {
                return v.clone();
            }
            format!("'{}'", v.replace('\'', "''"))
        }
        None => String::new(), // not a scalar — the caller never asks
    }
}

// ---- flat rows -----------------------------------------------------------------

/// Does `v` still emit as FLAT rows losslessly? A bare mapping whose children all wear the
/// `yamlover/key/flat` concrete, none decorated, no duplicate keys (a duplicate's second fold
/// would PAVE into the first on reparse), no null keys, no back edges, no comments between
/// segments — the doc's silent-fallback list.
pub fn emits_flat(v: &Value) -> bool {
    let Value::Node(n) = v else { return false };
    if !n.is_mapping() {
        return false;
    }
    let m = &n.meta;
    if m.schema.is_some() || m.set || m.yo || m.style_flow || m.concrete.is_some() {
        return false;
    }
    if !m.anchors.is_empty() || !m.comments.is_empty() {
        return false;
    }
    if n.entries.is_empty() {
        return false;
    }
    let mut seen = std::collections::HashSet::new();
    for e in &n.entries {
        if e.meta.key_concrete.is_none() {
            return false;
        }
        if e.null_key || !matches!(e.edge, EdgeKind::Contain | EdgeKind::Ref) {
            return false;
        }
        if !e.meta.comments.is_empty() || e.meta.blank_before {
            return false;
        }
        if let Some(k) = &e.key
            && !seen.insert(k.clone())
        {
            return false;
        }
    }
    true
}

// ---- authored keys -------------------------------------------------------------

/// The AUTHORED key token (`EntryMeta::key_raw`), if it survives the reparse guard: the token
/// must still read as this very key, must still split as a key at all, and must be QUOTED
/// wherever the canonical emission quotes — a stale or hand-forged raw must never change what
/// the document says.
///
/// That last clause is load-bearing, because [`key_text`] quotes exactly the keys whose bare
/// spelling the line grammar MISREADS: `-` / `- x` (the keyless marker) and a plain numeric
/// key (a position claim — a parse ERROR). A `.yaml` file mints such raws for real — there
/// `1: 12` IS the integer key and `-: 12` IS the string key `-` — so without this, reading
/// YAML and writing yamlover emitted a document that would not reparse.
fn authored_key(e: &Entry) -> Option<String> {
    let raw = e.meta.key_raw.as_ref()?;
    let key = e.key.as_ref()?;
    if unquote_key(raw) != *key {
        return None;
    }
    if key_text(key).starts_with('"') && !(raw.starts_with('\'') || raw.starts_with('"')) {
        return None;
    }
    let sp = split_kv(&format!("{raw}: v"))?;
    if sp.key == *raw { Some(raw.clone()) } else { None }
}

/// The FLOW-position twin: the raw must also be safe among the flow separators — a quoted
/// token, a balanced flow token, or a plain token free of `,`/braces/brackets. A
/// block-only-safe raw (`a,b`) falls back to the canonical flow key.
fn authored_flow_key(e: &Entry) -> Option<String> {
    let raw = authored_key(e)?;
    if raw.starts_with(['\'', '"', '[', '{']) {
        return Some(raw);
    }
    if raw.contains([',', '{', '}', '[', ']']) { None } else { Some(raw) }
}

// ---- schema tags ---------------------------------------------------------------

/// The contents of a `!!<…>` tag: a pointer (`*…`) or an inline node. `>` would close the tag
/// early — refuse it.
pub fn schema_text(v: &Value) -> Result<String> {
    let text = match v {
        Value::Pointer(p) => format!("*{}", render_pointer(p, true)),
        Value::Node(n) => schema_node_text(n)?,
    };
    if text.contains('>') || text.contains('\n') {
        return Err(LossyError::new(format!(
            r#"a !!<…> schema tag cannot contain ">" or a newline: {text}"#
        )));
    }
    Ok(text)
}

/// The full `!!<…>` tag token for an attached schema — the canonical rendering of a tag
/// application.
pub fn schema_tag_token(v: &Value) -> Result<String> {
    Ok(format!("!!<{}>", schema_text(v)?))
}

/// The one-line rendering of an inline `!!<…>` schema node. Top level: a scalar, a keyless
/// seq (`[…]`), or ONE `key: value` block one-liner; nested values may be flow.
fn schema_node_text(n: &Node) -> Result<String> {
    if n.is_mapping() {
        let ents = &n.entries;
        let keyed = ents.iter().filter(|e| e.key.is_some()).count();
        if keyed == ents.len() && ents.len() == 1 && ents[0].edge != EdgeKind::Back {
            let e = &ents[0];
            let v = match &e.value {
                Value::Pointer(p) => flow_ptr(p)
                    .ok_or_else(|| LossyError::new("this pointer has no flow form"))?,
                Value::Node(inner) => flow_text(inner)?,
            };
            return Ok(format!("{}: {v}", key_text(e.key.as_ref().expect("keyed"))));
        }
        if keyed > 0 {
            // `{a: 1, b: 2}` on one line is read as a BLOCK `key:` line, not flow — refuse
            return Err(LossyError::new(
                "an inline !!<…> schema holds at most one top-level key",
            ));
        }
    }
    flow_text(n)
}

/// Single-line FLOW rendering for the `!!<…>` tag interior, where there is NO block fallback —
/// so anything flow cannot hold is an error.
fn flow_text(n: &Node) -> Result<String> {
    flow_text_or_null(n).ok_or_else(|| LossyError::new("this node has no flow form"))
}

/// Single-line FLOW rendering, or None when flow cannot hold the node LOSSLESSLY.
///
/// THE REFUSAL LIST IS A CONTRACT: the projectional editor's `flowFits` mirrors it exactly, so
/// a container the editor still draws as flow cells is one this can still write. Adding a
/// refusal here without adding it there makes the screen and the file disagree.
fn flow_text_or_null(n: &Node) -> Option<String> {
    if n.is_blob() {
        return None; // a blob's bytes live in a file, not in a token
    }
    if n.meta.schema.is_some() || n.meta.set || n.meta.yo {
        return None; // a tag needs its own line
    }
    // a path anchor has NO flow spelling — emitting the node inline would silently drop it
    if !n.meta.anchors.is_empty() {
        return None;
    }
    // a LEADING comment has nowhere to live on a one-liner. A trailing one still rides.
    if n.entries
        .iter()
        .any(|e| e.meta.comments.iter().any(|c| c.placement != Placement::Trailing))
    {
        return None;
    }
    if n.meta.comments.iter().any(|c| c.placement == Placement::Leading) {
        return None; // a tail comment needs its block
    }
    let ents = &n.entries;
    if n.is_scalar() {
        if !ents.is_empty() {
            return None; // a value-plus-fields (omni) node needs two lines
        }
        return flow_tok(n);
    }
    if ents.is_empty() {
        return Some(if n.array { "[]" } else { "{}" }.to_string());
    }
    // the null key is KEYED
    let keyed = ents.iter().filter(|e| e.key.is_some() || e.null_key).count();
    if keyed > 0 && keyed < ents.len() {
        return None; // a mixed container has no flow form
    }
    if ents.iter().any(|e| e.edge == EdgeKind::Back) {
        return None; // a `~` back-edge is authored on its own line
    }
    let mut items = Vec::with_capacity(ents.len());
    for e in ents {
        let v = match &e.value {
            Value::Pointer(p) => flow_ptr(p)?,
            Value::Node(inner) => flow_text_or_null(inner)?,
        };
        // one unrepresentable member demotes the whole token
        if e.is_keyless() {
            items.push(v);
        } else {
            let k = if e.null_key {
                "~".to_string()
            } else {
                authored_flow_key(e)
                    .unwrap_or_else(|| flow_key_text(e.key.as_ref().expect("keyed")))
            };
            items.push(format!("{k}: {v}"));
        }
    }
    Some(if keyed == 0 {
        format!("[{}]", items.join(", "))
    } else {
        format!("{{{}}}", items.join(", "))
    })
}

fn flow_tok(n: &Node) -> Option<String> {
    let raw = n.raw().unwrap_or("").trim().to_string();
    match n.scalar_value()? {
        ScalarValue::Null => Some("null".to_string()),
        &ScalarValue::Bool(b) => Some(if b { "true" } else { "false" }.to_string()),
        &ScalarValue::Num(v) => {
            if !v.is_finite() {
                return Some(non_finite(v));
            }
            // Keep the AUTHORED spelling (0xff, 1.0, .5, -0) when it reparses to the same
            // number and holds no flow metachar — so a number's representation concrete
            // survives a flow round-trip too.
            if !raw.is_empty()
                && !raw.chars().any(|c| ",:[]{}'\"#".contains(c) || c.is_whitespace())
                && plain_token(&raw)
                && plain_scalar(&raw) == ScalarValue::Num(v)
            {
                return Some(raw);
            }
            Some(if v == 0.0 && v.is_sign_negative() {
                "-0".to_string()
            } else {
                js_number_to_string(v)
            })
        }
        ScalarValue::Str(v) => {
            if !v.is_empty()
                && !v.chars().any(|c| ",:[]{}'\"#".contains(c) || c.is_whitespace())
                && !"*&~!|>".contains(v.chars().next().expect("non-empty"))
                && plain_scalar(v) == ScalarValue::Str(v.clone())
            {
                return Some(v.clone());
            }
            if v.chars().any(|c| {
                let k = c as u32;
                k == 0x0a || k == 0x0d || k <= 0x08 || (0x0b..=0x1f).contains(&k) || k == 0x7f
            }) {
                return None; // a control char needs a quoted or block form
            }
            Some(format!("'{}'", v.replace('\'', "''")))
        }
    }
}

fn flow_ptr(p: &Pointer) -> Option<String> {
    // flow plain pointers read to the next , } ] at depth 0 — emit COMPACT colon form;
    // a quoted portion (spacey key) cannot ride plain in flow
    let compact = render_pointer(p, false);
    if compact.chars().any(|c| c == '\'' || c == '"' || c.is_whitespace()) {
        return None;
    }
    Some(format!("*{compact}"))
}

// ---- block scalars -------------------------------------------------------------

/// UTF-16 code units, which is what JS `String.length` counts — the goldens were produced
/// there, so the fold width must be measured the same way.
fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// The block spelling of a string scalar, by the raw-first law:
///  1. the AUTHORED block raw (`|`/`>` + content), when it still reparses to the very value;
///  2. a MINTED long one-paragraph string folds (`>-`/`>`, wrapped at [`FOLD_WIDTH`]);
///  3. a multiline value renders literal;
///  4. None — the caller emits the inline token.
///
/// A PARSED scalar always carries its raw, so authored plain/quoted spellings never reflow.
fn block_of(n: &Node) -> Option<BlockText> {
    let Some(ScalarValue::Str(v)) = n.scalar_value() else { return None };
    if let Some(authored) = raw_block(n, v) {
        return Some(authored);
    }
    if n.raw().is_none()
        && let Some(folded) = folded_lines(v)
    {
        return Some(folded);
    }
    if v.contains('\n') { block_lines(v) } else { None }
}

/// The authored block raw re-emitted verbatim — iff it reparses to the same value (the
/// chomping/folding math mirrors the parser's blockScalar, whose raw this is).
fn raw_block(n: &Node, value: &str) -> Option<BlockText> {
    let raw = n.raw().unwrap_or("");
    let (header, rest) = match raw.find('\n') {
        Some(i) => (&raw[..i], Some(&raw[i + 1..])),
        None => (raw, None),
    };
    if !is_block_header(header) {
        return None;
    }
    let lines: Vec<String> = match rest {
        None => Vec::new(),
        Some(r) => r.split('\n').map(str::to_string).collect(),
    };
    if first_content_indented(&lines) {
        return None; // the indent base cannot re-anchor (see block_lines)
    }
    if lines.iter().any(|l| !l.is_empty() && l.chars().all(|c| c == ' ')) {
        return None; // all-space lines reparse as empty
    }
    let folded = header.starts_with('>');
    let chomp = if header.contains('-') {
        Chomp::Strip
    } else if header.contains('+') {
        Chomp::Keep
    } else {
        Chomp::Clip
    };
    let last: i64 = lines
        .iter()
        .enumerate()
        .filter(|(_, l)| !l.is_empty())
        .map(|(i, _)| i as i64)
        .next_back()
        .unwrap_or(-1);
    let core: Vec<String> = lines[..(last + 1) as usize].to_vec();
    let mut body = if folded { fold_lines(&core) } else { core.join("\n") };
    match chomp {
        Chomp::Keep => {
            let extra = lines.len() - (last + 1) as usize + if last >= 0 { 1 } else { 0 };
            body.push_str(&"\n".repeat(extra));
        }
        Chomp::Clip if last >= 0 => body.push('\n'),
        _ => {}
    }
    if body == value { Some(BlockText { header: header.to_string(), lines }) } else { None }
}

enum Chomp {
    Strip,
    Keep,
    Clip,
}

/// `^[|>][+-]?$`
fn is_block_header(h: &str) -> bool {
    let b = h.as_bytes();
    match b.len() {
        1 => b[0] == b'|' || b[0] == b'>',
        2 => (b[0] == b'|' || b[0] == b'>') && (b[1] == b'+' || b[1] == b'-'),
        _ => false,
    }
}

/// A minted long string as a FOLDED block, wrapped at [`FOLD_WIDTH`]. Paragraph gaps (`\n\n`+)
/// spell as blank lines; a LONE `\n` has no folded spelling — those stay literal. None when
/// folding cannot hold the value losslessly.
fn folded_lines(v: &str) -> Option<BlockText> {
    if v.contains('\r') {
        return None;
    }
    let (body, trailing) = split_trailing_newlines(v);
    if trailing > 1 {
        return None;
    }
    if body.is_empty() || utf16_len(body) <= FOLD_WIDTH {
        return None;
    }
    if has_lone_newline(body) {
        return None; // a lone \n is unspellable folded
    }
    if body.starts_with('\n') {
        return None; // a leading blank line — literal territory
    }
    let mut lines: Vec<String> = Vec::new();
    for part in split_keeping_newline_runs(body) {
        if part.is_empty() {
            continue;
        }
        if part.starts_with('\n') {
            // `\n\n` is ONE paragraph break: n newlines yield n-1 blank lines
            for _ in 1..part.len() {
                lines.push(String::new());
            }
            continue;
        }
        if part.starts_with(' ') || part.starts_with('\t') {
            return None; // a paragraph must anchor the indent base
        }
        lines.extend(wrap_para(part));
    }
    if lines.len() < 2 {
        return None; // nothing folded — the inline token is simpler
    }
    // the round-trip guard, absolute: the parser's own fold must give the very body back
    if fold_lines(&lines) == body {
        Some(BlockText {
            header: if trailing == 0 { ">-" } else { ">" }.to_string(),
            lines,
        })
    } else {
        None
    }
}

/// Render a multiline string as a literal block scalar, or None if the block form cannot hold
/// it losslessly (the parser de-indents by the FIRST content line and reads all-space lines as
/// empty): then the caller falls back to a double-quoted scalar.
fn block_lines(v: &str) -> Option<BlockText> {
    if v.contains('\r') {
        return None;
    }
    let (body, trailing) = split_trailing_newlines(v);
    if body.is_empty() {
        return None; // whitespace-only string
    }
    let mut lines: Vec<String> = body.split('\n').map(str::to_string).collect();
    // The parser anchors the block's indent on the first NON-EMPTY line, so that is the line
    // that must not be indented. Testing `lines[0]` misses a LEADING BLANK LINE:
    // `\n indented\nless\n` emitted a block anchored at the deeper column and the shallower
    // line dedented out of it — source that does not reparse. Found by importing real mail
    // (5 of 2,746 messages) and fixed in both implementations.
    if first_content_indented(&lines) {
        return None;
    }
    if lines.iter().any(|l| !l.is_empty() && l.chars().all(|c| c == ' ')) {
        return None; // all-space lines read as empty
    }
    let header = match trailing {
        0 => "|-",
        1 => "|",
        _ => "|+",
    };
    for _ in 1..trailing {
        lines.push(String::new());
    }
    Some(BlockText { header: header.to_string(), lines })
}

/// Is the first NON-EMPTY line indented? That line is what the parser takes as the block's
/// indent base, so an indented one makes every shallower line below it a dedent — ending the
/// block early and turning its tail into a second scalar value line.
fn first_content_indented(lines: &[String]) -> bool {
    lines
        .iter()
        .find(|l| !l.is_empty())
        .is_some_and(|l| l.starts_with(' ') || l.starts_with('\t'))
}

/// `(body, trailing_newline_count)`.
fn split_trailing_newlines(v: &str) -> (&str, usize) {
    let stripped = v.trim_end_matches('\n');
    (stripped, v.len() - stripped.len())
}

/// `/(?<!\n)\n(?!\n)/` — a newline with no newline on either side.
fn has_lone_newline(s: &str) -> bool {
    let b = s.as_bytes();
    for i in 0..b.len() {
        if b[i] == b'\n'
            && (i == 0 || b[i - 1] != b'\n')
            && (i + 1 >= b.len() || b[i + 1] != b'\n')
        {
            return true;
        }
    }
    false
}

/// JS `body.split(/(\n+)/)` — alternating text runs and newline runs, separators kept.
fn split_keeping_newline_runs(s: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let b = s.as_bytes();
    let mut i = 0usize;
    let mut start = 0usize;
    while i < b.len() {
        if b[i] == b'\n' {
            out.push(&s[start..i]);
            let run = i;
            while i < b.len() && b[i] == b'\n' {
                i += 1;
            }
            out.push(&s[run..i]);
            start = i;
        } else {
            i += 1;
        }
    }
    out.push(&s[start..]);
    out
}

/// Greedy wrap of one paragraph: break at a SINGLE space between non-spaces (folding rejoins
/// with exactly one space) — the last such point within the width, else the first beyond it;
/// an unbreakable run simply stays long.
///
/// Indexed in UTF-16 code units to match JS. A space is one code unit and can never be half of
/// a surrogate pair, so slicing at a break point is always on a character boundary.
fn wrap_para(para: &str) -> Vec<String> {
    const SP: u16 = b' ' as u16;
    let mut lines = Vec::new();
    let mut rest: Vec<u16> = para.encode_utf16().collect();
    while rest.len() > FOLD_WIDTH {
        let mut cut: Option<usize> = None;
        for i in (1..=FOLD_WIDTH).rev() {
            if rest.get(i) == Some(&SP)
                && rest.get(i - 1) != Some(&SP)
                && rest.get(i + 1) != Some(&SP)
                && rest.get(i + 1).is_some()
            {
                cut = Some(i);
                break;
            }
        }
        if cut.is_none() {
            for i in (FOLD_WIDTH + 1)..rest.len().saturating_sub(1) {
                if rest[i] == SP && rest[i - 1] != SP && rest[i + 1] != SP {
                    cut = Some(i);
                    break;
                }
            }
        }
        let Some(c) = cut else { break };
        lines.push(String::from_utf16_lossy(&rest[..c]));
        rest = rest[c + 1..].to_vec();
    }
    if !rest.is_empty() {
        lines.push(String::from_utf16_lossy(&rest));
    }
    lines
}
