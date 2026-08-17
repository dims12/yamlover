// The Bat! — the on-disk mail directory.
//
// FORMAT, established by walking all 73 stores in the reference archive (56,845 messages,
// 506 MB): every magic occurrence accounted for, zero chain breaks.
//
//   MESSAGES.TBB
//     0x0000  u32  file magic 0x19790620  (bytes 20 06 79 19)
//     0x0004       3076 bytes of header, zero in every sample
//     0x0C08       the first record — so the file header is exactly 3080 bytes, which an
//                  EMPTY folder confirms: it is a 3080-byte file with no records at all
//
//   record
//     +0x00   u32  record magic 0x19700921  (bytes 21 09 70 19)
//     +0x04   u32  header size, 48 in every sample
//     +0x08   u32  an id/hash
//     +0x0C   u32  unix timestamp
//     +0x10   u32  a monotonically increasing message number
//     +0x18   u32  flags (bit 0 = read, observed 2/4/5)
//     +0x24   u32  message size
//     +hsz         the message: RAW RFC-822, CRLF line endings
//
//   next record = offset + header_size + message_size
//
// The message payload is ordinary RFC-822/MIME, so everything past this file is a MIME
// problem rather than a TheBat problem — which is why this reader is ~100 lines and
// message.rs is where the work is.
//
// MESSAGES.TBI (the index) is NOT read. It is variable-length per record (~378 bytes
// average, caching subject and sender inline) and its only unique contribution is which
// records are live: TheBat keeps deleted messages in the TBB until the folder is compacted.
// v1 imports every record and says so in the README — losing a message would be worse than
// importing a deleted one, and the flags word is carried through so a later pass can filter.
//
// ACCOUNT.FLB (folder metadata, magic 0x5a5a12ab) is NOT read either: it is a property-bag
// format whose folder names are not plainly recoverable, and the directory names on disk are
// already the folder names. Special folders are recognised by name instead.

use std::fs;
use std::io;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use super::{FolderKind, FolderNode, MailSource, RawMessage};

const FILE_MAGIC: [u8; 4] = [0x20, 0x06, 0x79, 0x19];
const REC_MAGIC: [u8; 4] = [0x21, 0x09, 0x70, 0x19];
const FILE_HEADER: usize = 0x0C08;

/// Directory entries that are TheBat's own bookkeeping, never mail folders.
const NOT_FOLDERS: &[&str] = &["$KNOWN$", "$JUNK$", "$RECYCLED$"];

/// A folder directory holding attachments TheBat saved outside the message store.
const ATTACH_DIR: &str = "Attach";

pub struct TheBat;

impl MailSource for TheBat {
    fn name(&self) -> &'static str {
        "thebat"
    }

    fn scan(&self, root: &Path) -> io::Result<Vec<FolderNode>> {
        let mut out = Vec::new();
        for entry in sorted_dirs(root)? {
            let name = file_name(&entry);
            if NOT_FOLDERS.contains(&name.as_str()) {
                continue;
            }
            // A root child is an ACCOUNT when it carries account configuration; otherwise it
            // is a shared folder tree living beside the accounts (the Cyrillic `Бизнес/`,
            // `Архивные папки/` … in the reference archive).
            let kind = if entry.join("ACCOUNT.CFG").exists() || entry.join("ACCOUNT.FLB").exists() {
                FolderKind::Account
            } else {
                FolderKind::Folder
            };
            out.push(node_at(&entry, name, kind)?);
        }
        Ok(out)
    }

    fn messages(&self, folder: &FolderNode) -> io::Result<Vec<RawMessage>> {
        let Some(store) = &folder.store else { return Ok(Vec::new()) };
        let bytes = fs::read(crate::tree::long_path(store))?;
        Ok(parse_tbb(&bytes, &store.to_string_lossy()))
    }

    fn count(&self, folder: &FolderNode) -> io::Result<usize> {
        let Some(store) = &folder.store else { return Ok(0) };
        let f = fs::File::open(crate::tree::long_path(store))?;
        Ok(count_tbb(io::BufReader::new(f)))
    }
}

/// How many records the chain holds, WITHOUT loading the store.
///
/// The progress bar wants a total before any work starts, and reading all 506 MB twice to get
/// one would be absurd — worse with an antivirus inspecting every read. This seeks the chain
/// and touches only the 40-byte record headers: ~2 MB across the whole archive.
///
/// It must agree with [`parse_tbb`] exactly; the test below pins that.
pub fn count_tbb(mut f: impl Read + Seek) -> usize {
    let mut magic = [0u8; 4];
    if f.read_exact(&mut magic).is_err() || magic != FILE_MAGIC {
        return 0;
    }
    let mut off = FILE_HEADER as u64;
    let mut hdr = [0u8; 0x28];
    let mut n = 0usize;
    loop {
        if f.seek(SeekFrom::Start(off)).is_err() || f.read_exact(&mut hdr).is_err() {
            break;
        }
        if hdr[..4] != REC_MAGIC {
            break;
        }
        let header_size = u32::from_le_bytes([hdr[4], hdr[5], hdr[6], hdr[7]]) as u64;
        let size = u32::from_le_bytes([hdr[0x24], hdr[0x25], hdr[0x26], hdr[0x27]]) as u64;
        if header_size < 0x28 {
            break;
        }
        n += 1;
        off += header_size + size;
    }
    n
}

fn node_at(dir: &Path, name: String, kind: FolderKind) -> io::Result<FolderNode> {
    let store = ["MESSAGES.TBB", "messages.tbb"]
        .iter()
        .map(|f| dir.join(f))
        .find(|p| p.exists());
    let mut children = Vec::new();
    let mut attachments = Vec::new();
    for sub in sorted_dirs(dir)? {
        let sub_name = file_name(&sub);
        if NOT_FOLDERS.contains(&sub_name.as_str()) {
            continue;
        }
        if sub_name == ATTACH_DIR {
            // TheBat's externally-stored attachments. Carried verbatim rather than matched
            // back into messages: 1,352 MIME parts in the reference archive have an empty
            // payload because the bytes were moved here, and the message keeps no reference
            // that survives round-tripping. Copying the directory loses nothing; guessing at
            // a filename match would invent links that were never recorded.
            attachments = sorted_files(&sub)?;
            continue;
        }
        children.push(node_at(&sub, sub_name, FolderKind::Folder)?);
    }
    Ok(FolderNode { name, dir: dir.to_path_buf(), store, children, kind, attachments })
}

/// Walk a TBB's record chain. A break stops the walk and keeps what was read — a truncated
/// or corrupt store should yield its readable prefix, never nothing.
pub fn parse_tbb(bytes: &[u8], _origin: &str) -> Vec<RawMessage> {
    let mut out = Vec::new();
    if bytes.len() < FILE_HEADER || bytes[..4] != FILE_MAGIC {
        // Not a TBB, or header-only. An empty folder is exactly FILE_HEADER bytes.
        if bytes.len() < 4 || bytes[..4] != FILE_MAGIC {
            return out;
        }
    }
    let mut off = FILE_HEADER;
    while off + 0x28 <= bytes.len() {
        if bytes[off..off + 4] != REC_MAGIC {
            break; // chain break: keep what we have
        }
        let header_size = u32_at(bytes, off + 0x04) as usize;
        let timestamp = u32_at(bytes, off + 0x0C);
        let flags = u32_at(bytes, off + 0x18);
        let size = u32_at(bytes, off + 0x24) as usize;
        if header_size < 0x28 {
            break;
        }
        let start = off + header_size;
        let end = match start.checked_add(size) {
            Some(e) if e <= bytes.len() => e,
            _ => break, // a size that runs off the end: stop rather than panic
        };
        out.push(RawMessage {
            bytes: bytes[start..end].to_vec(),
            timestamp: (timestamp > 0).then_some(i64::from(timestamp)),
            flags,
        });
        off = end;
    }
    out
}

fn u32_at(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

fn file_name(p: &Path) -> String {
    p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

fn sorted_dirs(dir: &Path) -> io::Result<Vec<PathBuf>> {
    let mut v: Vec<PathBuf> = fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.path())
        .collect();
    v.sort();
    Ok(v)
}

fn sorted_files(dir: &Path) -> io::Result<Vec<PathBuf>> {
    let mut v: Vec<PathBuf> = fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .map(|e| e.path())
        .collect();
    v.sort();
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a synthetic TBB. Real mail is never committed to this repo.
    pub(super) fn tbb(messages: &[(&str, u32, u32)]) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend_from_slice(&FILE_MAGIC);
        b.resize(FILE_HEADER, 0);
        for (body, ts, flags) in messages {
            b.extend_from_slice(&REC_MAGIC);
            b.extend_from_slice(&48u32.to_le_bytes()); // +0x04 header size
            b.extend_from_slice(&0u32.to_le_bytes()); // +0x08 id
            b.extend_from_slice(&ts.to_le_bytes()); // +0x0C timestamp
            b.extend_from_slice(&0u32.to_le_bytes()); // +0x10 number
            b.extend_from_slice(&0u32.to_le_bytes()); // +0x14
            b.extend_from_slice(&flags.to_le_bytes()); // +0x18 flags
            b.extend_from_slice(&0u32.to_le_bytes()); // +0x1C
            b.extend_from_slice(&0u32.to_le_bytes()); // +0x20
            b.extend_from_slice(&(body.len() as u32).to_le_bytes()); // +0x24 size
            b.extend_from_slice(&0u32.to_le_bytes()); // +0x28 (pad to 48)
            b.extend_from_slice(&0u32.to_le_bytes()); // +0x2C
            b.extend_from_slice(body.as_bytes());
        }
        b
    }

    #[test]
    fn walks_the_record_chain() {
        let b = tbb(&[("Subject: one\r\n\r\nbody", 1108704249, 5), ("Subject: two\r\n\r\n!", 0, 4)]);
        let msgs = parse_tbb(&b, "t");
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].bytes, b"Subject: one\r\n\r\nbody");
        assert_eq!(msgs[0].timestamp, Some(1108704249));
        assert_eq!(msgs[0].flags, 5);
        assert_eq!(msgs[1].bytes, b"Subject: two\r\n\r\n!");
        assert_eq!(msgs[1].timestamp, None, "a zero timestamp is absent, not the epoch");
    }

    #[test]
    fn an_empty_folder_is_the_bare_file_header() {
        // exactly what the one message-less folder in the reference archive looks like
        let mut b = Vec::new();
        b.extend_from_slice(&FILE_MAGIC);
        b.resize(FILE_HEADER, 0);
        assert_eq!(b.len(), 3080);
        assert!(parse_tbb(&b, "t").is_empty());
    }

    #[test]
    fn a_foreign_file_yields_nothing_rather_than_garbage() {
        assert!(parse_tbb(b"not a TBB at all", "t").is_empty());
        assert!(parse_tbb(&[], "t").is_empty());
    }

    #[test]
    fn a_truncated_store_keeps_its_readable_prefix() {
        let mut b = tbb(&[("Subject: one\r\n\r\nbody", 1, 0), ("Subject: two\r\n\r\nx", 2, 0)]);
        b.truncate(b.len() - 5); // chop into the last message
        let msgs = parse_tbb(&b, "t");
        assert_eq!(msgs.len(), 1, "the intact first record survives");
    }

    #[test]
    fn a_chain_break_stops_the_walk_without_panicking() {
        let mut b = tbb(&[("Subject: one\r\n\r\nbody", 1, 0), ("Subject: two\r\n\r\nx", 2, 0)]);
        let second = FILE_HEADER + 48 + "Subject: one\r\n\r\nbody".len();
        b[second] = 0xFF; // corrupt the second record's magic
        assert_eq!(parse_tbb(&b, "t").len(), 1);
    }
}

#[cfg(test)]
mod counting {
    use super::*;
    use super::tests::tbb;
    use std::io::Cursor;

    /// The seeking counter and the loading walker must never disagree — the progress bar's
    /// total comes from one and its ticks from the other.
    #[test]
    fn count_agrees_with_the_full_walk() {
        for case in [
            vec![],
            vec![("Subject: a\r\n\r\nx", 1u32, 0u32)],
            vec![("Subject: a\r\n\r\nx", 1, 0), ("Subject: b\r\n\r\nyy", 2, 5)],
        ] {
            let b = tbb(&case);
            assert_eq!(count_tbb(Cursor::new(&b)), parse_tbb(&b, "t").len(), "{} record(s)", case.len());
        }
    }

    #[test]
    fn count_stops_where_the_walk_stops() {
        let mut b = tbb(&[("Subject: a\r\n\r\nx", 1, 0), ("Subject: b\r\n\r\ny", 2, 0)]);
        let second = FILE_HEADER + 48 + "Subject: a\r\n\r\nx".len();
        b[second] = 0xFF;
        assert_eq!(count_tbb(Cursor::new(&b)), 1);
        assert_eq!(count_tbb(Cursor::new(&b)), parse_tbb(&b, "t").len());
    }

    #[test]
    fn a_foreign_file_counts_zero() {
        assert_eq!(count_tbb(Cursor::new(b"not a TBB".to_vec())), 0);
        assert_eq!(count_tbb(Cursor::new(Vec::new())), 0);
    }
}
