// A normalized `Message` → a chapter plus its member files.
//
// THE SHAPE (docs/documents/chapter, examples/60-simple-chapter.yo):
//
//     !!<*yamlover: $defs: chapter>
//     Тема письма                       <- the SUBJECT is the root's self-value, not a key
//     from: "Имя <a@b.ru>"
//     to: dims2000@mtu-net.ru
//     date: 2005-02-16T09:23:23+03:00
//     message-id: "<…>"
//     flags: {read: true}
//     headers:                          <- every header, verbatim, duplicates as arrays
//       Return-Path: "<info@elitarium.ru>"
//       Received:
//       - "from antispam.localhost …"
//       - "…"
//     - !!<format: text/plain> |         <- the body
//       …
//     - *: message.eml                   <- the raw original
//     - *: photo.jpg                     <- attachments
//
// The curated fields sit above a complete `headers:` map rather than replacing it: "all
// message fields" means nothing is dropped, and a reader wanting `From` should not have to
// know whether this importer considered it interesting.

use std::collections::HashSet;

use yamlover_parser::ir::{Node, ScalarValue};

use crate::message::{Attachment, Message, extension_for};
use crate::tree::{Asset, Chapter, Chunk, flow_map, map_node, seq_node, sanitize, unique};

/// The member name of the preserved original.
pub const RAW_NAME: &str = "message.eml";
/// The member name an HTML body takes (`body.html`, then `body (2).html` …).
pub const HTML_STEM: &str = "body";
/// The first such name — named so tests can assert it without re-deriving the rule.
#[allow(dead_code)]
pub const HTML_NAME: &str = "body.html";
/// The stem of the preserved original.
const RAW_STEM: &str = "message";

/// A subject to show when the message had none — the same word `sanitize` falls back to.
const NO_SUBJECT: &str = "(no subject)";

pub struct EmitOptions {
    /// Keep the verbatim RFC-822 source as a `message.eml` member.
    ///
    /// On by default and worth the disk: it is the only thing that makes "nothing was lost"
    /// true regardless of what MIME parsing got wrong, and re-importing needs no access to
    /// the original mailbox. Roughly doubles the output on the reference archive.
    pub keep_raw: bool,
}

impl Default for EmitOptions {
    fn default() -> Self {
        EmitOptions { keep_raw: true }
    }
}

pub struct Emitted {
    pub chapter: Chapter,
    pub assets: Vec<Asset>,
}

impl Emitted {
    /// A message with no members is a leaf: it becomes a single `.yo` FILE rather than a
    /// directory. On the reference archive ~96% of messages take this path, which matters at
    /// 57k messages.
    pub fn needs_dir(&self) -> bool {
        !self.assets.is_empty()
    }
}

/// Unix seconds → RFC 3339 in UTC.
///
/// Hand-rolled rather than pulling in a date crate: this is the only calendar arithmetic the
/// importer does, and the civil-from-days algorithm is a dozen lines. The result is stamped
/// `Z` because the store's timestamp carries no zone — saying `+00:00` would be inventing one.
pub fn unix_to_rfc3339(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // Howard Hinnant's civil_from_days, shifted to an era starting 0000-03-01
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

/// `msg` is the parsed message; `raw` its verbatim bytes; `store_date` the timestamp the
/// STORE recorded, used only when the message itself carries no parsable `Date:` — which is
/// ordinary for drafts and for the mangled headers a twenty-year-old archive accumulates.
pub fn emit(msg: &Message, raw: &[u8], store_date: Option<i64>, opts: &EmitOptions) -> Emitted {
    let title = if msg.subject.trim().is_empty() {
        NO_SUBJECT.to_string()
    } else {
        msg.subject.clone()
    };
    let mut chapter = Chapter::new(title);
    let mut assets: Vec<Asset> = Vec::new();
    let mut used: HashSet<String> = HashSet::new();

    chapter.text_field("from", &msg.from);
    chapter.text_field("to", &msg.to);
    chapter.text_field("cc", &msg.cc);
    match (&msg.date, store_date) {
        (Some(d), _) => {
            chapter.text_field("date", d);
        }
        (None, Some(ts)) => {
            // the message's own Date: was missing or unparsable — fall back to what the store
            // recorded, and SAY so rather than passing it off as the message's own claim
            chapter.text_field("date", &unix_to_rfc3339(ts));
            chapter.text_field("date-source", "the mail store's record, not a Date: header");
        }
        (None, None) => {}
    }
    chapter.text_field("message-id", &msg.message_id);
    chapter.text_field("in-reply-to", &msg.in_reply_to);

    if !msg.headers.is_empty() {
        chapter.field("headers", headers_node(&msg.headers));
    }

    // THE BODY. Always tagged `text/plain`: the default chunk format is `text/marklower`,
    // which would read `*`, `_`, `**` and `[x](y)` in ordinary mail as markup.
    match (&msg.text, &msg.html) {
        (Some(t), _) if !t.trim().is_empty() => {
            chapter.chunk(Chunk::plain(t));
        }
        (_, Some(h)) if !h.trim().is_empty() => {
            // html-only: keep the HTML as a member rather than inventing a plain rendering
            let name = unique(&mut used, HTML_STEM, ".html");
            assets.push(Asset {
                name: name.clone(),
                bytes: h.as_bytes().to_vec(),
                format: "text/html".to_string(),
            });
            chapter.chunk(Chunk::Pointer { member: name });
        }
        _ => {}
    }
    // an html ALTERNATIVE alongside plain text is kept too — it is a different rendering of
    // the message, and discarding it would lose the formatting the sender chose
    if msg.text.as_ref().is_some_and(|t| !t.trim().is_empty())
        && let Some(h) = &msg.html
        && !h.trim().is_empty()
    {
        let name = unique(&mut used, HTML_STEM, ".html");
        assets.push(Asset {
            name: name.clone(),
            bytes: h.as_bytes().to_vec(),
            format: "text/html".to_string(),
        });
        chapter.chunk(Chunk::Pointer { member: name });
    }

    if opts.keep_raw {
        let name = unique(&mut used, RAW_STEM, ".eml");
        assets.push(Asset {
            name: name.clone(),
            bytes: raw.to_vec(),
            // held as BYTES, not text: the original is in its own legacy charset and its
            // headers are the record — decoding it would be a second interpretation
            format: "message/rfc822".to_string(),
        });
        chapter.chunk(Chunk::Pointer { member: name });
    }

    for (i, att) in msg.attachments.iter().enumerate() {
        if att.empty {
            continue; // no bytes to write; the warning already named it
        }
        let name = attachment_name(att, i, &mut used);
        assets.push(Asset {
            name: name.clone(),
            bytes: att.bytes.clone(),
            format: att.content_type.split(';').next().unwrap_or("").trim().to_string(),
        });
        chapter.chunk(Chunk::Pointer { member: name });
    }

    Emitted { chapter, assets }
}

/// `flags: {read: true}` — a flow one-liner, since it is a fixed tiny record.
pub fn flags_node(read: bool) -> Node {
    flow_map(vec![("read".to_string(), ScalarValue::Bool(read))])
}

fn attachment_name(att: &Attachment, index: usize, used: &mut HashSet<String>) -> String {
    let raw = att.name.clone().unwrap_or_else(|| {
        format!("attachment-{:02}{}", index + 1, extension_for(&att.content_type))
    });
    let safe = sanitize(&raw);
    // split the extension so de-duplication inserts ` (2)` before it, not after
    match safe.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => unique(used, stem, &format!(".{ext}")),
        _ => unique(used, &safe, ""),
    }
}

/// Every header as a mapping. A name that repeats becomes an ARRAY of its values in source
/// order — `Received` is the delivery path and its order is its meaning.
fn headers_node(headers: &[(String, String)]) -> Node {
    let mut order: Vec<String> = Vec::new();
    let mut grouped: Vec<(String, Vec<String>)> = Vec::new();
    for (name, value) in headers {
        match grouped.iter_mut().find(|(n, _)| n.eq_ignore_ascii_case(name)) {
            Some((_, vals)) => vals.push(value.clone()),
            None => {
                order.push(name.clone());
                grouped.push((name.clone(), vec![value.clone()]));
            }
        }
    }
    map_node(
        grouped
            .into_iter()
            .map(|(name, mut vals)| {
                let node = if vals.len() == 1 {
                    Node::string(vals.pop().expect("one"))
                } else {
                    seq_node(vals)
                };
                (name, node)
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::message;

    fn emitted(raw: &str, opts: &EmitOptions) -> Emitted {
        let m = message::parse(raw.as_bytes()).expect("parses");
        emit(&m, raw.as_bytes(), None, opts)
    }

    #[test]
    fn a_plain_message_is_a_leaf_file_when_the_raw_is_not_kept() {
        let e = emitted(
            "Subject: hi\r\nFrom: a@b.ru\r\n\r\nbody\r\n",
            &EmitOptions { keep_raw: false },
        );
        assert!(!e.needs_dir(), "no members -> a single .yo file");
        let text = e.chapter.to_text().expect("serializes");
        assert!(text.starts_with("!!<*yamlover: $defs: chapter>\nhi\n"), "got:\n{text}");
        assert!(text.contains("from: a@b.ru"));
        assert!(text.contains("!!<format: text/plain>"), "the body must NOT default to marklower");
    }

    #[test]
    fn keeping_the_raw_forces_a_directory() {
        let e = emitted("Subject: hi\r\n\r\nbody\r\n", &EmitOptions::default());
        assert!(e.needs_dir());
        assert!(e.assets.iter().any(|a| a.name == RAW_NAME && a.format == "message/rfc822"));
    }

    #[test]
    fn repeated_headers_become_an_array_in_source_order() {
        let e = emitted(
            "Received: from a\r\nReceived: from b\r\nSubject: t\r\n\r\nx\r\n",
            &EmitOptions { keep_raw: false },
        );
        let text = e.chapter.to_text().expect("serializes");
        let recv = text.find("Received:").expect("has Received");
        let after = &text[recv..];
        assert!(after.contains("- from a"), "got:\n{text}");
        assert!(after.find("from a") < after.find("from b"), "order is the delivery path");
    }

    #[test]
    fn a_subjectless_message_still_gets_a_title() {
        let e = emitted("From: a@b.ru\r\n\r\nx\r\n", &EmitOptions { keep_raw: false });
        assert_eq!(e.chapter.title, NO_SUBJECT);
    }

    #[test]
    fn attachments_become_members_and_pointer_chunks() {
        let raw = "Subject: t\r\nMIME-Version: 1.0\r\n\
             Content-Type: multipart/mixed; boundary=BB\r\n\r\n\
             --BB\r\nContent-Type: text/plain\r\n\r\nbody\r\n\
             --BB\r\nContent-Type: image/png\r\n\
             Content-Disposition: attachment; filename=\"pic.png\"\r\n\
             Content-Transfer-Encoding: base64\r\n\r\niVBORw0K\r\n--BB--\r\n";
        let e = emitted(raw, &EmitOptions { keep_raw: false });
        assert!(e.assets.iter().any(|a| a.name == "pic.png"));
        let text = e.chapter.to_text().expect("serializes");
        assert!(text.contains("- *: pic.png"), "got:\n{text}");
    }

    #[test]
    fn a_colliding_attachment_name_dedupes_before_the_extension() {
        let raw = "Subject: t\r\nMIME-Version: 1.0\r\n\
             Content-Type: multipart/mixed; boundary=BB\r\n\r\n\
             --BB\r\nContent-Type: image/png\r\n\
             Content-Disposition: attachment; filename=\"pic.png\"\r\n\
             Content-Transfer-Encoding: base64\r\n\r\niVBORw0K\r\n\
             --BB\r\nContent-Type: image/png\r\n\
             Content-Disposition: attachment; filename=\"pic.png\"\r\n\
             Content-Transfer-Encoding: base64\r\n\r\niVBORw0K\r\n--BB--\r\n";
        let e = emitted(raw, &EmitOptions { keep_raw: false });
        let names: Vec<&str> = e.assets.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names, ["pic.png", "pic (2).png"]);
    }

    #[test]
    fn an_html_only_message_keeps_the_html_rather_than_inventing_plain_text() {
        let raw = "Subject: t\r\nContent-Type: text/html\r\n\r\n<p>hi</p>\r\n";
        let e = emitted(raw, &EmitOptions { keep_raw: false });
        assert!(e.assets.iter().any(|a| a.name == HTML_NAME && a.format == "text/html"));
    }

    #[test]
    fn a_body_full_of_markup_characters_survives_verbatim() {
        let raw = "Subject: t\r\n\r\nuse *ptr and _x_ and [a](b) and `code`\r\n";
        let e = emitted(raw, &EmitOptions { keep_raw: false });
        let text = e.chapter.to_text().expect("serializes");
        assert!(text.contains("use *ptr and _x_ and [a](b) and `code`"), "got:\n{text}");
        assert!(text.contains("!!<format: text/plain>"));
    }
}
