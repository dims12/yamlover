// JS `String(v)` for an f64 — ECMA-262 6.1.6.1.20, Number::toString(10).
//
// Rust's `{}` and JS's `String()` both print the SHORTEST decimal that round-trips, so the
// digits agree; where they part company is when to switch to exponential form. JS switches at
// a decimal exponent of 21 and at -7, Rust never does:
//
//     value    JS                       Rust `{}`
//     1e20     100000000000000000000    100000000000000000000
//     1e21     1e+21                    1000000000000000000000
//     1e-6     0.000001                 0.000001
//     1e-7     1e-7                     0.0000001
//
// The serializer emits a MINTED number with this, so the goldens depend on it — test-examples
// 1004 is "JSONTestSuite y_object_extreme_numbers: 1.0e+28 magnitudes" precisely there.
//
// Callers handle -0 themselves (`String(-0)` is "0" in JS, which loses the sign, so the
// serializer spells it "-0" explicitly) and non-finite values before reaching here.

/// The shortest round-tripping decimal digits of `v`, and the position of the decimal point.
///
/// Returns `(digits, n)` where `digits` has no trailing zeros and the value is
/// `0.<digits> × 10^n` — matching the spec's `s` and `n`. `v` must be finite and positive.
fn digits_and_exponent(v: f64) -> (String, i32) {
    // `{:e}` gives the shortest round-tripping mantissa in scientific form: `d.dddde±X`,
    // i.e. the value is `d.dddd × 10^X`.
    let sci = format!("{v:e}");
    let (mantissa, exp) = sci.split_once('e').expect("`{:e}` always emits an exponent");
    let exp: i32 = exp.parse().expect("`{:e}` always emits an integer exponent");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let digits = digits.trim_end_matches('0');
    let digits = if digits.is_empty() { "0" } else { digits };
    // `d.dddd × 10^exp` = `0.ddddd × 10^(exp+1)`
    (digits.to_string(), exp + 1)
}

/// JS `String(v)` for a finite `v`. `-0` prints as `"0"`, exactly as JS does — the serializer
/// special-cases the sign before calling this.
pub fn js_number_to_string(v: f64) -> String {
    if v == 0.0 {
        return "0".to_string(); // covers -0 too, like String(-0)
    }
    let sign = if v < 0.0 { "-" } else { "" };
    let (s, n) = digits_and_exponent(v.abs());
    let k = s.len() as i32;

    let body = if k <= n && n <= 21 {
        // digits followed by n−k zeros
        format!("{s}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        // a decimal point after n digits
        format!("{}.{}", &s[..n as usize], &s[n as usize..])
    } else if -6 < n && n <= 0 {
        // "0." + (−n zeros) + digits
        format!("0.{}{s}", "0".repeat((-n) as usize))
    } else {
        // exponential: the exponent is n−1, and JS writes a `+` for a positive one
        let e = n - 1;
        let esign = if e >= 0 { "+" } else { "-" };
        let mantissa =
            if k == 1 { s.clone() } else { format!("{}.{}", &s[..1], &s[1..]) };
        format!("{mantissa}e{esign}{}", e.abs())
    };
    format!("{sign}{body}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The reference column is literal `String(v)` output from node, not a guess.
    #[test]
    fn matches_js_string_for_the_thresholds_and_the_ordinary_cases() {
        for (v, want) in [
            (30.0f64, "30"),
            (1.5, "1.5"),
            (0.1, "0.1"),
            (-2.5, "-2.5"),
            (1e20, "100000000000000000000"),
            (1e21, "1e+21"), // the upper threshold: n = 22 > 21
            (1e-6, "0.000001"),
            (1e-7, "1e-7"), // the lower threshold: n = -6, and the rule needs n > -6
            (1.0e28, "1e+28"),
            (0.0, "0"),
            (-0.0, "0"), // String(-0) === "0"; the serializer spells the sign itself
            (5e-324, "5e-324"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
            (123456789012345678901234.0, "1.2345678901234569e+23"),
            (1000.0, "1000"),
            (-1e21, "-1e+21"),
        ] {
            assert_eq!(js_number_to_string(v), want, "String({v:e})");
        }
    }

    #[test]
    fn integers_do_not_grow_a_decimal_point() {
        for v in [0.0f64, 1.0, 7.0, 42.0, 255.0, 1e15] {
            let s = js_number_to_string(v);
            assert!(!s.contains('.'), "{v} rendered as {s}");
        }
    }

    #[test]
    fn every_rendering_round_trips_back_to_the_same_bits() {
        // the property that actually matters: the serializer must not lose a value
        for v in [
            1.0f64, 0.1, 1e-7, 1e21, 1.0e28, 5e-324, 1.7976931348623157e308,
            std::f64::consts::PI, -0.30000000000000004, 1234.5678, 9.999999999999999e20,
        ] {
            let s = js_number_to_string(v);
            let back: f64 = s.parse().unwrap_or_else(|e| panic!("{s} does not reparse: {e}"));
            assert_eq!(back.to_bits(), v.to_bits(), "{v:e} -> {s} -> {back:e}");
        }
    }
}
