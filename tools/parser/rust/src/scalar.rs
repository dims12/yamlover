// The reader-side helpers the SERIALIZER depends on (ts/src/yamlover.ts exports these four
// for exactly this reason).
//
// The raw-first law is a round-trip guard, not a formatting preference: the serializer
// re-emits an authored spelling only after proving it still reparses to the very same value.
// That proof needs the reader. So these land with the writer half even though they belong to
// the parser — `plain_scalar`, `split_kv`, `unquote_key`, `fold_lines`.

use crate::ir::ScalarValue;

/// YAML folding: adjacent content lines join with a space, blank lines stay breaks.
///
/// Shared with the serializer — the authored-`>` round-trip check reuses the one law, so a
/// fold this produces is a fold the reader will undo identically.
pub fn fold_lines(lines: &[String]) -> String {
    let mut out = String::new();
    for (i, line) in lines.iter().enumerate() {
        if i > 0 {
            out.push(if line.is_empty() || lines[i - 1].is_empty() { '\n' } else { ' ' });
        }
        out.push_str(line);
    }
    out
}

/// The end of a LEADING flow token, as a byte index: 0 when the text opens no flow token,
/// None when it opens one that never closes.
fn flow_token_end(text: &str) -> Option<usize> {
    let b = text.as_bytes();
    if b.first() != Some(&b'[') && b.first() != Some(&b'{') {
        return Some(0);
    }
    let mut depth = 0i32;
    let mut quote: Option<u8> = None;
    let mut i = 0usize;
    while i < b.len() {
        let ch = b[i];
        if let Some(q) = quote {
            if ch == q {
                // a doubled '' is a literal quote
                if q == b'\'' && b.get(i + 1) == Some(&b'\'') {
                    i += 1;
                } else {
                    quote = None;
                }
            }
        } else if ch == b'\'' || ch == b'"' {
            quote = Some(ch);
        } else if ch == b'[' || ch == b'{' {
            depth += 1;
        } else if ch == b']' || ch == b'}' {
            depth -= 1;
            if depth == 0 {
                return Some(i + 1);
            }
        }
        i += 1;
    }
    None
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyValue {
    pub key: String,
    pub rest: String,
    pub rest_col: usize,
}

/// Split a block line into `key: value`, or None when the line is not a key line.
///
/// A leading FLOW token is scanned WHOLE before the colon hunt: its interior colons belong
/// to the flow grammar, not to a key. The token is a KEY only when a `:` follows it
/// (`[256, 256]: *…` — the thumbnail overlay's flow-seq key); otherwise the line is a flow
/// VALUE and this returns None. Without that, a document root `{a: 1}` split at its first
/// `: ` and parsed as the key `{a` with the string value `1}` — a SILENT misparse.
pub fn split_kv(text: &str) -> Option<KeyValue> {
    let from = flow_token_end(text)?;
    let b = text.as_bytes();
    let (mut in_s, mut in_d) = (false, false);
    for i in from..b.len() {
        let c = b[i];
        if c == b'\'' && !in_d {
            in_s = !in_s;
        } else if c == b'"' && !in_s {
            in_d = !in_d;
        } else if c == b':' && !in_s && !in_d {
            let next = b.get(i + 1);
            if next.is_none() || next == Some(&b' ') || next == Some(&b'\t') {
                let after = &text[i + 1..];
                let lead = after.len() - after.trim_start().len();
                return Some(KeyValue {
                    key: text[..i].trim().to_string(),
                    rest: after.trim().to_string(),
                    rest_col: i + 1 + lead,
                });
            }
        }
    }
    None
}

/// Read an authored key token the ONE way the parser does — the `key_raw` reparse guard
/// depends on this agreeing exactly.
pub fn unquote_key(key: &str) -> String {
    let key = key.trim();
    let b = key.as_bytes();
    // A LONE quote counts as quoted, matching JS: for `"` the first and last character are
    // the same character (index 0 is index len-1), so the TS guard passes and `slice(1, 0)`
    // yields an empty body. Guarding on `len >= 2` here would diverge — the parity gate
    // caught exactly that.
    if let Some(&first) = b.first()
        && (first == b'\'' || first == b'"')
        && b[b.len() - 1] == first
    {
        return quoted_scalar(key);
    }
    backslash_unescape(key)
}

/// The decoded value of a quoted scalar token (quotes included in `text`).
fn quoted_scalar(text: &str) -> String {
    let q = text.as_bytes()[0];
    // `text.slice(1, len-1)` in JS yields "" when len == 1; Rust would panic on `1..0`.
    let body = if text.len() < 2 { "" } else { &text[1..text.len() - 1] };
    if q == b'\'' {
        return body.replace("''", "'");
    }
    // double-quoted: JSON-ish escapes
    let chars: Vec<char> = body.chars().collect();
    let mut out = String::with_capacity(body.len());
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] == '\\' {
            i += 1;
            let Some(&c) = chars.get(i) else { break };
            match c {
                'n' => out.push('\n'),
                't' => out.push('\t'),
                'r' => out.push('\r'),
                '"' => out.push('"'),
                '\\' => out.push('\\'),
                '/' => out.push('/'),
                'b' => out.push('\u{8}'),
                'f' => out.push('\u{c}'),
                '0' => out.push('\0'),
                'u' => {
                    let hex: String = chars.get(i + 1..i + 5).unwrap_or(&[]).iter().collect();
                    // JS `String.fromCharCode(parseInt(…, 16))` — NaN becomes \u0000
                    let code = u32::from_str_radix(&hex, 16).unwrap_or(0);
                    out.push(char::from_u32(code).unwrap_or('\u{0}'));
                    i += 4;
                }
                'x' => {
                    let hex: String = chars.get(i + 1..i + 3).unwrap_or(&[]).iter().collect();
                    let code = u32::from_str_radix(&hex, 16).unwrap_or(0);
                    out.push(char::from_u32(code).unwrap_or('\u{0}'));
                    i += 2;
                }
                other => out.push(other),
            }
            i += 1;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

fn backslash_unescape(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] == '\\' && i + 1 < chars.len() {
            out.push(chars[i + 1]);
            i += 2;
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// The value a PLAIN (unquoted) scalar token reads as. A string emitted plain must reparse
/// to itself, and this is what decides that.
///
/// yamlover follows YAML's float specials (`.inf` / `.nan`), not json5's `Infinity`/`NaN`
/// words.
pub fn plain_scalar(text: &str) -> ScalarValue {
    let t = text.trim();
    if t.is_empty() || t == "~" || t == "null" || t == "Null" || t == "NULL" {
        return ScalarValue::Null;
    }
    if t == "true" || t == "True" || t == "TRUE" {
        return ScalarValue::Bool(true);
    }
    if t == "false" || t == "False" || t == "FALSE" {
        return ScalarValue::Bool(false);
    }
    if let Some(v) = float_special(t) {
        return ScalarValue::Num(v);
    }
    if is_decimal_number(t) {
        // JS `Number(t)`; a leading `+` is accepted there and rejected by Rust's parser.
        if let Ok(n) = t.trim_start_matches('+').parse::<f64>() {
            return ScalarValue::Num(n);
        }
    }
    if let Some(n) = hex_number(t) {
        return ScalarValue::Num(n);
    }
    ScalarValue::Str(t.to_string())
}

/// `^[-+]?\.(?:inf|Inf|INF)$` and `^\.(?:nan|NaN|NAN)$`.
fn float_special(t: &str) -> Option<f64> {
    let (sign, rest) = match t.as_bytes().first() {
        Some(b'-') => (-1.0, &t[1..]),
        Some(b'+') => (1.0, &t[1..]),
        _ => (1.0, t),
    };
    if matches!(rest, ".inf" | ".Inf" | ".INF") {
        return Some(sign * f64::INFINITY);
    }
    // `.nan` takes NO sign — the TS regex has no `[-+]?` on the NaN arm
    if matches!(t, ".nan" | ".NaN" | ".NAN") {
        return Some(f64::NAN);
    }
    None
}

/// `^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$`
fn is_decimal_number(t: &str) -> bool {
    let b = t.as_bytes();
    let mut i = 0usize;
    if i < b.len() && (b[i] == b'-' || b[i] == b'+') {
        i += 1;
    }
    let mant_start = i;
    if i < b.len() && b[i] == b'.' {
        // `\.\d+`
        i += 1;
        let d0 = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == d0 {
            return false;
        }
    } else {
        // `\d+\.?\d*`
        let d0 = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == d0 {
            return false;
        }
        if i < b.len() && b[i] == b'.' {
            i += 1;
            while i < b.len() && b[i].is_ascii_digit() {
                i += 1;
            }
        }
    }
    if i == mant_start {
        return false;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'-' || b[i] == b'+') {
            i += 1;
        }
        let d0 = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == d0 {
            return false;
        }
    }
    i == b.len()
}

/// `^[-+]?0x[0-9a-fA-F]+$` — the sign applied to the magnitude.
///
/// The twin of `hexValue` in `ts/src/serialize-common.ts`, and the reason that helper exists:
/// every TS call site used to test a regex that ADMITS the sign and then value the token with
/// `Number(tok)`, whose string-to-number conversion takes a hex prefix only unsigned. So
/// `-0xff` parsed to NaN and re-serialized as `.nan` — silent corruption on a round-trip, in
/// three places at once. Found by `tests/ts_parity.rs` and fixed on both sides 2026-08-17.
///
/// Note yamlover takes `0x` only, while json5p takes `0[xX]` — two grammars, one valuation.
fn hex_number(t: &str) -> Option<f64> {
    let neg = t.starts_with('-');
    let rest = if neg || t.starts_with('+') { &t[1..] } else { t };
    let digits = rest.strip_prefix("0x")?;
    if digits.is_empty() || !digits.bytes().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    // u128 covers every hex literal the corpus can hold; beyond that JS would lose precision
    // too, and the raw-first guard simply declines to keep the spelling.
    let mag = u128::from_str_radix(digits, 16).ok()? as f64;
    // `-0x0` yields -0, exactly as the decimal `-0` path does — the sign survives because
    // ScalarValue's equality is sign-aware and the raw-first guard compares with it.
    Some(if neg { -mag } else { mag })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folding_joins_content_lines_and_keeps_blank_breaks() {
        let l = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(fold_lines(&l(&["a", "b"])), "a b");
        assert_eq!(fold_lines(&l(&["a", "", "b"])), "a\n\nb");
        assert_eq!(fold_lines(&l(&["a"])), "a");
        assert_eq!(fold_lines(&[]), "");
    }

    #[test]
    fn split_kv_finds_the_key() {
        let kv = split_kv("key: value").unwrap();
        assert_eq!(kv.key, "key");
        assert_eq!(kv.rest, "value");

        let bare = split_kv("key:").unwrap();
        assert_eq!(bare.key, "key");
        assert_eq!(bare.rest, "");

        assert_eq!(split_kv("no colon here"), None);
        assert_eq!(split_kv("a:b"), None, "the colon must be followed by space or EOL");
    }

    #[test]
    fn a_leading_flow_token_is_scanned_whole_before_the_colon_hunt() {
        // the misparse this rule exists to prevent
        assert_eq!(split_kv("{a: 1}"), None, "a flow VALUE, not the key `{{a`");
        assert_eq!(split_kv("{a: [1]}"), None);
        // …but a flow token FOLLOWED by a colon really is a key
        let kv = split_kv("[256, 256]: *x").unwrap();
        assert_eq!(kv.key, "[256, 256]");
        assert_eq!(kv.rest, "*x");
        assert_eq!(split_kv("{unterminated: 1"), None, "an unterminated flow token is a value");
    }

    #[test]
    fn quoted_colons_do_not_split() {
        let kv = split_kv("'a: b': v").unwrap();
        assert_eq!(kv.key, "'a: b'");
        assert_eq!(kv.rest, "v");
    }

    #[test]
    fn unquote_key_reads_both_quote_styles_and_backslashes() {
        assert_eq!(unquote_key("abc"), "abc");
        assert_eq!(unquote_key("'a b'"), "a b");
        assert_eq!(unquote_key("'it''s'"), "it's");
        assert_eq!(unquote_key("\"a\\nb\""), "a\nb");
        assert_eq!(unquote_key("a\\*b"), "a*b", "plain keys are backslash-UNescaped");
        assert_eq!(unquote_key("\"\\u0041\""), "A");
    }

    #[test]
    fn plain_scalar_reads_the_null_and_boolean_words() {
        assert_eq!(plain_scalar(""), ScalarValue::Null);
        assert_eq!(plain_scalar("~"), ScalarValue::Null);
        assert_eq!(plain_scalar("null"), ScalarValue::Null);
        assert_eq!(plain_scalar("NULL"), ScalarValue::Null);
        assert_eq!(plain_scalar("true"), ScalarValue::Bool(true));
        assert_eq!(plain_scalar("False"), ScalarValue::Bool(false));
        assert_eq!(plain_scalar("nul"), ScalarValue::Str("nul".into()));
    }

    #[test]
    fn plain_scalar_reads_yaml_float_specials_not_json5_words() {
        assert_eq!(plain_scalar(".inf"), ScalarValue::Num(f64::INFINITY));
        assert_eq!(plain_scalar("-.inf"), ScalarValue::Num(f64::NEG_INFINITY));
        assert_eq!(plain_scalar(".nan"), ScalarValue::Num(f64::NAN));
        assert_eq!(plain_scalar("Infinity"), ScalarValue::Str("Infinity".into()));
        assert_eq!(plain_scalar("NaN"), ScalarValue::Str("NaN".into()));
        assert_eq!(plain_scalar("-.nan"), ScalarValue::Str("-.nan".into()), "NaN takes no sign");
    }

    #[test]
    fn plain_scalar_reads_numbers_in_every_authored_spelling() {
        assert_eq!(plain_scalar("1"), ScalarValue::Num(1.0));
        assert_eq!(plain_scalar("1.0"), ScalarValue::Num(1.0));
        assert_eq!(plain_scalar("-0"), ScalarValue::Num(-0.0));
        assert_eq!(plain_scalar(".5"), ScalarValue::Num(0.5));
        assert_eq!(plain_scalar("5."), ScalarValue::Num(5.0));
        assert_eq!(plain_scalar("1e3"), ScalarValue::Num(1000.0));
        assert_eq!(plain_scalar("1E+3"), ScalarValue::Num(1000.0));
        assert_eq!(plain_scalar("+7"), ScalarValue::Num(7.0));
        assert_eq!(plain_scalar("0x1F"), ScalarValue::Num(31.0));
    }

    #[test]
    fn a_signed_hex_literal_takes_its_sign() {
        // The regression test for the bug tools/parser/rust found in tools/parser/ts: the
        // sign was admitted by the grammar and then dropped by the valuation, so `-0xff`
        // became NaN and re-serialized as `.nan`. YAML 1.2 spells a negative hex int exactly
        // this way.
        assert_eq!(plain_scalar("-0xff"), ScalarValue::Num(-255.0));
        assert_eq!(plain_scalar("+0x1"), ScalarValue::Num(1.0));
        assert_eq!(plain_scalar("0xff"), ScalarValue::Num(255.0));
        assert_eq!(plain_scalar("-0x0"), ScalarValue::Num(-0.0), "the sign survives on zero");
        assert_ne!(plain_scalar("-0x0"), ScalarValue::Num(0.0));
    }

    #[test]
    fn near_numbers_stay_strings() {
        for s in ["1.2.3", "1e", ".", "..", "0x", "0xzz", "1 2", "--1", "1-"] {
            assert_eq!(plain_scalar(s), ScalarValue::Str(s.into()), "{s:?} is not a number");
        }
    }

    #[test]
    fn minus_zero_keeps_its_sign_through_the_reader() {
        // `-0` and `0` must NOT compare equal, or the raw-first guard would keep the wrong
        // spelling — ScalarValue::eq is sign-aware for exactly this.
        assert_ne!(plain_scalar("-0"), plain_scalar("0"));
    }
}
