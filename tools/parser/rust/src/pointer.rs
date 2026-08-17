// Pointer expressions — the RENDER half (ts/src/pointer.ts's `renderPointer` / `keyPortion`).
//
// The parse half lands with the reader; a writer only ever needs to spell a pointer it
// already holds as base + steps. Both halves share one spelling law, which is the point:
// `keyPortion` is THE canonical key spelling, and the YAML-keys round retired five
// disagreeing copies of it.

use crate::ir::{Pointer, PointerBase, Step};

/// Render a pointer in CANONICAL colon form (the dual window's emission side).
///
/// `spaced` = the `: ` styling for block positions; compact (no spaces) for flow and
/// `!!<…>` contexts. The `raw` is NOT used — base + steps are re-rendered, so a pointer
/// authored in any spelling emits in the one canonical form.
pub fn render_pointer(p: &Pointer, spaced: bool) -> String {
    let sep = if spaced { ": " } else { ":" };
    let mut toks: Vec<String> = Vec::with_capacity(p.steps.len());

    for st in &p.steps {
        match st {
            Step::Parent => toks.push("..".to_string()),
            Step::Key { name } => toks.push(key_portion(name)),
            Step::NullKey => toks.push("~".to_string()),
            // the keyless segment
            Step::Append => toks.push("-".to_string()),
            // the bare integer segment; `[n]` is read-only
            Step::Index { n } => toks.push(n.to_string()),
            // A relative group `[.]` / `[.±k]` attaches to the PRECEDING token
            // (`..[.-1][.]`, `pets[.-1]`) — it is a frame operator, not a portion of its own.
            Step::RelIndex { k } => {
                let t = if *k == 0 {
                    "[.]".to_string()
                } else if *k > 0 {
                    format!("[.+{k}]")
                } else {
                    format!("[.{k}]")
                };
                match toks.last_mut() {
                    Some(last) => last.push_str(&t),
                    None => toks.push(t),
                }
            }
        }
    }

    let body = toks.join(sep);
    match &p.base {
        PointerBase::Current => body,
        PointerBase::Parent => {
            if body.is_empty() {
                "..".to_string()
            } else {
                format!("..{sep}{body}")
            }
        }
        PointerBase::Document => {
            if body.is_empty() {
                ":".to_string()
            } else if spaced {
                format!(": {body}")
            } else {
                format!(":{body}")
            }
        }
        PointerBase::Link { authority, world } => {
            let ladder = if *world { ":::" } else { "::" };
            let auth = key_portion(authority);
            let head = if spaced {
                format!("{ladder} {auth}")
            } else {
                format!("{ladder}{auth}")
            };
            if body.is_empty() {
                head
            } else {
                format!("{head}{sep}{body}")
            }
        }
    }
}

/// THE canonical key spelling — one policy, every emitter.
///
/// A string key is QUOTED whenever its bare form would read as something else: empty, pure
/// digits (a position), `~` (the null key), a lone `-` or a leading `-` with digits
/// (reserved), whitespace, or a leading quote; otherwise it rides bare with metachars
/// backslash-escaped — `:` in the set, `/` out of it (docs/language/pointers/paths).
pub fn key_portion(name: &str) -> String {
    if name == ".." {
        return "\\.\\.".to_string();
    }
    let quote = name.is_empty()
        || is_all_digits(name)
        || name == "~"
        // bare '-' is the keyless segment now — a literal '-' key rides quoted
        || name == "-"
        || starts_dash_digit(name)
        || name.contains(' ')
        || name.contains('\t')
        || name.starts_with('\'')
        || name.starts_with('"');

    if quote {
        return format!("'{}'", name.replace('\'', "''"));
    }
    escape_chars(name, |c| matches!(c, '\\' | ':' | '[' | ']' | '*' | '&' | '#' | '~' | '?' | '!' | '(' | ')' | '<' | '>' | '=' | '|'))
}

/// Back-compat alias — the historical name for [`key_portion`].
pub fn colon_segment(name: &str) -> String {
    key_portion(name)
}

pub(crate) fn is_all_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// `^-\d` — a leading dash followed by a digit.
fn starts_dash_digit(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 2 && b[0] == b'-' && b[1].is_ascii_digit()
}

pub(crate) fn escape_chars(s: &str, needs: impl Fn(char) -> bool) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if needs(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::Pointer;

    fn ptr(base: PointerBase, steps: Vec<Step>) -> Pointer {
        Pointer::new(base, steps)
    }

    fn key(name: &str) -> Step {
        Step::Key { name: name.to_string() }
    }

    #[test]
    fn document_scope_spaces_after_the_colon() {
        let p = ptr(PointerBase::Document, vec![key("a"), key("b")]);
        assert_eq!(render_pointer(&p, true), ": a: b");
        assert_eq!(render_pointer(&p, false), ":a:b");
    }

    #[test]
    fn a_bare_document_pointer_is_just_the_colon() {
        let p = ptr(PointerBase::Document, vec![]);
        assert_eq!(render_pointer(&p, true), ":");
        assert_eq!(render_pointer(&p, false), ":");
    }

    #[test]
    fn link_scope_renders_the_ladder_and_the_authority() {
        let p = ptr(
            PointerBase::Link { authority: "yamlover".into(), world: false },
            vec![key("$defs"), key("chapter")],
        );
        assert_eq!(render_pointer(&p, false), "::yamlover:$defs:chapter");
        assert_eq!(render_pointer(&p, true), ":: yamlover: $defs: chapter");

        let world = ptr(PointerBase::Link { authority: "example.com".into(), world: true }, vec![]);
        assert_eq!(render_pointer(&world, false), ":::example.com");
    }

    #[test]
    fn parent_scope_alone_is_two_dots() {
        assert_eq!(render_pointer(&ptr(PointerBase::Parent, vec![]), true), "..");
        assert_eq!(
            render_pointer(&ptr(PointerBase::Parent, vec![key("x")]), true),
            "..: x"
        );
    }

    #[test]
    fn a_relative_index_glues_onto_the_preceding_token() {
        let p = ptr(PointerBase::Current, vec![key("pets"), Step::RelIndex { k: -1 }]);
        assert_eq!(render_pointer(&p, true), "pets[.-1]");

        let plus = ptr(PointerBase::Current, vec![key("pets"), Step::RelIndex { k: 2 }]);
        assert_eq!(render_pointer(&plus, true), "pets[.+2]");

        let zero = ptr(PointerBase::Current, vec![key("pets"), Step::RelIndex { k: 0 }]);
        assert_eq!(render_pointer(&zero, true), "pets[.]");
    }

    #[test]
    fn a_leading_relative_index_stands_alone() {
        let p = ptr(PointerBase::Parent, vec![Step::RelIndex { k: 0 }]);
        assert_eq!(render_pointer(&p, true), "..: [.]");
    }

    #[test]
    fn keys_that_would_read_as_something_else_are_quoted() {
        assert_eq!(key_portion(""), "''");
        assert_eq!(key_portion("12"), "'12'", "bare digits are a position claim");
        assert_eq!(key_portion("~"), "'~'", "bare ~ is the null key");
        assert_eq!(key_portion("-"), "'-'", "bare - is the keyless segment");
        assert_eq!(key_portion("-1"), "'-1'");
        assert_eq!(key_portion("a b"), "'a b'");
        assert_eq!(key_portion("'q"), "'''q'", "a leading quote forces quoting, then doubles");
    }

    #[test]
    fn an_embedded_quote_doubles() {
        assert_eq!(key_portion("it's"), "it's", "no quoting trigger — the apostrophe rides bare");
        assert_eq!(key_portion("a 'b'"), "'a ''b'''");
    }

    #[test]
    fn parent_as_a_literal_key_is_backslash_escaped_not_quoted() {
        assert_eq!(key_portion(".."), "\\.\\.");
    }

    #[test]
    fn metachars_are_backslash_escaped_colon_in_slash_out() {
        assert_eq!(key_portion("a:b"), "a\\:b");
        assert_eq!(key_portion("a/b"), "a/b", "`/` is OUT of the keyPortion set");
        assert_eq!(key_portion("a*b&c#d"), "a\\*b\\&c\\#d");
        assert_eq!(key_portion("x[0]"), "x\\[0\\]");
    }

    #[test]
    fn a_dash_word_key_stays_bare() {
        assert_eq!(key_portion("a-b"), "a-b");
        assert_eq!(key_portion("-a"), "-a", "only `-` + DIGIT is reserved");
    }

    #[test]
    fn cyrillic_keys_ride_bare() {
        assert_eq!(key_portion("имя"), "имя");
    }
}
