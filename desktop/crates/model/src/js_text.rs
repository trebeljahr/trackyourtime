//! The few JavaScript string, number and date semantics the ported modules
//! depend on, so a payload is cut, trimmed and parsed exactly where the
//! TypeScript cut, trimmed and parsed it.
//!
//! Mounted as `crate::timer_menu::js` (lib.rs is not this module's file to
//! edit); every other ported module reaches it from there.

/// `String.prototype.trim`'s set: WhiteSpace and LineTerminator. Not Rust's
/// `char::is_whitespace`, which adds U+0085 and drops U+FEFF.
pub(crate) fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{A}' | '\u{B}' | '\u{C}' | '\u{D}' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

pub(crate) fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_whitespace)
}

pub(crate) fn js_trim_end(s: &str) -> &str {
    s.trim_end_matches(is_js_whitespace)
}

pub(crate) fn js_trim_start(s: &str) -> &str {
    s.trim_start_matches(is_js_whitespace)
}

/// `s.length`: UTF-16 code units.
pub(crate) fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `s.slice(0, max)`, counted in UTF-16 code units. A surrogate pair that
/// straddles the cut is dropped whole (JavaScript would keep a lone high
/// surrogate, which a Rust `String` cannot hold).
pub(crate) fn slice_utf16(s: &str, max: usize) -> String {
    let mut units = 0;
    let mut end = 0;
    for (index, c) in s.char_indices() {
        let width = c.len_utf16();
        if units + width > max {
            return s[..end].to_string();
        }
        units += width;
        end = index + c.len_utf8();
    }
    s.to_string()
}

/// `Math.round`: halves go towards +∞ (`Math.round(-2.5) === -2`), unlike
/// `f64::round`.
pub(crate) fn js_round(x: f64) -> f64 {
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

/// `Number.isSafeInteger` for a JSON number.
pub(crate) fn safe_integer(value: &serde_json::Value) -> Option<i64> {
    const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
    let number = value.as_f64()?;
    if !number.is_finite() || number.fract() != 0.0 || number.abs() > MAX_SAFE {
        return None;
    }
    Some(number as i64)
}

/// A finite JSON number, as `typeof v === "number" && Number.isFinite(v)`.
pub(crate) fn finite_number(value: &serde_json::Value) -> Option<f64> {
    value.as_f64().filter(|n| n.is_finite())
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's
/// `days_from_civil`). Day and month may run over: day 31 of February is
/// 3 March, as `Date.UTC` reads it.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let (y, m) = if month <= 2 {
        (year - 1, month + 9)
    } else {
        (year, month - 3)
    };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * m + 2) / 5;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468 + (day - 1)
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// `new Date(ms).toISOString()`: `2026-09-17T10:00:00.000Z`.
pub(crate) fn iso_from_ms(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let in_day = ms.rem_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    let hours = in_day / 3_600_000;
    let minutes = (in_day / 60_000) % 60;
    let seconds = (in_day / 1000) % 60;
    let millis = in_day % 1000;
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else if year < 0 {
        format!("-{:06}", -year)
    } else {
        format!("+{year:06}")
    };
    format!("{year}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{seconds:02}.{millis:03}Z")
}

struct Cursor<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Cursor<'_> {
    fn digits(&mut self, exactly: usize) -> Option<i64> {
        let end = self.at.checked_add(exactly)?;
        let slice = self.bytes.get(self.at..end)?;
        if !slice.iter().all(u8::is_ascii_digit) {
            return None;
        }
        self.at = end;
        Some(
            slice
                .iter()
                .fold(0, |acc, d| acc * 10 + i64::from(d - b'0')),
        )
    }

    fn eat(&mut self, byte: u8) -> bool {
        if self.bytes.get(self.at) == Some(&byte) {
            self.at += 1;
            true
        } else {
            false
        }
    }

    fn done(&self) -> bool {
        self.at == self.bytes.len()
    }
}

/// `Date.parse` for the ECMAScript date-time string format, which is what
/// the renderer sends (`toISOString()` and the server's ISO strings):
/// `YYYY[-MM[-DD]][THH:mm[:ss[.sss]][Z|±HH:mm]]`, with `±YYYYYY` years.
///
/// Two departures, both on input the renderer never produces: V8's legacy
/// fallback formats ("Sep 17 2026") are refused, and a date-time without an
/// offset is read as UTC rather than local time (no time zone database here).
pub(crate) fn parse_iso_ms(input: &str) -> Option<f64> {
    let mut c = Cursor {
        bytes: input.as_bytes(),
        at: 0,
    };
    let year = if c.eat(b'+') {
        c.digits(6)?
    } else if c.eat(b'-') {
        let y = c.digits(6)?;
        if y == 0 {
            return None; // -000000 is refused by the spec
        }
        -y
    } else {
        c.digits(4)?
    };
    let mut month = 1;
    let mut day = 1;
    if c.eat(b'-') {
        month = c.digits(2)?;
        if c.eat(b'-') {
            day = c.digits(2)?;
        }
    }
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let (mut hours, mut minutes, mut seconds, mut millis, mut offset_min) = (0, 0, 0, 0.0, 0);
    if c.eat(b'T') || c.eat(b't') {
        hours = c.digits(2)?;
        if !c.eat(b':') {
            return None;
        }
        minutes = c.digits(2)?;
        if c.eat(b':') {
            seconds = c.digits(2)?;
            if c.eat(b'.') || c.eat(b',') {
                let start = c.at;
                while c.bytes.get(c.at).is_some_and(u8::is_ascii_digit) {
                    c.at += 1;
                }
                let fraction = &input[start..c.at];
                if fraction.is_empty() {
                    return None;
                }
                let first3: String = fraction.chars().chain("000".chars()).take(3).collect();
                millis = first3.parse::<f64>().ok()?;
            }
        }
        if c.eat(b'Z') || c.eat(b'z') {
        } else if c.bytes.get(c.at) == Some(&b'+') || c.bytes.get(c.at) == Some(&b'-') {
            let sign = if c.eat(b'+') {
                1
            } else {
                c.eat(b'-');
                -1
            };
            let oh = c.digits(2)?;
            if !c.eat(b':') {
                return None;
            }
            let om = c.digits(2)?;
            if oh > 23 || om > 59 {
                return None;
            }
            offset_min = sign * (oh * 60 + om);
        }
        let end_of_day = hours == 24 && minutes == 0 && seconds == 0 && millis == 0.0;
        if (hours > 23 && !end_of_day) || minutes > 59 || seconds > 59 {
            return None;
        }
    }
    if !c.done() {
        return None;
    }
    let days = days_from_civil(year, month, day);
    let ms = days as f64 * 86_400_000.0
        + (hours * 3_600_000 + minutes * 60_000 + seconds * 1000) as f64
        + millis
        - (offset_min * 60_000) as f64;
    // The spec's time value range: ±8.64e15 ms.
    if ms.abs() > 8.64e15 {
        return None;
    }
    Some(ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_like_javascript() {
        assert_eq!(js_trim("\u{FEFF} a b \u{3000}"), "a b");
        assert_eq!(
            js_trim("\u{85}x"),
            "\u{85}x",
            "NEL is not JavaScript whitespace"
        );
    }

    #[test]
    fn slices_by_utf16_units() {
        assert_eq!(slice_utf16("abcdef", 3), "abc");
        assert_eq!(slice_utf16("a😀b", 3), "a😀");
        assert_eq!(slice_utf16("a😀b", 2), "a");
        assert_eq!(slice_utf16("ab", 10), "ab");
    }

    #[test]
    fn rounds_halves_up() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(0.49999999999999994), 0.0);
        assert_eq!(js_round(41.6), 42.0);
    }

    #[test]
    fn parses_and_prints_iso_dates() {
        let ms = parse_iso_ms("2026-09-17T10:00:00.000Z").unwrap();
        assert_eq!(ms, 1_789_639_200_000.0);
        assert_eq!(iso_from_ms(ms as i64), "2026-09-17T10:00:00.000Z");
        assert_eq!(parse_iso_ms("2026-09-17T12:00:00+02:00"), Some(ms));
        assert_eq!(parse_iso_ms("2026-09-17"), Some(1_789_603_200_000.0));
        assert_eq!(parse_iso_ms("2026-09-17T10:00:00.5Z"), Some(ms + 500.0));
        assert_eq!(parse_iso_ms("yesterday"), None);
        assert_eq!(parse_iso_ms(""), None);
        assert_eq!(parse_iso_ms("2026-13-01"), None);
        assert_eq!(parse_iso_ms("2026-09-17T25:00Z"), None);
        assert_eq!(iso_from_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_from_ms(-1), "1969-12-31T23:59:59.999Z");
    }
}
