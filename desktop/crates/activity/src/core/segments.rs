//! Segment and interval arithmetic (`packages/core/src/activity/segments.ts`).
//! Pure, and in epoch ms throughout.

use std::cmp::Ordering;
use std::collections::HashMap;

use super::types::{ActivityInterval, ActivitySegment, ActivitySource, MergeSegmentsOptions};
use crate::js;

pub const DEFAULT_PULSE_GAP_MS: f64 = 60_000.0;

fn by_segment_order(a: &ActivitySegment, b: &ActivitySegment) -> Ordering {
    js::cmp_numbers(a.start, b.start)
        .then_with(|| js::cmp_numbers(a.end, b.end))
        .then_with(|| js::compare_keys(&a.key, &b.key))
}

/// Join adjacent segments that describe the same thing.
///
/// Two segments merge when they share `source`, `key` and `afk` and the
/// second starts no more than `pulseGapMs` after the first ends (an overlap
/// counts as adjacent). Interleaving does not prevent a merge — A, B, A inside
/// a minute still joins the two A's — because a quick glance at another tab
/// should not split the stretch it interrupted. The merged segment keeps the
/// first label it saw, so a title that changed mid-stretch does not make the
/// label flicker.
///
/// Returns new segments sorted by start; the input is not touched. Empty and
/// inverted segments are dropped.
pub fn merge_segments(
    segments: &[ActivitySegment],
    options: MergeSegmentsOptions,
) -> Vec<ActivitySegment> {
    let gap = options.pulse_gap_ms.unwrap_or(DEFAULT_PULSE_GAP_MS);
    let mut sorted: Vec<ActivitySegment> = segments
        .iter()
        .filter(|s| s.end > s.start)
        .cloned()
        .collect();
    sorted.sort_by(by_segment_order);

    let mut merged: Vec<ActivitySegment> = Vec::new();
    let mut latest: HashMap<(ActivitySource, bool, String), usize> = HashMap::new();

    for segment in sorted {
        let identity = (segment.source, segment.afk, segment.key.clone());
        if let Some(&index) = latest.get(&identity) {
            let previous = &mut merged[index];
            if segment.start - previous.end <= gap {
                previous.end = previous.end.max(segment.end);
                if previous.label.is_none() && segment.label.is_some() {
                    previous.label = segment.label;
                }
                continue;
            }
        }
        merged.push(segment);
        latest.insert(identity, merged.len() - 1);
    }

    merged.sort_by(by_segment_order);
    merged
}

/// Union a set of intervals into sorted, non-overlapping ones. Touching
/// intervals (`a.end === b.start`) are joined.
pub fn union_intervals(intervals: &[ActivityInterval]) -> Vec<ActivityInterval> {
    let mut sorted: Vec<ActivityInterval> = intervals
        .iter()
        .filter(|i| i.end > i.start)
        .map(|i| ActivityInterval {
            start: i.start,
            end: i.end,
        })
        .collect();
    sorted.sort_by(|a, b| {
        js::cmp_numbers(a.start, b.start).then_with(|| js::cmp_numbers(a.end, b.end))
    });

    let mut out: Vec<ActivityInterval> = Vec::new();
    for interval in sorted {
        match out.last_mut() {
            Some(last) if interval.start <= last.end => last.end = last.end.max(interval.end),
            _ => out.push(interval),
        }
    }
    out
}

/// `interval` minus every span in `holes`, as the pieces that remain.
///
/// `holes` must already be a union (sorted, disjoint) — see [`union_intervals`].
pub fn subtract_intervals(
    interval: ActivityInterval,
    holes: &[ActivityInterval],
) -> Vec<ActivityInterval> {
    let mut pieces = Vec::new();
    let mut cursor = interval.start;

    for hole in holes {
        if hole.end <= cursor {
            continue;
        }
        if hole.start >= interval.end {
            break;
        }
        if hole.start > cursor {
            pieces.push(ActivityInterval {
                start: cursor,
                end: hole.start,
            });
        }
        cursor = cursor.max(hole.end);
        if cursor >= interval.end {
            break;
        }
    }

    if cursor < interval.end {
        pieces.push(ActivityInterval {
            start: cursor,
            end: interval.end,
        });
    }
    pieces
}

/// Total length of a union in ms.
pub fn total_length(union: &[ActivityInterval]) -> f64 {
    union
        .iter()
        .fold(0.0, |sum, interval| sum + (interval.end - interval.start))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub const MIN: f64 = 60_000.0;
    /// `Date.parse("2026-09-14T09:00:00.000Z")`.
    pub const T0: f64 = 1_789_376_400_000.0;

    pub fn seg(key: &str, start_min: f64, end_min: f64) -> ActivitySegment {
        ActivitySegment {
            source: ActivitySource::Browser,
            start: T0 + start_min * MIN,
            end: T0 + end_min * MIN,
            key: key.into(),
            label: None,
            afk: false,
        }
    }

    pub fn span(start_min: f64, end_min: f64) -> ActivityInterval {
        ActivityInterval {
            start: T0 + start_min * MIN,
            end: T0 + end_min * MIN,
        }
    }

    fn merge(segments: &[ActivitySegment]) -> Vec<ActivitySegment> {
        merge_segments(segments, MergeSegmentsOptions::default())
    }

    #[test]
    fn same_key_segments_inside_the_pulse_gap_merge_into_one() {
        let mut second = seg("a.test", 5.0, 10.0);
        second.start = T0 + 5.0 * MIN + 30_000.0;
        let merged = merge(&[seg("a.test", 0.0, 5.0), second]);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].start, T0);
        assert_eq!(merged[0].end, T0 + 10.0 * MIN);
    }

    #[test]
    fn a_gap_longer_than_the_pulse_keeps_segments_apart() {
        assert_eq!(
            merge(&[seg("a.test", 0.0, 5.0), seg("a.test", 7.0, 10.0)]).len(),
            2
        );
    }

    #[test]
    fn the_pulse_gap_is_configurable() {
        let merged = merge_segments(
            &[seg("a.test", 0.0, 5.0), seg("a.test", 7.0, 10.0)],
            MergeSegmentsOptions {
                pulse_gap_ms: Some(3.0 * MIN),
            },
        );
        assert_eq!(merged.len(), 1);
    }

    #[test]
    fn different_keys_sources_or_afk_flags_never_merge() {
        let mut desktop = seg("a.test", 10.0, 15.0);
        desktop.source = ActivitySource::Desktop;
        let mut afk = seg("a.test", 15.0, 20.0);
        afk.afk = true;
        assert_eq!(
            merge(&[
                seg("a.test", 0.0, 5.0),
                seg("b.test", 5.0, 10.0),
                desktop,
                afk
            ])
            .len(),
            4
        );
    }

    #[test]
    fn an_interleaved_glance_does_not_split_the_stretch_it_interrupted() {
        let mut glance = seg("b.test", 5.0, 5.0);
        glance.end = T0 + 5.0 * MIN + 20_000.0;
        let mut rest = seg("a.test", 5.0, 9.0);
        rest.start = T0 + 5.0 * MIN + 20_000.0;
        let merged = merge(&[seg("a.test", 0.0, 5.0), glance, rest]);
        let shape: Vec<(String, f64, f64)> = merged
            .iter()
            .map(|s| {
                (
                    s.key.clone(),
                    (s.start - T0) / 1000.0,
                    (s.end - T0) / 1000.0,
                )
            })
            .collect();
        assert_eq!(
            shape,
            vec![
                ("a.test".into(), 0.0, 540.0),
                ("b.test".into(), 300.0, 320.0)
            ]
        );
    }

    #[test]
    fn merging_keeps_the_first_label_and_drops_empty_segments() {
        let mut first = seg("a.test", 0.0, 5.0);
        first.label = Some("First".into());
        let mut second = seg("a.test", 5.0, 10.0);
        second.label = Some("Second".into());
        let merged = merge(&[first, second, seg("a.test", 20.0, 20.0)]);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].label.as_deref(), Some("First"));
    }

    #[test]
    fn merging_does_not_mutate_its_input() {
        let input = vec![seg("a.test", 0.0, 5.0), seg("a.test", 5.0, 10.0)];
        let copy = input.clone();
        merge(&input);
        assert_eq!(input, copy);
    }

    #[test]
    fn union_joins_overlapping_and_touching_intervals() {
        assert_eq!(
            union_intervals(&[span(10.0, 20.0), span(0.0, 5.0), span(5.0, 12.0)]),
            vec![span(0.0, 20.0)]
        );
    }

    #[test]
    fn subtract_leaves_the_pieces_outside_the_holes() {
        assert_eq!(
            subtract_intervals(span(0.0, 60.0), &[span(10.0, 20.0), span(50.0, 70.0)]),
            vec![span(0.0, 10.0), span(20.0, 50.0)]
        );
        assert_eq!(
            subtract_intervals(span(0.0, 60.0), &[span(-10.0, 70.0)]),
            vec![]
        );
    }
}
