# mail2yamlover

Imports a mail archive into a **yamlover tree**: the folder hierarchy becomes directories,
each message becomes a chapter, and every attachment lands as a real file beside it.

**Status (2026-08-17).** The Bat! works end to end. Outlook and Outlook Express are not
built; the reader sits behind a trait so they slot in without touching the writing side.

```sh
cargo run --release -- --from "V:/YamloverSources/TheBat" --dest ./mail
npx yamlover ./mail          # browse it
```

## What it produces

```
mail/
  dims2000@mtu-net.ru/
    .yo/body.yo                              # the folder chapter: an ordered pointer array
    Inbox/
      .yo/body.yo
      00001-Elitarium news 16-02-2005/       # a message WITH members -> a directory
        .yo/body.yo
        .yo/meta.yo                          # members: <name>: {type: binary, format: …}
        message.eml                          # the verbatim original
        photo.jpg
      00002-Re- proposal.yo                  # a message with none -> a single file
      Подпапка/                              # a nested folder
    Attach/                                  # TheBat's externally-stored attachments
```

A message — an **omni** node: a title, fields and members, with no schema tag (omni is
yamlover's default shape, so nothing needs to say so):

```yaml
Тема письма
from: "Имя <a@b.ru>"
to: dims2000@mtu-net.ru
date: 2005-02-16T09:23:23+03:00
message-id: 20050216...@elitarium.ru
headers:
  Return-Path: <info@elitarium.ru>
  Received:
  - from antispam.localhost (antigua.mtu.ru [195.34.32.114]) …
  - from mail.valuehost.co.uk …
  X-Mailer: The Bat! (v3.0)
flags: {read: true}
- !!<format: text/plain> |-
  The body, decoded to UTF-8.
- *: message.eml
- *: photo.jpg
```

Decisions worth knowing, and why:

- **A message is omni, not a chapter.** The chapter schema means "prose organized as
  chunks" and routes a node to the prose renderer; a message is the opposite shape — a title,
  a heap of technical fields, and pointers to files. Folders *are* tagged chapters, because a
  folder really is a titled container of subchapters.
- **The subject is the self-value**, not a `title:` key — in both shapes.
- **`headers:` holds every header**, in source order, duplicates intact. `Received` repeats
  and its order *is* the delivery path, so it becomes an array rather than collapsing. The
  curated `from`/`to`/`date` fields above it are a convenience, not a filter.
- **The body chunk is always tagged `!!<format: text/plain>`.** A bare chunk's default prose
  format is `text/marklower`, which reads `*`, `_`, `**`, `~~`, backticks and `[x](y)` as
  markup — an untagged mail body renders mangled. This is the single most load-bearing line
  in the emitter.
- **Nothing is cloned.** `message.eml` already holds every representation the message had, so
  decoding one out into a second file would be duplication, not preservation — an html-only
  newsletter used to land as a 19 KB `body.html` beside a 19 KB `message.eml` carrying the
  same content. The server renders `message/rfc822` directly
  (`tools/server/src/client/renderers/eml.tsx`), so nothing is gained by writing the copy.
  The one exception is `--no-raw`: with no `message.eml`, `body.html` is the *only* copy of an
  html body, and dropping it would lose the message rather than deduplicate it.
- **`members:`, never `properties:`** in `meta.yo`. The latter is the legacy spelling the
  engine still reads and `onenote2yamlover` still writes.
- **A message with no members becomes a single `.yo` file**, not a directory. With `--no-raw`
  that is ~96% of this corpus, which matters at 57k messages.
- **Order lives in the pointer array**, not the names. Disk has no order; the overlay grants
  it (`docs/language/concretes/01-choosing`), so the `NNNNN-` prefixes are cosmetic and the
  parent's `- *: name` list is the data.
- **The destination root's own `.yo/body.yo` is never written** — you may have pointed at an
  existing yamlover project, and clobbering its overlay would be destructive. The imported
  accounts are found by the engine's directory scan.

## Options

| | |
|---|---|
| `--from <dir>` | the mail directory to read |
| `--dest <dir>` | where to write (must not exist, or `--force`) |
| `--source <name>` | reader to use; `thebat` (default) |
| `--accounts <a,b>` | only these top-level folders / accounts |
| `--no-raw` | do not keep each message's verbatim RFC-822 as `message.eml` |
| `--limit <n>` | stop after n messages per folder — for a quick look |

It shows a progress bar with a real total and an ETA. Getting the total means seeking every
store's record chain first (~2 MB of headers for the whole archive, but ~15 s of wall-clock
with an antivirus inspecting each file), so that phase has its own spinner rather than
leaving you staring at nothing. Both are hidden when stderr is not a terminal, so piping into
a log does not produce megabytes of escape codes.

`message.eml` is kept by default and roughly doubles the output. It is the only thing that
makes "nothing was lost" true regardless of what MIME parsing got wrong, and it means a
re-import never needs the original mailbox again.

## The Bat! format

Established by walking all 73 stores in the reference archive — every magic occurrence
accounted for, zero chain breaks.

```
MESSAGES.TBB
  0x0000  u32   file magic 0x19790620
  0x0C08        the first record — the file header is exactly 3080 bytes, which an EMPTY
                folder confirms: it is a 3080-byte file with no records

record
  +0x00   u32   record magic 0x19700921
  +0x04   u32   header size (48)
  +0x0C   u32   unix timestamp
  +0x18   u32   flags (bit 0 = read)
  +0x24   u32   message size
  +hsz          the message: RAW RFC-822, CRLF

next = offset + header_size + message_size
```

The payload is ordinary RFC-822/MIME, which is why the reader is ~100 lines and `message.rs`
is where the work is. `mail-parser` does MIME and `encoding_rs` (via its `full_encoding`
feature) does charsets — the archive holds koi8-r, windows-1251, iso-8859-1/2/9/15,
windows-1250/1252, iso-2022-jp and gb2312 against 733 messages that are actually UTF-8.

## It keeps going

An old mail archive contains real malware — this one has 39 `.exe` attachments — and a
running antivirus will quarantine or refuse them mid-write. That must not cost you the other
56,000 messages, so **an unreadable or unwritable file is a warning, never the end of the
import**:

- a member that will not write is replaced by a **stub naming the original**, and the
  chapter's pointer is repointed at it — so the record survives even when the bytes do not:

  ```
  This attachment could not be written to disk and was skipped.

  original name: invoice.exe
  media type:    application/x-msdownload
  size:          12345 bytes
  reason:        Operation did not complete successfully because the file contains a virus

  An antivirus refusing an infected attachment looks exactly like this. If this
  message kept its verbatim source (message.eml), the original bytes are still
  there, inside it.
  ```

  An archive that silently omits an attachment is lying about what the message contained.
  If even the stub cannot be written, the element is dropped rather than left naming an
  absent file — a dangling pointer is the one thing the tree-level sweep will not forgive;
- a message that will not write is skipped and not named by its folder;
- an unreadable message store costs that folder and nothing else;
- a message with no parsable headers is still kept, as a chapter holding its raw bytes.

Every one is counted and sampled in the summary rather than streamed, because a 20,000-line
log and a reassuring silence are equally useless.

## Known gaps

These are limits, not bugs to discover later:

- **Deleted-but-unpurged messages are imported.** TheBat keeps them in the TBB until the
  folder is compacted; `MESSAGES.TBI` is the liveness index and is not read (variable-length,
  ~378 bytes per record, subject and sender cached inline). Losing a message would be worse
  than importing a deleted one, and the store's flags word is carried through so a later pass
  can filter.
- **Externally-stored attachments are not re-attached.** 1,352 MIME parts in the reference
  archive announce a filename and carry no bytes, because TheBat moved the payload into the
  account's `Attach/` directory. That directory is copied verbatim beside the messages, but
  nothing links the two: the message keeps no reference that survives, and guessing by
  filename would invent links that were never recorded. Each one is reported as a warning.
- **`ACCOUNT.FLB` is not read.** Folder display names and order live in a property-bag format
  whose strings are not plainly recoverable; the directory names on disk are already the
  folder names, and special folders are recognised by name (`Inbox`, `Sent`, `Trash`, …).
- **The `.tbk` backup container is not supported** — a proprietary archive (magic 0x19500601,
  then zlib streams) that deserves its own effort.
- **No `ontos:` taxonomy yet.** Folders and dates are structure, not tags. An account/folder/
  year taxonomy with `&: ontos: …: -` membership bookmarks per `examples/67-pdf-tags` is the
  natural next step.

## How it is verified

Unit tests (`cargo test`) cover the TBB walk against a *synthetic* store — real mail is never
committed here — plus the naming rules, the Windows long-path form, MIME decoding and the
chapter emission.

The check that matters is cross-implementation: convert, then walk the output with the
**TypeScript** engine (`walkDir` + `resolveDocument`) and assert the ABSENCE of parse errors
and dangling pointers across the whole tree. A Rust writer validated only by Rust proves
nothing. That sweep found a real serializer bug on its first run — a block scalar whose first
line is blank and whose first *content* line is indented emitted source that would not
reparse — which was fixed in both implementations and pinned as `test-examples/0602-01`.

## See also

- `../parser/rust` — `yamlover-parser`, the IR and serializer this writes through
- `../onenote2yamlover` — the other importer (C#/.NET; OneNote is COM-only on Windows)
- `docs/documents/chapter`, `docs/language/concretes` — what the output means
