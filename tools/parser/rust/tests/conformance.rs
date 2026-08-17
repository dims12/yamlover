//! THE BYTE GATE: this serializer must reproduce `test-examples/`'s `out.yo` goldens exactly.
//!
//! Those goldens were produced by `tools/parser/ts`'s serializer and are asserted byte-for-byte
//! by the TS harness too (`tools/engine/ts/test/fixtures.test.ts`), so agreeing with them is
//! agreeing with the reference implementation across the whole corpus at once — 136 documents
//! covering scalars, containers, pointers, anchors, omni, tags, comments, block scalars and
//! directory concretes.
//!
//! Run:
//!
//! ```sh
//! node tools/parser/rust/tests/gen-ir-full.mjs   # once, and after any fixture change
//! cargo test --test conformance
//! ```
//!
//! The first step exists because there is no Rust parser yet, so the IR has to come from
//! somewhere; see `gen-ir-full.mjs` for why the committed `ir.json` cannot serve. When the
//! parser lands this test reads the fixture sources directly and the scaffold goes away.

use serde_json::Value as J;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use yamlover_parser::ir::{
    Anchor, Comment, CommentStyle, Concrete, Document, EdgeKind, Entry, EntryMeta, KeyConcrete,
    Node, NodeKind, NodeMeta, ParseError, Placement, Pointer, PointerBase, ScalarValue, SourceInfo,
    Span, Step, Value,
};
use yamlover_parser::serialize_yamlover::{SerializeOpts, serialize_yamlover};

fn repo_root() -> PathBuf {
    // tools/parser/rust -> repo root
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..").canonicalize().expect("repo root")
}

fn ir_full_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/ir-full")
}

// ---------------------------------------------------------------------------
// JSON -> IR
// ---------------------------------------------------------------------------

fn scalar_value(v: &J) -> ScalarValue {
    match v {
        J::Null => ScalarValue::Null,
        J::Bool(b) => ScalarValue::Bool(*b),
        J::String(s) => ScalarValue::Str(s.clone()),
        J::Number(n) => ScalarValue::Num(n.as_f64().expect("a finite JSON number")),
        // the canon sentinels: JSON holds neither NaN, ±Infinity nor -0
        J::Object(o) => match o.get("$num").and_then(J::as_str) {
            Some("nan") => ScalarValue::Num(f64::NAN),
            Some("inf") => ScalarValue::Num(f64::INFINITY),
            Some("-inf") => ScalarValue::Num(f64::NEG_INFINITY),
            Some("-0") => ScalarValue::Num(-0.0),
            other => panic!("unknown scalar sentinel {other:?}"),
        },
        other => panic!("not a scalar value: {other}"),
    }
}

fn comments(v: Option<&J>) -> Vec<Comment> {
    let Some(J::Array(a)) = v else { return Vec::new() };
    a.iter()
        .map(|c| Comment {
            text: c["text"].as_str().unwrap_or_default().to_string(),
            span: None,
            placement: match c["placement"].as_str() {
                Some("trailing") => Placement::Trailing,
                _ => Placement::Leading,
            },
            style: match c["style"].as_str() {
                Some("block") => CommentStyle::Block,
                _ => CommentStyle::Line,
            },
            blank_before: c.get("blankBefore").and_then(J::as_bool).unwrap_or(false),
        })
        .collect()
}

fn step(v: &J) -> Step {
    match v["sel"].as_str().expect("a step selector") {
        "key" => Step::Key { name: v["name"].as_str().expect("a key name").to_string() },
        "index" => Step::Index { n: v["n"].as_i64().expect("an index") },
        "nullkey" => Step::NullKey,
        "relindex" => Step::RelIndex { k: v["k"].as_i64().expect("a relative index") },
        "parent" => Step::Parent,
        "append" => Step::Append,
        other => panic!("unknown step selector {other}"),
    }
}

fn pointer(v: &J) -> Pointer {
    let base = &v["base"];
    let base = match base["scope"].as_str().expect("a pointer scope") {
        "current" => PointerBase::Current,
        "document" => PointerBase::Document,
        "parent" => PointerBase::Parent,
        "link" => PointerBase::Link {
            authority: base["authority"].as_str().expect("an authority").to_string(),
            world: base.get("world").and_then(J::as_bool).unwrap_or(false),
        },
        other => panic!("unknown pointer scope {other}"),
    };
    Pointer {
        base,
        steps: v["steps"].as_array().map(|a| a.iter().map(step).collect()).unwrap_or_default(),
        raw: v["raw"].as_str().unwrap_or_default().to_string(),
        span: None,
    }
}

fn value(v: &J) -> Value {
    if v.get("kind").and_then(J::as_str) == Some("pointer") {
        Value::Pointer(pointer(v))
    } else {
        Value::Node(node(v))
    }
}

fn node_meta(v: Option<&J>) -> NodeMeta {
    let mut m = NodeMeta::default();
    let Some(o) = v else { return m };
    if let Some(J::Array(a)) = o.get("anchors") {
        m.anchors = a
            .iter()
            .map(|x| Anchor {
                path: pointer(&x["path"]),
                ordinal: x.get("ordinal").and_then(J::as_bool).unwrap_or(false),
            })
            .collect();
    }
    if let Some(s) = o.get("schema") {
        m.schema = Some(Box::new(value(s)));
    }
    m.set = o.get("set").and_then(J::as_bool).unwrap_or(false);
    m.yo = o.get("yo").and_then(J::as_bool).unwrap_or(false);
    m.hidden = o.get("hidden").and_then(J::as_bool).unwrap_or(false);
    m.dir_backed = o.get("dirBacked").and_then(J::as_bool).unwrap_or(false);
    m.document_root = o.get("documentRoot").and_then(J::as_bool).unwrap_or(false);
    m.positional = o.get("positional").and_then(J::as_u64).map(|n| n as usize);
    m.self_at = o.get("selfAt").and_then(J::as_u64).map(|n| n as usize);
    m.style_flow = o.get("style").and_then(J::as_str) == Some("flow");
    m.concrete = o.get("concrete").and_then(J::as_str).map(str::to_string);
    m.derived_format = o.get("derivedFormat").and_then(J::as_str).map(str::to_string);
    if let Some(pe) = o.get("parseError") {
        m.parse_error = Some(ParseError {
            file: pe["file"].as_str().unwrap_or_default().to_string(),
            message: pe["message"].as_str().unwrap_or_default().to_string(),
        });
    }
    m.comments = comments(o.get("comments"));
    m.head = comments(o.get("head"));
    m
}

fn entry_meta(v: Option<&J>) -> EntryMeta {
    let mut m = EntryMeta::default();
    let Some(o) = v else { return m };
    m.key_raw = o.get("keyRaw").and_then(J::as_str).map(str::to_string);
    if o.get("keyConcrete").and_then(J::as_str) == Some("yamlover/key/flat") {
        m.key_concrete = Some(KeyConcrete::YamloverKeyFlat);
    }
    m.blank_before = o.get("blankBefore").and_then(J::as_bool).unwrap_or(false);
    m.comments = comments(o.get("comments"));
    m
}

fn node(v: &J) -> Node {
    let kind = match v["kind"].as_str().expect("a node kind") {
        "scalar" => NodeKind::Scalar {
            value: scalar_value(&v["value"]),
            raw: v["raw"].as_str().unwrap_or_default().to_string(),
        },
        "blob" => NodeKind::Blob {
            format: v["format"].as_str().unwrap_or("application/octet-stream").to_string(),
            content_hash: v["contentHash"].as_str().map(str::to_string),
            size: v["size"].as_u64().unwrap_or(0),
        },
        "mapping" => NodeKind::Mapping,
        other => panic!("unknown node kind {other}"),
    };
    let entries = v["entries"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|e| Entry {
                    key: e["key"].as_str().map(str::to_string),
                    null_key: e.get("nullKey").and_then(J::as_bool).unwrap_or(false),
                    edge: match e["edge"].as_str().expect("an edge kind") {
                        "ref" => EdgeKind::Ref,
                        "back" => EdgeKind::Back,
                        _ => EdgeKind::Contain,
                    },
                    value: value(&e["value"]),
                    meta: entry_meta(e.get("meta")),
                })
                .collect()
        })
        .unwrap_or_default();
    Node {
        kind,
        entries,
        array: v.get("array").and_then(J::as_bool).unwrap_or(false),
        meta: node_meta(v.get("meta")),
    }
}

fn document(v: &J) -> Document {
    let concrete = match v["source"]["concrete"].as_str().expect("a concrete") {
        "json" => Concrete::Json,
        "json5" => Concrete::Json5,
        "json5p" => Concrete::Json5p,
        "yaml" => Concrete::Yaml,
        "dir" => Concrete::Dir,
        "multi-yaml" => Concrete::MultiYaml,
        "multi-yamlover" => Concrete::MultiYamlover,
        _ => Concrete::Yamlover,
    };
    Document {
        root: node(&v["root"]),
        source: SourceInfo {
            concrete,
            uri: v["source"]["uri"].as_str().unwrap_or_default().to_string(),
        },
        head: comments(v.get("head")),
    }
}

// unused-import silencer: Span is part of the IR surface this file names deliberately
#[allow(dead_code)]
fn _span_is_part_of_the_surface(s: Span) -> usize {
    s.end - s.start
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/// KNOWN GAPS — fixtures this serializer cannot yet reproduce, each with the reason.
///
/// All three are the INLINE CONCRETE SWITCH (`NodeMeta::concrete == "json5p"`): a flow token
/// that spans lines in K&R braces, which `ts/src/serialize-yamlover.ts` routes through
/// `serialize-json5p.ts`. This crate has no json5p serializer yet, so such a node degrades to
/// block form — it still reparses to the same IR (the concrete stamp is typography, which
/// canon ignores), just not to the same bytes.
///
/// The list is SHRINK-ONLY, the discipline `tools/parser/YAML-CONFORMANCE.md` already uses:
/// the test asserts each entry STILL diverges, so porting the json5p serializer turns this
/// into a loud "remove me" rather than a gap that quietly outlives its cause.
const KNOWN_GAPS: &[(&str, &str)] = &[
    ("0105-01", "inline json5p concrete switch (K&R braces)"),
    ("0105-02", "inline json5p concrete switch, nested K&R subtree"),
    ("0105-03", "inline json5p concrete switch at the document root and on a dash item"),
];

/// First line of a fixture's `===` title, for readable failure output.
fn title(dir: &Path) -> String {
    std::fs::read_to_string(dir.join("==="))
        .unwrap_or_default()
        .lines()
        .next()
        .unwrap_or("")
        .to_string()
}

#[test]
fn serializer_reproduces_the_out_yo_goldens_byte_for_byte() {
    let dir = ir_full_dir();
    if !dir.exists() {
        eprintln!(
            "SKIP: {} is absent.\n      Generate it first:  node tools/parser/rust/tests/gen-ir-full.mjs",
            dir.display()
        );
        return;
    }
    let corpus = repo_root().join("test-examples");

    let mut checked = 0usize;
    let mut refusals = 0usize;
    let mut mismatches: BTreeMap<String, String> = BTreeMap::new();
    let mut errors: BTreeMap<String, String> = BTreeMap::new();

    let mut ids: Vec<String> = std::fs::read_dir(&dir)
        .expect("read ir-full")
        .filter_map(|e| {
            let p = e.ok()?.path();
            if p.extension()? != "json" {
                return None;
            }
            Some(p.file_stem()?.to_string_lossy().into_owned())
        })
        .collect();
    ids.sort();
    assert!(!ids.is_empty(), "no fixtures in {}", dir.display());

    for id in &ids {
        let fixture = corpus.join(id);
        let golden_path = fixture.join("out.yo");
        let text = std::fs::read_to_string(dir.join(format!("{id}.json"))).expect("read ir-full");
        let j: J = serde_json::from_str(&text).expect("ir-full is valid JSON");
        let doc = document(&j);

        let got = serialize_yamlover(&doc, SerializeOpts::default());

        if !golden_path.exists() {
            // A blob-carrying document: the TS generator omits out.yo and the harness pins the
            // LossyError instead. This side must refuse for the same reason.
            match got {
                Err(_) => refusals += 1,
                Ok(_) => {
                    errors.insert(
                        id.clone(),
                        format!("expected a LossyError refusal (no out.yo golden) — {}", title(&fixture)),
                    );
                }
            }
            continue;
        }

        // `-text` in test-examples/.gitattributes keeps the goldens LF; read as bytes so a
        // stray CRLF is a loud failure rather than a silent normalization.
        let want = std::fs::read(&golden_path).expect("read out.yo");
        let want = String::from_utf8(want).expect("out.yo is UTF-8");
        match got {
            Err(e) => {
                errors.insert(id.clone(), format!("refused, but a golden exists: {e} — {}", title(&fixture)));
            }
            Ok(s) => {
                checked += 1;
                let gap = KNOWN_GAPS.iter().find(|(g, _)| g == id);
                match (gap, s == want) {
                    (None, false) => {
                        mismatches.insert(id.clone(), diff_report(&title(&fixture), &want, &s));
                    }
                    (Some((_, why)), true) => {
                        // the gap closed — say so loudly, so the list can only shrink
                        errors.insert(
                            id.clone(),
                            format!("now MATCHES the golden; drop it from KNOWN_GAPS ({why})"),
                        );
                    }
                    _ => {}
                }
            }
        }
    }

    eprintln!(
        "conformance: {checked} golden(s) compared, {refusals} refusal(s) matched, {} known gap(s)",
        KNOWN_GAPS.len()
    );

    if !mismatches.is_empty() || !errors.is_empty() {
        let mut report = String::new();
        for (id, e) in &errors {
            report.push_str(&format!("\n=== {id}: {e}\n"));
        }
        for (id, d) in &mismatches {
            report.push_str(&format!("\n=== {id}\n{d}"));
        }
        panic!(
            "{} mismatch(es), {} error(s) out of {} fixtures:{report}",
            mismatches.len(),
            errors.len(),
            ids.len()
        );
    }
}

/// First differing line, with a little context — enough to see what moved without dumping
/// two whole documents per failure.
fn diff_report(title: &str, want: &str, got: &str) -> String {
    let w: Vec<&str> = want.lines().collect();
    let g: Vec<&str> = got.lines().collect();
    let at = (0..w.len().max(g.len())).find(|&i| w.get(i) != g.get(i));
    let mut s = format!("  {title}\n");
    match at {
        None => s.push_str("  (differs only in the trailing newline)\n"),
        Some(i) => {
            let from = i.saturating_sub(2);
            for k in from..i {
                s.push_str(&format!("    {k:>3} | {}\n", w[k]));
            }
            s.push_str(&format!("    {i:>3} - ts   | {}\n", w.get(i).unwrap_or(&"<end>")));
            s.push_str(&format!("    {i:>3} + rust | {}\n", g.get(i).unwrap_or(&"<end>")));
        }
    }
    s
}
