//! Turning captured activity into entries worth confirming
//! (`packages/core/src/activity/suggest.ts`).

use super::rules::{match_rule, rule_proposal};
use super::segments::{merge_segments, subtract_intervals, total_length, union_intervals};
use super::types::{
    ActivityInterval, ActivityKeyShare, ActivityRule, ActivitySegment, ActivitySuggestion,
    BuildSuggestionsOptions, MergeSegmentsOptions, OrderedMap,
};
use crate::js;

pub const DEFAULT_SUGGESTION_GAP_MINUTES: f64 = 10.0;
pub const DEFAULT_SUGGESTION_MIN_MINUTES: f64 = 5.0;
pub const DEFAULT_SUGGESTION_MAX_KEYS: f64 = 5.0;

const MINUTE_MS: f64 = 60_000.0;

#[derive(Debug, Clone)]
struct Piece {
    start: f64,
    end: f64,
    key: String,
}

/// `array.slice(0, n)`'s end index for a JavaScript number `n`.
fn slice_end(len: usize, n: f64) -> usize {
    if n.is_nan() {
        return 0;
    }
    let n = n.trunc();
    if n < 0.0 {
        (len as f64 + n).max(0.0) as usize
    } else {
        n.min(len as f64) as usize
    }
}

/// Untracked activity, as blocks a person can accept as entries.
///
/// 1. AFK segments are ignored; the rest are merged ([`merge_segments`]).
/// 2. Every tracked interval is cut out of them, so time already on an entry
///    is never suggested twice. Callers pass dismissed ranges here too — a
///    dismissal means "this time is accounted for", and treating it exactly
///    like an entry lets activity that arrives after the dismissal still
///    surface on its own.
/// 3. What remains is joined into blocks. A new block starts when the next
///    piece begins more than `gapMinutes` after the block's end, or when a
///    tracked interval lies between them — a block never spans tracked time,
///    or accepting it would create an overlapping entry.
/// 4. A block whose covered time (the union of its pieces, not its span) is
///    under `minMinutes` is dropped: two quick glances ten minutes apart are
///    not twelve minutes of work.
///
/// Keys are credited with the time of their own pieces, so overlapping
/// sources can credit more than the block's covered time; `share` is always
/// relative to the credited total.
///
/// Deterministic: the same inputs produce the same output, sorted by start.
pub fn build_suggestions(
    segments: &[ActivitySegment],
    tracked_intervals: &[ActivityInterval],
    rules: &[ActivityRule],
    options: BuildSuggestionsOptions,
) -> Vec<ActivitySuggestion> {
    let gap_ms = options
        .gap_minutes
        .unwrap_or(DEFAULT_SUGGESTION_GAP_MINUTES)
        * MINUTE_MS;
    let min_ms = options
        .min_minutes
        .unwrap_or(DEFAULT_SUGGESTION_MIN_MINUTES)
        * MINUTE_MS;
    let max_keys = options.max_keys.unwrap_or(DEFAULT_SUGGESTION_MAX_KEYS);

    let tracked = union_intervals(tracked_intervals);

    let present: Vec<ActivitySegment> = segments.iter().filter(|s| !s.afk).cloned().collect();
    let mut pieces: Vec<Piece> = Vec::new();
    for segment in merge_segments(&present, MergeSegmentsOptions::default()) {
        for piece in subtract_intervals(
            ActivityInterval {
                start: segment.start,
                end: segment.end,
            },
            &tracked,
        ) {
            pieces.push(Piece {
                start: piece.start,
                end: piece.end,
                key: segment.key.clone(),
            });
        }
    }
    pieces.sort_by(|a, b| {
        js::cmp_numbers(a.start, b.start)
            .then_with(|| js::cmp_numbers(a.end, b.end))
            .then_with(|| js::compare_keys(&a.key, &b.key))
    });

    let mut blocks: Vec<Vec<Piece>> = Vec::new();
    let mut current: Vec<Piece> = Vec::new();
    let mut current_end = f64::NEG_INFINITY;

    for piece in pieces {
        let separated = !current.is_empty()
            && (piece.start - current_end > gap_ms
                || tracked
                    .iter()
                    .any(|t| t.start >= current_end && t.end <= piece.start));
        if separated {
            blocks.push(std::mem::take(&mut current));
            current_end = f64::NEG_INFINITY;
        }
        current_end = current_end.max(piece.end);
        current.push(piece);
    }
    if !current.is_empty() {
        blocks.push(current);
    }

    let mut suggestions = Vec::new();
    for block in blocks {
        let spans: Vec<ActivityInterval> = block
            .iter()
            .map(|p| ActivityInterval {
                start: p.start,
                end: p.end,
            })
            .collect();
        let covered = total_length(&union_intervals(&spans));
        if covered < min_ms || block.is_empty() {
            continue;
        }

        let mut per_key: OrderedMap<f64> = OrderedMap::new();
        for piece in &block {
            *per_key.entry_or(&piece.key, || 0.0) += piece.end - piece.start;
        }
        let credited = per_key.iter().fold(0.0, |sum, (_, ms)| sum + ms);
        let mut ranked: Vec<(String, f64)> = per_key.iter().map(|(k, v)| (k.clone(), *v)).collect();
        ranked.sort_by(|a, b| js::cmp_numbers(b.1, a.1).then_with(|| js::compare_keys(&a.0, &b.0)));

        let top_keys: Vec<ActivityKeyShare> = ranked[..slice_end(ranked.len(), max_keys)]
            .iter()
            .map(|(key, ms)| ActivityKeyShare {
                key: key.clone(),
                seconds: js::round(ms / 1000.0),
                share: if credited > 0.0 { ms / credited } else { 0.0 },
            })
            .collect();

        let ranked_keys: Vec<&str> = ranked.iter().map(|(key, _)| key.as_str()).collect();
        let rule = match_rule(rules, &ranked_keys);

        let start = block[0].start;
        let end = block.iter().fold(start, |max, piece| max.max(piece.end));

        suggestions.push(ActivitySuggestion {
            start,
            end,
            top_keys,
            rule_id: rule.map(|r| r.id.clone()),
            proposed: rule.map(rule_proposal).unwrap_or_default(),
        });
    }

    suggestions
}

#[cfg(test)]
mod tests {
    use super::super::rules::tests::rule;
    use super::super::segments::tests::{seg, span, MIN, T0};
    use super::super::types::ActivitySource;
    use super::super::types::ProposedEntryFields;
    use super::*;

    fn build(
        segments: &[ActivitySegment],
        tracked: &[ActivityInterval],
        rules: &[ActivityRule],
    ) -> Vec<ActivitySuggestion> {
        build_suggestions(segments, tracked, rules, BuildSuggestionsOptions::default())
    }

    fn minutes(suggestions: &[ActivitySuggestion]) -> Vec<(f64, f64)> {
        suggestions
            .iter()
            .map(|s| ((s.start - T0) / MIN, (s.end - T0) / MIN))
            .collect()
    }

    #[test]
    fn thirty_minutes_of_tab_switching_becomes_one_suggestion() {
        let segments: Vec<ActivitySegment> = (0..10)
            .map(|i| {
                let minute = (i * 3) as f64;
                seg(
                    if i % 2 == 0 { "docs.test" } else { "code.test" },
                    minute,
                    minute + 3.0,
                )
            })
            .collect();
        let suggestions = build(&segments, &[], &[]);
        assert_eq!(suggestions.len(), 1);
        assert_eq!(suggestions[0].start, T0);
        assert_eq!(suggestions[0].end, T0 + 30.0 * MIN);
        let shares: f64 = suggestions[0].top_keys.iter().map(|k| k.share).sum();
        assert!((shares - 1.0).abs() < 1e-9);
        assert_eq!(suggestions[0].proposed, ProposedEntryFields::default());
    }

    #[test]
    fn already_tracked_time_is_subtracted_and_splits_the_block() {
        let suggestions = build(&[seg("docs.test", 0.0, 60.0)], &[span(20.0, 30.0)], &[]);
        assert_eq!(minutes(&suggestions), vec![(0.0, 20.0), (30.0, 60.0)]);
    }

    #[test]
    fn a_tracked_interval_splits_a_block_even_when_the_gap_is_under_the_threshold() {
        let suggestions = build(
            &[seg("docs.test", 0.0, 10.0), seg("docs.test", 12.0, 22.0)],
            &[span(10.0, 12.0)],
            &[],
        );
        assert_eq!(suggestions.len(), 2);
    }

    #[test]
    fn fully_tracked_activity_yields_nothing() {
        assert!(build(&[seg("docs.test", 0.0, 60.0)], &[span(-5.0, 65.0)], &[]).is_empty());
    }

    #[test]
    fn afk_segments_are_never_suggested() {
        let mut away = seg("docs.test", 0.0, 60.0);
        away.afk = true;
        assert!(build(&[away], &[], &[]).is_empty());
    }

    #[test]
    fn a_gap_over_gap_minutes_splits_blocks_under_it_joins_them() {
        let segments = [
            seg("a.test", 0.0, 10.0),
            seg("a.test", 20.0, 30.0),
            seg("a.test", 41.0, 50.0),
        ];
        // 10 → 20 is exactly the threshold and joins; 30 → 41 exceeds it.
        assert_eq!(
            minutes(&build(&segments, &[], &[])),
            vec![(0.0, 30.0), (41.0, 50.0)]
        );
        let narrow = BuildSuggestionsOptions {
            gap_minutes: Some(5.0),
            ..Default::default()
        };
        assert_eq!(build_suggestions(&segments, &[], &[], narrow).len(), 3);
    }

    #[test]
    fn blocks_with_less_covered_time_than_min_minutes_are_dropped() {
        let segments = [seg("a.test", 0.0, 2.0), seg("a.test", 10.0, 12.0)];
        assert!(build(&segments, &[], &[]).is_empty());
        let lower = BuildSuggestionsOptions {
            min_minutes: Some(4.0),
            ..Default::default()
        };
        assert_eq!(build_suggestions(&segments, &[], &[], lower).len(), 1);
        assert_eq!(build(&[seg("a.test", 0.0, 5.0)], &[], &[]).len(), 1);
    }

    #[test]
    fn top_keys_are_ranked_by_time_ties_by_key_and_capped() {
        let options = BuildSuggestionsOptions {
            max_keys: Some(3.0),
            ..Default::default()
        };
        let suggestions = build_suggestions(
            &[
                seg("b.test", 0.0, 10.0),
                seg("a.test", 10.0, 20.0),
                seg("c.test", 20.0, 40.0),
                seg("d.test", 40.0, 41.0),
            ],
            &[],
            &[],
            options,
        );
        let top: Vec<(String, f64)> = suggestions[0]
            .top_keys
            .iter()
            .map(|k| (k.key.clone(), k.seconds))
            .collect();
        assert_eq!(
            top,
            vec![
                ("c.test".into(), 1200.0),
                ("a.test".into(), 600.0),
                ("b.test".into(), 600.0)
            ]
        );
        assert!((suggestions[0].top_keys[0].share - 20.0 / 41.0).abs() < 1e-9);
    }

    #[test]
    fn the_first_matching_rule_for_the_dominant_key_fills_the_proposal() {
        let mut chat = rule("chat", "chat.test");
        chat.project_id = Some(Some("p-chat".into()));
        let mut code = rule("code", "*.code.test");
        code.project_id = Some(Some("p-code".into()));
        code.task_id = Some(Some("t1".into()));
        code.tag_ids = Some(vec!["g".into()]);
        code.billable = Some(true);
        code.description = Some("Dev".into());
        let mut late = rule("code-late", "code.test");
        late.project_id = Some(Some("p-other".into()));
        let suggestions = build(
            &[seg("chat.test", 0.0, 5.0), seg("code.test", 5.0, 30.0)],
            &[],
            &[chat, code, late],
        );
        assert_eq!(suggestions[0].rule_id.as_deref(), Some("code"));
        assert_eq!(
            suggestions[0].proposed,
            ProposedEntryFields {
                description: Some("Dev".into()),
                project_id: Some(Some("p-code".into())),
                task_id: Some(Some("t1".into())),
                tag_ids: Some(vec!["g".into()]),
                billable: Some(true),
            }
        );
    }

    #[test]
    fn the_output_is_deterministic_regardless_of_input_order() {
        let segments = vec![
            seg("a.test", 0.0, 10.0),
            seg("b.test", 10.0, 20.0),
            seg("a.test", 40.0, 55.0),
        ];
        let tracked = [span(15.0, 17.0)];
        let forward = build(&segments, &tracked, &[]);
        let mut reversed = segments.clone();
        reversed.reverse();
        assert_eq!(forward, build(&reversed, &tracked, &[]));
    }

    #[test]
    fn instants_across_a_dst_change_keep_their_real_length() {
        // Europe's 2026 spring-forward: 01:30+01:00 → 03:30+02:00 is one real hour.
        let start = 1_774_744_200_000.0; // Date.parse("2026-03-29T01:30:00+01:00")
        let end = 1_774_747_800_000.0; // Date.parse("2026-03-29T03:30:00+02:00")
        let segment = ActivitySegment {
            source: ActivitySource::Browser,
            start,
            end,
            key: "a.test".into(),
            label: None,
            afk: false,
        };
        let suggestions = build(&[segment], &[], &[]);
        assert_eq!(suggestions[0].end - suggestions[0].start, 60.0 * MIN);
        assert_eq!(suggestions[0].top_keys[0].seconds, 3600.0);

        let autumn_start = 1_792_886_400_000.0; // 2026-10-25T02:00:00+02:00
        let autumn_end = 1_792_893_600_000.0; // 2026-10-25T03:00:00+01:00
                                              // The second 02:30 and 02:40 of the night.
        let tracked = ActivityInterval {
            start: 1_792_891_800_000.0,
            end: 1_792_892_400_000.0,
        };
        let segment = ActivitySegment {
            source: ActivitySource::Browser,
            start: autumn_start,
            end: autumn_end,
            key: "a.test".into(),
            label: None,
            afk: false,
        };
        assert_eq!(autumn_end - autumn_start, 120.0 * MIN);
        let pieces = build(&[segment], &[tracked], &[]);
        assert_eq!(
            pieces
                .iter()
                .map(|p| (p.end - p.start) / MIN)
                .collect::<Vec<_>>(),
            vec![90.0, 20.0]
        );
    }
}
