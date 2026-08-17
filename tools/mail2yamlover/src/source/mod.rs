// The reader seam. One trait, one source today, and the shape the next ones slot into.
//
// Everything past `RawMessage.bytes` is ordinary RFC-822/MIME, which is why this boundary is
// where it is: TheBat and Outlook Express both store whole RFC-822 messages, so both reduce
// to "walk a container, hand over bytes" and share the entire pipeline behind this trait.
//
// Outlook `.pst` will NOT: its messages are MAPI property bags, not RFC-822, so a body and
// its attachments have to be assembled from properties rather than parsed from a stream.
// That is a second `RawMessage`-producing path (or a second trait method yielding an
// already-structured message), and it is the reason this trait hands over BYTES plus the
// store-level facts (timestamp, flags) rather than a parsed message: the parsed shape is
// where the two sources genuinely differ.

use std::io;
use std::path::{Path, PathBuf};

pub mod thebat;

/// What a folder is, as far as the importer cares.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FolderKind {
    /// A mail account: the root of its own folder tree.
    Account,
    /// An ordinary folder, or a shared folder tree living beside the accounts.
    Folder,
}

/// One folder in the source tree. Messages are NOT held here: a store is read on demand
/// (`MailSource::messages`) so peak memory is one folder's worth, not the whole 506 MB
/// archive — the largest single folder in the reference set holds 12,334 messages.
#[derive(Debug, Clone)]
pub struct FolderNode {
    /// The folder's display name — its directory name on disk.
    pub name: String,
    pub dir: PathBuf,
    /// The message store backing this folder, when it has one. A folder may be pure
    /// structure (children only, no messages of its own).
    pub store: Option<PathBuf>,
    pub children: Vec<FolderNode>,
    /// Account vs ordinary folder. Recorded rather than acted on: v1 writes both the same
    /// way, and a later pass (per-account settings, an ontos axis) is what will read it.
    #[allow(dead_code)]
    pub kind: FolderKind,
    /// Loose files the source keeps beside the folder (TheBat's `Attach/`), carried into the
    /// tree verbatim.
    pub attachments: Vec<PathBuf>,
}

impl FolderNode {
    /// Every folder in this subtree, depth-first, including this one.
    #[allow(dead_code)] // reader-facing API: used by callers that need a flat view, not by the
    // recursive writer in main.rs
    pub fn walk(&self) -> Vec<&FolderNode> {
        let mut out = vec![self];
        for c in &self.children {
            out.extend(c.walk());
        }
        out
    }
}

/// One message as the store holds it: the raw RFC-822 bytes plus the facts the STORE knows
/// that the message itself does not.
#[derive(Debug, Clone)]
pub struct RawMessage {
    /// Raw RFC-822, CRLF endings, exactly as stored.
    pub bytes: Vec<u8>,
    /// The store's own timestamp, seconds since the epoch. Used as the fallback when the
    /// message carries no parsable `Date:` — an unsent draft, or a mangled header.
    pub timestamp: Option<i64>,
    /// The store's flags word. Bit 0 is "read" in every sample; the rest are recorded but
    /// not interpreted, because guessing at a flag's meaning is worse than reporting it.
    pub flags: u32,
}

impl RawMessage {
    pub fn is_read(&self) -> bool {
        self.flags & 1 != 0
    }
}

pub trait MailSource {
    /// The `--source` value that selects this reader. Part of the trait so a reader can be
    /// identified once several exist; `by_name` matches the string directly today.
    #[allow(dead_code)]
    fn name(&self) -> &'static str;

    /// Discover the folder tree without reading any message store.
    fn scan(&self, root: &Path) -> io::Result<Vec<FolderNode>>;

    /// Read one folder's messages.
    fn messages(&self, folder: &FolderNode) -> io::Result<Vec<RawMessage>>;

    /// How many messages the folder holds, ideally WITHOUT reading them.
    ///
    /// Only the progress bar's total depends on this, so the default is honest about not
    /// knowing: a reader that cannot answer cheaply should not read 506 MB twice to try. A
    /// zero here just means the bar runs without a total for that folder.
    fn count(&self, _folder: &FolderNode) -> io::Result<usize> {
        Ok(0)
    }
}

/// Resolve a `--source` name to a reader.
pub fn by_name(name: &str) -> Option<Box<dyn MailSource>> {
    match name {
        "thebat" => Some(Box::new(thebat::TheBat)),
        _ => None,
    }
}

pub const KNOWN_SOURCES: &[&str] = &["thebat"];
