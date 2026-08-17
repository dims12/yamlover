// Raw RFC-822 bytes → a normalized `Message`.
//
// mail-parser does the MIME work and `full_encoding` (encoding_rs) the charset work. The
// reference archive needs both: koi8-r, windows-1251, iso-8859-1/2/9/15, windows-1250/1252,
// iso-2022-jp and gb2312 all appear, against 733 messages that are actually UTF-8.
//
// WHAT THIS KEEPS. "All message fields" means every header survives, so `headers` is the
// complete list in source order with duplicates intact (`Received` appears many times and
// its order is the delivery path — collapsing it would destroy the one thing it is for).
// The curated fields on top are a convenience, not a filter.

use std::sync::LazyLock;

use mail_parser::{
    Address, ContentType, DateTime, HeaderName, HeaderValue, Message as MimeMessage, MessageParser,
    MimeHeaders, PartType,
};

/// `with_minimal_headers` brings MIME + Date + Subject + the address headers, which is what
/// the body/attachment walk and the curated fields need; `default_header_text` then decodes
/// every OTHER header (`Received`, `Return-Path`, `X-*`) as unstructured text with RFC-2047
/// encoded-words resolved, which is what the `headers:` map wants.
static PARSER: LazyLock<MessageParser> = LazyLock::new(|| {
    MessageParser::new()
        .with_minimal_headers()
        .with_message_ids()
        .default_header_text()
});

/// One attachment, decoded.
#[derive(Debug, Clone)]
pub struct Attachment {
    /// The name as the message gave it, before any filesystem sanitizing.
    pub name: Option<String>,
    pub bytes: Vec<u8>,
    pub content_type: String,
    /// True when the part announced a filename but carried no bytes. On this corpus that is
    /// TheBat having moved the payload into the account's `Attach/` directory — 1,352 parts.
    pub empty: bool,
}

/// A message, normalized.
#[derive(Debug, Clone, Default)]
pub struct Message {
    pub subject: String,
    pub from: String,
    pub to: String,
    pub cc: String,
    pub date: Option<String>,
    pub message_id: String,
    pub in_reply_to: String,
    /// Every header, in source order, duplicates kept: `(name, value)`.
    pub headers: Vec<(String, String)>,
    /// The text/plain body, decoded to UTF-8 and CRLF-normalized.
    pub text: Option<String>,
    /// The text/html body, if the message had one and no plain alternative worth preferring.
    pub html: Option<String>,
    pub attachments: Vec<Attachment>,
    /// Non-fatal problems worth reporting rather than swallowing.
    pub warnings: Vec<String>,
}

/// Parse raw RFC-822. Returns None only when there are no headers at all — mail-parser makes
/// a best effort otherwise and never panics.
pub fn parse(raw: &[u8]) -> Option<Message> {
    let mime = PARSER.parse(raw)?;
    let mut m = Message {
        subject: mime.subject().unwrap_or_default().to_string(),
        message_id: mime.message_id().unwrap_or_default().to_string(),
        ..Default::default()
    };

    for h in mime.headers() {
        let name = header_name(&h.name);
        let value = render_value(&h.value);
        match name.to_ascii_lowercase().as_str() {
            "from" if m.from.is_empty() => m.from = value.clone(),
            "to" if m.to.is_empty() => m.to = value.clone(),
            "cc" if m.cc.is_empty() => m.cc = value.clone(),
            "in-reply-to" if m.in_reply_to.is_empty() => m.in_reply_to = value.clone(),
            "date" if m.date.is_none() => {
                if let HeaderValue::DateTime(dt) = &h.value {
                    m.date = Some(iso8601(dt));
                }
            }
            _ => {}
        }
        m.headers.push((name, value));
    }

    // BODIES — and NOT via `body_text`/`body_html`.
    //
    // Those accessors CONVERT: `body_html` runs `text_to_html` over a text-only message and
    // `body_text` runs `html_to_text` over an html-only one, so both return Some for every
    // message. Using them would have written a synthesized `body.html` beside every one of
    // the 18,230 text/plain messages in the reference archive — a derived artefact
    // masquerading as something the sender wrote. Read the actual part type instead, so
    // `html` is Some only when the message really carried an HTML alternative.
    m.text = real_body(&mime, &mime.text_body, false);
    m.html = real_body(&mime, &mime.html_body, true);
    // A message that is html-only leaves `text` None — the emitter then writes the HTML as a
    // member file rather than inventing a plain-text rendering.

    collect_attachments(&mime, &mut m);
    Some(m)
}

/// The first body part of the requested kind, only if it REALLY is that kind — no conversion.
fn real_body(mime: &MimeMessage<'_>, ids: &[u32], want_html: bool) -> Option<String> {
    let part = mime.parts.get(*ids.first()? as usize)?;
    match (&part.body, want_html) {
        (PartType::Text(t), false) => Some(normalize_newlines(t)),
        (PartType::Html(h), true) => Some(normalize_newlines(h)),
        _ => None,
    }
}

fn collect_attachments(mime: &MimeMessage<'_>, m: &mut Message) {
    for part in mime.attachments() {
        let name = part.attachment_name().map(str::to_string);
        let content_type = part
            .content_type()
            .map(render_content_type)
            .unwrap_or_else(|| "application/octet-stream".to_string());
        let bytes: Vec<u8> = match &part.body {
            PartType::Binary(b) | PartType::InlineBinary(b) => b.to_vec(),
            PartType::Text(t) | PartType::Html(t) => t.as_bytes().to_vec(),
            // A nested message/rfc822 attachment: keep its raw bytes so the archive holds the
            // forwarded original rather than a re-rendering of it.
            PartType::Message(inner) => inner.raw_message.to_vec(),
            PartType::Multipart(_) => continue,
        };
        let empty = bytes.is_empty();
        if empty {
            m.warnings.push(format!(
                "attachment {:?} announced a name but carried no bytes — TheBat stores such payloads in the account's Attach/ directory",
                name.as_deref().unwrap_or("<unnamed>")
            ));
        }
        m.attachments.push(Attachment { name, bytes, content_type, empty });
    }
}

fn header_name(n: &HeaderName<'_>) -> String {
    n.as_str().to_string()
}

/// Render a parsed header value back to one line of text.
///
/// With this parser configuration the overwhelming majority arrive as `Text`; the structured
/// arms exist because `with_minimal_headers` parses the address, date and content-type
/// headers, and those must not come out as debug formatting.
fn render_value(v: &HeaderValue<'_>) -> String {
    match v {
        HeaderValue::Text(s) => s.to_string(),
        HeaderValue::TextList(v) => v.join(", "),
        HeaderValue::DateTime(dt) => iso8601(dt),
        HeaderValue::ContentType(ct) => render_content_type(ct),
        HeaderValue::Address(a) => render_address(a),
        // Received is never configured on this parser (it falls to `default_header_text`), so
        // this arm is unreachable in practice — kept because the enum is non_exhaustive-ish
        // and a future header form should not silently become a debug string.
        HeaderValue::Received(_) => String::new(),
        HeaderValue::Empty => String::new(),
    }
}

fn render_address(a: &Address<'_>) -> String {
    let mut out: Vec<String> = Vec::new();
    match a {
        Address::List(list) => {
            for addr in list {
                out.push(render_addr(addr.name.as_deref(), addr.address.as_deref()));
            }
        }
        Address::Group(groups) => {
            for g in groups {
                let inner: Vec<String> = g
                    .addresses
                    .iter()
                    .map(|a| render_addr(a.name.as_deref(), a.address.as_deref()))
                    .collect();
                match g.name.as_deref() {
                    Some(n) => out.push(format!("{n}: {}", inner.join(", "))),
                    None => out.extend(inner),
                }
            }
        }
    }
    out.retain(|s| !s.is_empty());
    out.join(", ")
}

fn render_addr(name: Option<&str>, address: Option<&str>) -> String {
    match (name, address) {
        (Some(n), Some(a)) if !n.is_empty() => format!("{n} <{a}>"),
        (_, Some(a)) => a.to_string(),
        (Some(n), None) => n.to_string(),
        (None, None) => String::new(),
    }
}

fn render_content_type(ct: &ContentType<'_>) -> String {
    let mut s = ct.ctype().to_string();
    if let Some(sub) = ct.subtype() {
        s.push('/');
        s.push_str(sub);
    }
    if let Some(attrs) = ct.attributes() {
        for a in attrs {
            s.push_str(&format!("; {}={}", a.name, a.value));
        }
    }
    s
}

/// RFC 3339, which is what a `date:` field should hold.
fn iso8601(dt: &DateTime) -> String {
    let sign = if dt.tz_before_gmt { '-' } else { '+' };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}{}{:02}:{:02}",
        dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second, sign, dt.tz_hour, dt.tz_minute
    )
}

/// CRLF → LF. Mail is CRLF on the wire; yamlover files are LF, and a stray `\r` would force
/// the serializer to abandon block scalars and double-quote the whole body.
pub fn normalize_newlines(s: &str) -> String {
    s.replace("\r\n", "\n").replace('\r', "\n")
}

/// A conventional file extension for a media type, for naming an attachment that has none.
pub fn extension_for(content_type: &str) -> &'static str {
    match content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase().as_str() {
        "text/plain" => ".txt",
        "text/html" => ".html",
        "image/jpeg" | "image/pjpeg" => ".jpg",
        "image/png" => ".png",
        "image/gif" => ".gif",
        "application/pdf" => ".pdf",
        "application/zip" => ".zip",
        "message/rfc822" => ".eml",
        _ => ".bin",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_header_survives_in_order_with_duplicates() {
        let raw = b"Received: from a\r\nReceived: from b\r\nSubject: hi\r\nX-Mailer: The Bat!\r\n\r\nbody\r\n";
        let m = parse(raw).expect("parses");
        let names: Vec<&str> = m.headers.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, ["Received", "Received", "Subject", "X-Mailer"]);
        assert_eq!(m.headers[0].1, "from a");
        assert_eq!(m.headers[1].1, "from b", "the delivery path order is the point");
    }

    #[test]
    fn an_encoded_word_subject_decodes_from_a_legacy_charset() {
        // koi8-r, base64 — the reference archive is full of these
        let raw = b"Subject: =?koi8-r?B?8NLJ18XU?=\r\nFrom: a@b.ru\r\n\r\nbody\r\n";
        let m = parse(raw).expect("parses");
        assert_eq!(m.subject, "Привет");
    }

    #[test]
    fn a_windows_1251_body_decodes_to_utf8() {
        let mut raw: Vec<u8> = b"Subject: t\r\nContent-Type: text/plain; charset=windows-1251\r\n\r\n".to_vec();
        raw.extend_from_slice(&[0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]); // "Привет" in cp1251
        let m = parse(&raw).expect("parses");
        assert_eq!(m.text.as_deref(), Some("Привет"));
    }

    #[test]
    fn the_date_becomes_rfc3339() {
        let raw = b"Date: Wed, 16 Feb 2005 09:23:23 +0300\r\nSubject: t\r\n\r\nx\r\n";
        let m = parse(raw).expect("parses");
        assert_eq!(m.date.as_deref(), Some("2005-02-16T09:23:23+03:00"));
    }

    #[test]
    fn addresses_render_with_their_display_names() {
        let raw = "From: =?utf-8?B?0JjQvNGP?= <a@b.ru>\r\nTo: x@y.ru, z@w.ru\r\nSubject: t\r\n\r\nb\r\n";
        let m = parse(raw.as_bytes()).expect("parses");
        assert_eq!(m.from, "Имя <a@b.ru>");
        assert_eq!(m.to, "x@y.ru, z@w.ru");
    }

    #[test]
    fn an_attachment_comes_out_with_its_name_and_bytes() {
        let raw = "Subject: t\r\n\
             MIME-Version: 1.0\r\n\
             Content-Type: multipart/mixed; boundary=BB\r\n\r\n\
             --BB\r\nContent-Type: text/plain\r\n\r\nhello\r\n\
             --BB\r\nContent-Type: image/png\r\n\
             Content-Disposition: attachment; filename=\"pic.png\"\r\n\
             Content-Transfer-Encoding: base64\r\n\r\niVBORw0K\r\n\
             --BB--\r\n";
        let m = parse(raw.as_bytes()).expect("parses");
        assert_eq!(m.text.as_deref(), Some("hello"));
        assert_eq!(m.attachments.len(), 1);
        assert_eq!(m.attachments[0].name.as_deref(), Some("pic.png"));
        assert!(!m.attachments[0].bytes.is_empty());
        assert!(m.attachments[0].content_type.starts_with("image/png"));
    }

    #[test]
    fn an_empty_attachment_payload_is_reported_not_swallowed() {
        let raw = "Subject: t\r\n\
             MIME-Version: 1.0\r\n\
             Content-Type: multipart/mixed; boundary=BB\r\n\r\n\
             --BB\r\nContent-Type: text/plain\r\n\r\nbody\r\n\
             --BB\r\nContent-Type: application/octet-stream\r\n\
             Content-Disposition: attachment; filename=\"gone.dat\"\r\n\r\n\
             --BB--\r\n";
        let m = parse(raw.as_bytes()).expect("parses");
        assert_eq!(m.attachments.len(), 1);
        assert!(m.attachments[0].empty);
        assert!(m.warnings.iter().any(|w| w.contains("gone.dat")), "warnings: {:?}", m.warnings);
    }

    #[test]
    fn crlf_is_normalized_because_a_stray_cr_kills_block_scalars() {
        assert_eq!(normalize_newlines("a\r\nb\rc"), "a\nb\nc");
    }

    #[test]
    fn a_headerless_blob_is_declined_rather_than_guessed_at() {
        assert!(parse(b"").is_none());
    }
}
