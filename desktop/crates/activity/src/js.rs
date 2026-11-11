//! The handful of JavaScript semantics the TypeScript this crate ports relies
//! on, spelled out so a Rust result is the same result.
//!
//! The browser extension keeps running `packages/core/src/activity` in
//! JavaScript, and an existing Electron install keeps the files it wrote, so
//! "close enough" is not: a whitespace set that differs by one character, a
//! sort that orders strings by UTF-8 instead of UTF-16, or `1700000000000.0`
//! in a file where JavaScript wrote `1700000000000` would each be a quiet
//! divergence. Everything here is unit-tested against what V8 does.

use serde::Serializer;
use std::cmp::Ordering;

/// ECMAScript `WhiteSpace` plus `LineTerminator`: what `String.prototype.trim`
/// strips and what `/\s/` matches. Not Rust's `char::is_whitespace`, which
/// includes U+0085 and excludes U+FEFF.
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'..='\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

/// The characters `.` refuses in a regular expression without the `s` flag.
pub fn is_js_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `String.prototype.trim`.
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// `text.replace(/\s+/g, " ")`.
pub fn collapse_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_run = false;
    for c in text.chars() {
        if is_js_whitespace(c) {
            if !in_run {
                out.push(' ');
                in_run = true;
            }
        } else {
            out.push(c);
            in_run = false;
        }
    }
    out
}

/// `String.prototype.toLowerCase`. Rust's mapping is Unicode's full lowercase
/// mapping with the final-sigma rule, which is what V8 implements.
pub fn lower(text: &str) -> String {
    text.to_lowercase()
}

/// `string.length`: UTF-16 code units.
pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.slice(0, n)` for `n >= 0`, in UTF-16 code units. A surrogate pair
/// that would be cut in half is left out whole: JavaScript would keep a lone
/// high surrogate, which a Rust string cannot hold (PORTING.md).
pub fn slice_utf16(text: &str, n: usize) -> &str {
    let mut units = 0usize;
    for (index, c) in text.char_indices() {
        let width = c.len_utf16();
        if units + width > n {
            return &text[..index];
        }
        units += width;
    }
    text
}

/// `a < b` on JavaScript strings: UTF-16 code unit order, which differs from
/// Rust's (code point) order for characters above U+FFFF.
pub fn cmp_strings(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// The comparator core uses: `(a, b) => (a < b ? -1 : a > b ? 1 : 0)`.
pub fn compare_keys(a: &str, b: &str) -> Ordering {
    cmp_strings(a, b)
}

/// `Math.round`: ties go toward +∞ (`Math.round(-2.5) === -2`), unlike
/// `f64::round`, which goes away from zero.
pub fn round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let floor = x.floor();
    if x - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

/// A numeric comparator result read the way `Array.prototype.sort` reads it:
/// negative, positive, or zero (and NaN, which JavaScript treats as zero).
pub fn sign(value: f64) -> Ordering {
    if value < 0.0 {
        Ordering::Less
    } else if value > 0.0 {
        Ordering::Greater
    } else {
        Ordering::Equal
    }
}

/// `a - b` as a sort comparator.
pub fn cmp_numbers(a: f64, b: f64) -> Ordering {
    sign(a - b)
}

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// Serializes an `f64` the way `JSON.stringify` writes a number: integers
/// without a fraction (`1700000000000`, never `1700000000000.0`), `-0` as `0`,
/// and NaN or ±∞ as `null`. Used on every number this crate writes to disk.
pub fn serialize_number<S: Serializer>(value: &f64, serializer: S) -> Result<S::Ok, S::Error> {
    let value = *value;
    if !value.is_finite() {
        return serializer.serialize_none();
    }
    if value.fract() == 0.0 && value.abs() <= MAX_SAFE_INTEGER {
        return serializer.serialize_i64(value as i64);
    }
    serializer.serialize_f64(value)
}

/// [`serialize_number`] for an optional number.
pub fn serialize_optional_number<S: Serializer>(
    value: &Option<f64>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    match value {
        Some(number) => serialize_number(number, serializer),
        None => serializer.serialize_none(),
    }
}

/// Rewrites every number in a JSON value the way [`serialize_number`] would,
/// so a value handed to the bridge reads like one JavaScript produced.
pub fn normalize_numbers(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Number(number) => {
            if number.is_f64() {
                if let Some(float) = number.as_f64() {
                    if float.fract() == 0.0 && float.abs() <= MAX_SAFE_INTEGER {
                        *value = serde_json::Value::from(float as i64);
                    }
                }
            }
        }
        serde_json::Value::Array(items) => items.iter_mut().for_each(normalize_numbers),
        serde_json::Value::Object(map) => map.values_mut().for_each(normalize_numbers),
        _ => {}
    }
}

/// A JSON value as a finite `f64`, like `typeof v === "number" && Number.isFinite(v)`.
pub fn finite(value: Option<&serde_json::Value>) -> Option<f64> {
    value
        .and_then(serde_json::Value::as_f64)
        .filter(|number| number.is_finite())
}

// ── dates ─────────────────────────────────────────────────────────────

const DAY_MS: f64 = 86_400_000.0;
/// ±8.64e15 ms: the range of a JavaScript `Date`.
const MAX_TIME: f64 = 8.64e15;

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's
/// `days_from_civil`).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The civil date of a day count (`civil_from_days`).
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `new Date(epochMs).toISOString().slice(0, 10)`, or `None` where JavaScript
/// throws (an invalid date).
pub fn iso_date(epoch_ms: f64) -> Option<String> {
    if !epoch_ms.is_finite() || epoch_ms.abs() > MAX_TIME {
        return None;
    }
    // TimeClip truncates toward zero; the day then floors.
    let ms = epoch_ms.trunc();
    let days = (ms / DAY_MS).floor() as i64;
    let (year, month, day) = civil_from_days(days);
    let iso = if (0..=9999).contains(&year) {
        format!("{year:04}-{month:02}-{day:02}")
    } else {
        let sign = if year < 0 { '-' } else { '+' };
        format!("{sign}{:06}-{month:02}-{day:02}", year.abs())
    };
    Some(iso.chars().take(10).collect())
}

/// `Date.UTC(year, monthIndex, day)` for whole numbers, including its quirks:
/// a year 0–99 means 1900–1999, and an out-of-range month carries into the year.
pub fn date_utc(year: f64, month_index: f64, day: f64) -> f64 {
    let mut year = year.trunc();
    if (0.0..=99.0).contains(&year) {
        year += 1900.0;
    }
    let month_index = month_index.trunc();
    let ym = year + (month_index / 12.0).floor();
    let mn = month_index.rem_euclid(12.0);
    let days = days_from_civil(ym as i64, mn as i64 + 1, 1) as f64 + day.trunc() - 1.0;
    days * DAY_MS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whitespace_is_ecmascript_s() {
        assert_eq!(trim("\u{FEFF} a \u{3000}"), "a");
        assert_eq!(trim("\u{0085}a"), "\u{0085}a");
        assert_eq!(collapse_whitespace("a \t\n b\u{00A0}\u{00A0}c"), "a b c");
    }

    #[test]
    fn strings_compare_by_utf16_code_units() {
        // U+FF5E (one unit 0xFF5E) sorts after U+1F600 (units 0xD83D 0xDE00) in JavaScript.
        assert_eq!(cmp_strings("\u{1F600}", "\u{FF5E}"), Ordering::Less);
        assert_eq!("\u{1F600}".cmp("\u{FF5E}"), Ordering::Greater);
        assert_eq!(utf16_len("a\u{1F600}"), 3);
        assert_eq!(slice_utf16("ab\u{1F600}c", 3), "ab");
        assert_eq!(slice_utf16("ab\u{1F600}c", 4), "ab\u{1F600}");
    }

    #[test]
    fn math_round_ties_go_up() {
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(-2.5), -2.0);
        assert_eq!(round(0.49999999999999994), 0.0);
        assert_eq!(round(1499.6), 1500.0);
    }

    #[test]
    fn numbers_serialize_like_json_stringify() {
        #[derive(serde::Serialize)]
        struct N {
            #[serde(serialize_with = "serialize_number")]
            a: f64,
            #[serde(serialize_with = "serialize_number")]
            b: f64,
            #[serde(serialize_with = "serialize_number")]
            c: f64,
            #[serde(serialize_with = "serialize_number")]
            d: f64,
        }
        let text = serde_json::to_string(&N {
            a: 1_700_000_000_000.0,
            b: 0.5,
            c: -0.0,
            d: f64::NAN,
        })
        .unwrap();
        assert_eq!(text, r#"{"a":1700000000000,"b":0.5,"c":0,"d":null}"#);
    }

    #[test]
    fn iso_dates_match_to_iso_string() {
        assert_eq!(iso_date(0.0).as_deref(), Some("1970-01-01"));
        assert_eq!(iso_date(-1.0).as_deref(), Some("1969-12-31"));
        assert_eq!(iso_date(1_790_119_800_000.0).as_deref(), Some("2026-09-22"));
        assert_eq!(iso_date(f64::NAN), None);
        assert_eq!(iso_date(8.64e15).as_deref(), Some("+275760-09"));
    }

    #[test]
    fn date_utc_matches_javascript() {
        assert_eq!(date_utc(2026.0, 8.0, 22.0), 1_790_035_200_000.0);
        assert_eq!(date_utc(2026.0, 12.0, 1.0), date_utc(2027.0, 0.0, 1.0));
        assert_eq!(date_utc(26.0, 0.0, 1.0), date_utc(1926.0, 0.0, 1.0));
    }
}
