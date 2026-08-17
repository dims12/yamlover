// The MATERIALIZER: a chapter model → files on disk.
//
// There is no library write path in this repo — neither `@yamlover/parser` nor
// `@yamlover/engine` exposes a "write a .yo file" entry point, and the server's write
// chokepoint is not a library. So this owns `mkdir` + `write` and must uphold the layout
// invariants itself (docs/language/concretes/02-invariants): no nested `.yo/`, nothing
// unexpected inside `.yo/`, no `index.yo` beside `.yo/body.yo`, safe member names.
//
// The naming rules are ported from OneNote2Yamlover.Core/Text/Names.cs, which learned them
// against a live engine. The `[`/`]` ban in particular is not cosmetic: they are the index
// selector in a pointer path, so a member whose name contains one is unaddressable and the
// parent chapter fails to render.

use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use yamlover_parser::ir::{
    Concrete, Document, Entry, Node, NodeMeta, Pointer, PointerBase, ScalarValue, Step, Value,
};
use yamlover_parser::serialize_yamlover::{SerializeOpts, serialize_yamlover};

/// The schema tag every chapter carries: `!!<*yamlover: $defs: chapter>`.
///
/// A CURRENT-scope pointer, which is how the corpus spells it in all 23 places it appears —
/// the `yamlover` taxonomy is grafted into every served tree, so a bare first portion resolves
/// up the parent chain to it. The `::` project form (`!!<*::yamlover:$defs:chapter>`) means
/// the same node and appears once; writing the bare form keeps the importer's output looking
/// like the hand-authored corpus rather than a second dialect of it.
fn chapter_schema() -> Value {
    Value::Pointer(Pointer::new(
        PointerBase::Current,
        vec![
            Step::Key { name: "yamlover".into() },
            Step::Key { name: "$defs".into() },
            Step::Key { name: "chapter".into() },
        ],
    ))
}

/// One element of a chapter's positional body.
#[derive(Debug, Clone)]
pub enum Chunk {
    /// Prose. `format` overrides the chunk's `(type, format)` via an inline `!!<format: …>`
    /// tag. Passing `None` means the DEFAULT, which is `text/marklower` — almost never what
    /// you want for machine-extracted text; see [`Chunk::plain`].
    Text { text: String, format: Option<String> },
    /// `- *: name` — a pointer to a member of this chapter's own directory (an attachment,
    /// or a subchapter directory).
    Pointer { member: String },
}

impl Chunk {
    /// A chunk of literal text, tagged `text/plain`.
    ///
    /// THE TAG IS LOAD-BEARING. A bare chunk's default prose format is `text/marklower`,
    /// which reads `*`, `_`, `**`, `~~`, backticks, `$$…$$` and `[x](y)` as markup — so an
    /// untagged mail body renders mangled. Every importer chunk that is not deliberately
    /// marklower must say so.
    pub fn plain(text: impl Into<String>) -> Self {
        Chunk::Text { text: text.into(), format: Some("text/plain".to_string()) }
    }
}

/// A file that sits beside a chapter as a member of its directory.
#[derive(Debug, Clone)]
pub struct Asset {
    pub name: String,
    pub bytes: Vec<u8>,
    /// The media type recorded in `.yo/meta.yo` (`members: <name>: {type: binary, format: …}`).
    pub format: String,
}

/// The chapter model an importer builds. Rendered to IR by [`Chapter::to_node`].
#[derive(Debug, Clone, Default)]
pub struct Chapter {
    /// The chapter's SELF-VALUE — the title line. There is no `title:` key in the schema.
    pub title: String,
    /// Keyed fields, in emission order.
    pub fields: Vec<(String, Node)>,
    /// The positional body.
    pub chunks: Vec<Chunk>,
}

impl Chapter {
    pub fn new(title: impl Into<String>) -> Self {
        Chapter { title: title.into(), ..Default::default() }
    }

    pub fn field(&mut self, key: impl Into<String>, value: Node) -> &mut Self {
        self.fields.push((key.into(), value));
        self
    }

    /// A keyed field holding a plain string, skipped when the string is empty.
    pub fn text_field(&mut self, key: impl Into<String>, value: &str) -> &mut Self {
        if !value.is_empty() {
            self.field(key, Node::string(value));
        }
        self
    }

    pub fn chunk(&mut self, c: Chunk) -> &mut Self {
        self.chunks.push(c);
        self
    }

    /// The chapter as IR: the schema tag, the title as the root's self-value, the keyed
    /// fields, then the positional body.
    ///
    /// The fields come BEFORE the body elements, and `self_at` stays 0 so the title line
    /// leads — the shape `examples/60-simple-chapter.yo` and the OneNote importer both write.
    pub fn to_node(&self) -> Node {
        let mut root = Node::string(&self.title);
        root.meta = NodeMeta { schema: Some(Box::new(chapter_schema())), ..NodeMeta::default() };
        let mut entries: Vec<Entry> = Vec::with_capacity(self.fields.len() + self.chunks.len());
        for (k, v) in &self.fields {
            entries.push(Entry::keyed(k.clone(), Value::Node(v.clone())));
        }
        for c in &self.chunks {
            entries.push(match c {
                Chunk::Text { text, format } => {
                    let mut n = Node::string(text);
                    if let Some(f) = format {
                        n.meta.schema = Some(Box::new(Value::Node(Node::mapping(vec![
                            Entry::keyed("format", Value::Node(Node::string(f))),
                        ]))));
                    }
                    Entry::keyless(Value::Node(n))
                }
                Chunk::Pointer { member } => {
                    Entry::keyless_ref(Pointer::document_key(member.clone()))
                }
            });
        }
        root.entries = entries;
        root
    }

    pub fn to_text(&self) -> Result<String, String> {
        let doc = Document::new(self.to_node(), Concrete::Yamlover, "<mail2yamlover>");
        serialize_yamlover(&doc, SerializeOpts::default()).map_err(|e| e.to_string())
    }
}

/// A mapping node built from `(key, value)` string pairs — the shape a `headers:` map takes.
pub fn map_node(pairs: Vec<(String, Node)>) -> Node {
    Node::mapping(pairs.into_iter().map(|(k, v)| Entry::keyed(k, Value::Node(v))).collect())
}

/// A pure sequence of strings — what a repeated header (`Received`) becomes.
pub fn seq_node(items: Vec<String>) -> Node {
    Node::sequence(items.into_iter().map(|s| Entry::keyless(Value::Node(Node::string(s)))).collect())
}

/// A flow mapping of scalars — `{ read: true, replied: false }`.
pub fn flow_map(pairs: Vec<(String, ScalarValue)>) -> Node {
    let mut n = Node::mapping(
        pairs
            .into_iter()
            .map(|(k, v)| Entry::keyed(k, Value::Node(Node::scalar(v))))
            .collect(),
    );
    n.meta.style_flow = true;
    n
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/// Filesystem- and yamlover-safe member names.
///
/// The cap is on CHARACTERS, not bytes, and never splits a surrogate pair — Rust's `char`
/// iteration gives that for free, which the C# original (a UTF-16 substring) did not.
pub const MAX_NAME: usize = 60;

const RESERVED_DEVICES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Make `raw` safe as a directory or file name AND as a pointer key.
pub fn sanitize(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for c in raw.chars() {
        let replacement = match c {
            // control characters read as nothing useful in a filename
            c if (c as u32) < 0x20 || c as u32 == 0x7f => ' ',
            // Windows-illegal
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '-',
            // NOT cosmetic: `[`/`]` are the INDEX SELECTOR in a pointer path, so a member
            // holding one is unaddressable and its parent chapter fails to render
            '[' | ']' => '-',
            c => c,
        };
        out.push(replacement);
    }
    // collapse runs of whitespace
    let collapsed = out.split_whitespace().collect::<Vec<_>>().join(" ");
    // a trailing dot or space is silently dropped by Windows — trim it ourselves so the name
    // we record and the name on disk agree
    let trimmed = collapsed.trim_end_matches(['.', ' ']).trim_start();
    let capped: String = trimmed.chars().take(MAX_NAME).collect();
    let capped = capped.trim_end_matches(['.', ' ']).to_string();
    if capped.is_empty() {
        return "Untitled".to_string();
    }
    let stem = capped.split('.').next().unwrap_or(&capped).to_ascii_uppercase();
    if RESERVED_DEVICES.contains(&stem.as_str()) {
        return format!("_{capped}");
    }
    capped
}

/// Sibling de-duplication, case-insensitively (a Windows path, and conservative-but-correct
/// when the tree is later served from Linux). The extension is part of the key, so a chapter
/// directory `X` and a chapter file `X.yo` coexist.
pub fn unique(used: &mut HashSet<String>, base: &str, ext: &str) -> String {
    let mut candidate = format!("{base}{ext}");
    let mut n = 2;
    while !used.insert(candidate.to_lowercase()) {
        candidate = format!("{base} ({n}){ext}");
        n += 1;
    }
    candidate
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

/// Windows long-path form. Rust's `std::fs` does NOT apply the `\\?\` prefix itself, and this
/// tree blows MAX_PATH routinely: `account/folder/subfolder/00001-<subject>/.yo/body.yo`.
///
/// A verbatim path is handed to the kernel with NO cleanup: it must be absolute, normalized,
/// and separated by BACKSLASHES ONLY. A forward slash in one is an ordinary filename
/// character, not a separator — which is why `--dest D:/tmp/x` failed outright until this
/// normalized first. Anything that cannot be made verbatim safely is returned unchanged, so
/// the caller still gets a working (if MAX_PATH-bound) path rather than a broken one.
#[cfg(windows)]
pub fn long_path(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    if s.starts_with(r"\\?\") {
        return p.to_path_buf();
    }
    // UNC FIRST: `std::path::absolute` rewrites `\\server\share` against the current drive,
    // so asking it about a UNC path destroys it before the check below could fire.
    let raw = s.replace('/', "\\");
    if let Some(rest) = raw.strip_prefix(r"\\") {
        return PathBuf::from(format!(r"\\?\UNC\{rest}"));
    }
    let abs = std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf());
    let n = abs.to_string_lossy().replace('/', "\\");
    // `absolute` follows GetFullPathNameW here and resolves `..`, so this normally cannot
    // fire; it is the belt-and-braces path for the `unwrap_or_else` above, because a `..`
    // reaching the kernel inside a verbatim path becomes a literal directory name.
    if n.contains(r"\..\") || n.ends_with(r"\..") {
        return PathBuf::from(n);
    }
    let b = n.as_bytes();
    if b.len() >= 3 && b[1] == b':' && b[2] == b'\\' {
        return PathBuf::from(format!(r"\\?\{n}"));
    }
    PathBuf::from(n)
}

#[cfg(not(windows))]
pub fn long_path(p: &Path) -> PathBuf {
    p.to_path_buf()
}

pub fn create_dir_all(p: &Path) -> io::Result<()> {
    fs::create_dir_all(long_path(p))
}

/// UTF-8, **no BOM**, and the bytes exactly as given — yamlover files are UTF-8 with no byte
/// order mark, and LF endings are the caller's responsibility (the serializer only emits LF).
pub fn write_text(p: &Path, text: &str) -> io::Result<()> {
    if let Some(parent) = p.parent() {
        create_dir_all(parent)?;
    }
    fs::write(long_path(p), text.as_bytes())
}

pub fn write_bytes(p: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(parent) = p.parent() {
        create_dir_all(parent)?;
    }
    fs::write(long_path(p), bytes)
}

/// Write a chapter as a directory with a `.yo/body.yo` overlay, its assets as sibling member
/// files, and a `.yo/meta.yo` typing those members.
///
/// The overlay flavour is `.yo/body.yo`, not `index.yo` — both are legal and the engine reads
/// either, but carrying BOTH is the `layout/duplicate-overlay` violation, so a tool must pick
/// one and stay with it.
/// Returns the warnings raised for members that could not be written.
///
/// A MEMBER THAT WILL NOT WRITE IS A WARNING, NOT THE END OF THE IMPORT. Real archives
/// contain real malware — this one holds 39 `.exe` attachments — and an antivirus will
/// quarantine or refuse them mid-write. Aborting there would throw away the other 56,000
/// messages over a file the operator never wanted extracted anyway.
///
/// The member is then dropped from the chapter's body too. Writing `- *: virus.exe` for a
/// file that is not on disk would leave a dangling pointer, which is exactly what the
/// cross-implementation sweep looks for — so a skipped attachment must vanish from the
/// pointer array, not merely from the directory.
pub fn write_chapter_dir(
    dir: &Path,
    chapter: &Chapter,
    assets: &[Asset],
) -> io::Result<Vec<String>> {
    create_dir_all(&dir.join(".yo"))?;
    let mut warnings = Vec::new();
    let mut kept: Vec<Asset> = Vec::with_capacity(assets.len());
    // original member name -> the stub that stands in for it, or None if even that failed
    let mut replaced: Vec<(String, Option<String>)> = Vec::new();

    for a in assets {
        match write_bytes(&dir.join(&a.name), &a.bytes) {
            Ok(()) => kept.push(a.clone()),
            Err(e) => {
                let stub_name = format!("{}.skipped.txt", a.name);
                let note = stub_text(a, &e);
                match write_bytes(&dir.join(&stub_name), note.as_bytes()) {
                    Ok(()) => {
                        warnings.push(format!(
                            "could not write {} ({e}) — replaced by {stub_name}",
                            dir.join(&a.name).display()
                        ));
                        kept.push(Asset {
                            name: stub_name.clone(),
                            bytes: Vec::new(),
                            format: "text/plain".to_string(),
                        });
                        replaced.push((a.name.clone(), Some(stub_name)));
                    }
                    Err(e2) => {
                        warnings.push(format!(
                            "could not write {} ({e}) nor its stub ({e2}) — dropped",
                            dir.join(&a.name).display()
                        ));
                        replaced.push((a.name.clone(), None));
                    }
                }
            }
        }
    }

    if let Some(meta) = meta_text(&kept) {
        write_text(&dir.join(".yo").join("meta.yo"), &meta)?;
    }
    let body = if replaced.is_empty() {
        chapter.to_text()
    } else {
        // Repoint at the stub, or drop the element when there is nothing to point at. Either
        // way `- *: <name>` must never name something absent — that is the dangling pointer
        // the cross-implementation sweep hunts for.
        let mut fixed = chapter.clone();
        fixed.chunks = fixed
            .chunks
            .into_iter()
            .filter_map(|c| match &c {
                Chunk::Pointer { member } => {
                    match replaced.iter().find(|(orig, _)| orig == member) {
                        None => Some(c),
                        Some((_, Some(stub))) => Some(Chunk::Pointer { member: stub.clone() }),
                        Some((_, None)) => None,
                    }
                }
                Chunk::Text { .. } => Some(c),
            })
            .collect();
        fixed.to_text()
    }
    .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    write_text(&dir.join(".yo").join("body.yo"), &body)?;
    Ok(warnings)
}

/// The stand-in written where a member could not be.
///
/// It names the ORIGINAL filename, type and size, because that is the part of the record
/// worth more than the bytes: an archive that silently omits an attachment is lying about
/// what the message contained, while one that says "there was a 12 KB `invoice.exe` here and
/// it could not be written" is still telling the truth.
fn stub_text(a: &Asset, reason: &io::Error) -> String {
    format!(
        "This attachment could not be written to disk and was skipped.\n\
         \n\
         original name: {}\n\
         media type:    {}\n\
         size:          {} bytes\n\
         reason:        {reason}\n\
         \n\
         An antivirus refusing an infected attachment looks exactly like this. If this\n\
         message kept its verbatim source (message.eml), the original bytes are still\n\
         there, inside it.\n",
        a.name,
        a.format,
        a.bytes.len()
    )
}

/// Write a chapter as a single `.yo` FILE — the shape for a leaf with no assets and no
/// children, which on this corpus is ~96% of messages.
pub fn write_chapter_file(path: &Path, chapter: &Chapter) -> io::Result<()> {
    let body = chapter
        .to_text()
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    write_text(path, &body)
}

/// `.yo/meta.yo` declaring each asset's `(type, format)`.
///
/// The clause is `members:`. `properties:` is the LEGACY spelling — `walk.ts` reads it
/// forever for compatibility and `onenote2yamlover` still emits it, but new writers say
/// `members:` (examples/65-all-formats-chunks/.yo/meta.yo).
fn meta_text(assets: &[Asset]) -> Option<String> {
    if assets.is_empty() {
        return None;
    }
    let members = map_node(
        assets
            .iter()
            .map(|a| {
                let mut n = Node::mapping(vec![
                    Entry::keyed("type", Value::Node(Node::string("binary"))),
                    Entry::keyed("format", Value::Node(Node::string(&a.format))),
                ]);
                n.meta.style_flow = true;
                (a.name.clone(), n)
            })
            .collect(),
    );
    let root = Node::mapping(vec![Entry::keyed("members", Value::Node(members))]);
    let doc = Document::new(root, Concrete::Yamlover, "<mail2yamlover>");
    serialize_yamlover(&doc, SerializeOpts::default()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn brackets_are_stripped_because_they_are_the_index_selector() {
        assert_eq!(sanitize("Re: [SPAM] hello"), "Re- -SPAM- hello");
        assert!(!sanitize("a[0]b").contains('['));
    }

    #[test]
    fn windows_illegal_characters_and_controls_go() {
        assert_eq!(sanitize("a/b\\c:d*e?f\"g<h>i|j"), "a-b-c-d-e-f-g-h-i-j");
        assert_eq!(sanitize("a\u{1}b"), "a b");
    }

    #[test]
    fn whitespace_collapses_and_edges_trim() {
        assert_eq!(sanitize("  a   b  "), "a b");
        assert_eq!(sanitize("name."), "name");
        assert_eq!(sanitize("\t\n"), "Untitled");
        assert_eq!(sanitize(""), "Untitled");
    }

    #[test]
    fn reserved_device_names_are_prefixed() {
        assert_eq!(sanitize("CON"), "_CON");
        assert_eq!(sanitize("nul.txt"), "_nul.txt");
        assert_eq!(sanitize("CONSOLE"), "CONSOLE", "only the exact device names");
    }

    #[test]
    fn the_cap_counts_characters_and_never_splits_a_surrogate_pair() {
        let long = "🐱".repeat(80);
        let s = sanitize(&long);
        assert_eq!(s.chars().count(), MAX_NAME);
        assert!(s.is_char_boundary(s.len()));

        let cyrillic = "Тема".repeat(40);
        assert_eq!(sanitize(&cyrillic).chars().count(), MAX_NAME);
    }

    #[test]
    fn cyrillic_rides_through_untouched() {
        assert_eq!(sanitize("Архивные папки"), "Архивные папки");
    }

    #[test]
    fn siblings_dedupe_case_insensitively_with_the_extension_in_the_key() {
        let mut used = HashSet::new();
        assert_eq!(unique(&mut used, "a", ".yo"), "a.yo");
        assert_eq!(unique(&mut used, "a", ".yo"), "a (2).yo");
        assert_eq!(unique(&mut used, "A", ".yo"), "A (3).yo");
        // a directory `a` and a file `a.yo` are different keys
        assert_eq!(unique(&mut used, "a", ""), "a");
    }

    #[test]
    fn a_chapter_serializes_with_its_schema_tag_and_a_plain_body() {
        let mut c = Chapter::new("Тема письма");
        c.text_field("from", "a@b.ru");
        c.chunk(Chunk::plain("body *with* markup chars"));
        c.chunk(Chunk::Pointer { member: "photo.jpg".into() });

        let text = c.to_text().expect("serializes");
        // A short single-line body rides inline; only a multi-line one becomes a block
        // scalar. Either way the `text/plain` tag is what stops `*with*` reading as markup.
        assert_eq!(
            text,
            "!!<*yamlover: $defs: chapter>\n\
             Тема письма\n\
             from: a@b.ru\n\
             - !!<format: text/plain> body *with* markup chars\n\
             - *: photo.jpg\n"
        );
    }

    #[test]
    fn a_multi_line_body_becomes_a_literal_block_scalar() {
        let mut c = Chapter::new("t");
        c.chunk(Chunk::plain("first line\nsecond line"));
        assert_eq!(
            c.to_text().expect("serializes"),
            "!!<*yamlover: $defs: chapter>\n\
             t\n\
             - !!<format: text/plain> |-\n\
             \x20 first line\n\
             \x20 second line\n"
        );
    }

    #[test]
    fn meta_declares_members_not_the_legacy_properties() {
        let assets = vec![Asset {
            name: "photo.jpg".into(),
            bytes: vec![],
            format: "image/jpeg".into(),
        }];
        let m = meta_text(&assets).expect("some");
        assert!(m.starts_with("members:"), "got: {m}");
        assert!(!m.contains("properties:"));
        assert!(m.contains("{type: binary, format: image/jpeg}"), "got: {m}");
    }
}

#[cfg(all(test, windows))]
mod windows_paths {
    use super::*;

    /// The verbatim prefix, spelled once so no test can disagree with the implementation
    /// about how many backslashes it has.
    const V: &str = r"\\?\";

    #[test]
    fn a_verbatim_path_takes_backslashes_only() {
        // the bug this exists to prevent: a verbatim path holding `D:/tmp/x` reaches the
        // kernel with `tmp/x` as ONE filename, and every write under --dest fails
        let p = long_path(Path::new("D:/tmp/x/y"));
        assert_eq!(p.to_string_lossy(), format!(r"{V}D:\tmp\x\y"));
        assert!(!p.to_string_lossy().contains('/'));
    }

    #[test]
    fn an_already_verbatim_path_is_left_alone() {
        let input = format!(r"{V}D:\a");
        assert_eq!(long_path(Path::new(&input)).to_string_lossy(), input);
    }

    #[test]
    fn a_unc_path_takes_the_unc_form() {
        // `std::path::absolute` rewrites a UNC path against the current drive, so the UNC
        // check must run before it — this is the test that caught that ordering
        let got = long_path(Path::new(r"\\srv\share\f"));
        assert_eq!(got.to_string_lossy(), format!(r"{V}UNC\srv\share\f"));
    }

    #[test]
    fn dotdot_is_resolved_before_prefixing() {
        // A verbatim path gets NO cleanup from the kernel, so a surviving `..` would become a
        // literal directory name. `std::path::absolute` follows GetFullPathNameW on Windows,
        // which resolves it — so prefixing is safe, and the guard below it never fires here.
        // (The C# importer's Fs.Long had to warn that `..` was NOT resolved; Rust's does it.)
        assert_eq!(long_path(Path::new(r"D:\a\..\b")).to_string_lossy(), format!(r"{V}D:\b"));
    }

    #[test]
    fn a_relative_path_is_made_absolute_before_prefixing() {
        let p = long_path(Path::new("rel"));
        assert!(p.to_string_lossy().starts_with(V), "got {}", p.display());
    }
}

#[cfg(test)]
mod tolerance {
    use super::*;

    /// A member that cannot be written must vanish from the BODY as well as the directory.
    ///
    /// This is the antivirus case: the archive holds 39 `.exe` attachments, and a scanner
    /// quarantines one mid-write. Leaving `- *: virus.exe` behind would produce exactly the
    /// dangling pointer the cross-implementation sweep exists to catch.
    #[test]
    fn an_unwritable_member_is_dropped_from_the_pointer_array() {
        let base = std::env::temp_dir().join(format!("m2y-tolerance-{}", std::process::id()));
        let _ = fs::remove_dir_all(long_path(&base));
        let dir = base.join("msg");

        let mut chapter = Chapter::new("subject");
        chapter.chunk(Chunk::Pointer { member: "good.txt".into() });
        chapter.chunk(Chunk::Pointer { member: "blocked".into() });

        // A directory standing where the member file should go makes the write fail the same
        // way a scanner's refusal does, without needing one.
        create_dir_all(&dir.join("blocked")).expect("stage the obstruction");

        let assets = vec![
            Asset { name: "good.txt".into(), bytes: b"hi".to_vec(), format: "text/plain".into() },
            Asset { name: "blocked".into(), bytes: b"x".to_vec(), format: "application/octet-stream".into() },
        ];
        let warnings = write_chapter_dir(&dir, &chapter, &assets).expect("the chapter still writes");

        assert_eq!(warnings.len(), 1, "the skip is reported, not silent: {warnings:?}");
        let body = fs::read_to_string(long_path(&dir.join(".yo").join("body.yo"))).expect("body");
        assert!(body.contains("- *: good.txt"), "the writable member survives:\n{body}");
        // the pointer is REPOINTED at the stub, never left naming an absent file
        assert!(body.contains("- *: blocked.skipped.txt"), "expected a stub pointer:\n{body}");

        let stub = fs::read_to_string(long_path(&dir.join("blocked.skipped.txt"))).expect("stub");
        assert!(stub.contains("original name: blocked"), "the stub names the file:\n{stub}");
        assert!(stub.contains("size:          1 bytes"), "and its size:\n{stub}");

        let meta = fs::read_to_string(long_path(&dir.join(".yo").join("meta.yo"))).expect("meta");
        assert!(meta.contains("good.txt"));
        assert!(meta.contains("blocked.skipped.txt"), "the stub is typed too:\n{meta}");

        let _ = fs::remove_dir_all(long_path(&base));
    }
}
