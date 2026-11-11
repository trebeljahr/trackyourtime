//! Suggestions, composed in the shell (`electron/src/activity/suggest.ts`).
//!
//! The renderer sends the tracked intervals in (fetching entries is network
//! work, and nothing in this crate does any) and gets suggestions back, with
//! display names and at most three titles each. Raw segments never cross the
//! bridge: the page sees only what it is about to offer.
//!
//! The arithmetic is core's `build_suggestions`, shared with the browser
//! extension. What is added here: the live open segment, the in-memory "just
//! accepted" spans (an accepted entry takes a moment to show up in the
//! tracked intervals), names, titles, and the accept check.

use std::collections::HashMap;

use tyt_wire::{
    DesktopActivityAcceptCheck, DesktopActivityAcceptRefusal, DesktopActivityApp,
    DesktopActivitySuggestion, DesktopActivityTopApp, False, True,
};

use crate::core::{
    build_suggestions, ActivityInterval, ActivityRule, ActivitySegment, ActivitySource,
    BuildSuggestionsOptions,
};
use crate::js;
use crate::model::{OpenSegment, StoredSegment, STALE_AFTER_MS};

/// How long an accepted span counts as tracked without being in the tracked list.
pub const ACCEPTED_HOLD_MS: f64 = 5.0 * 60_000.0;
/// How far around an accepted span its check looks.
pub const ACCEPT_CONTEXT_MS: f64 = 12.0 * 60.0 * 60_000.0;
pub const MAX_RECENT_APPS: usize = 30;
pub const MAX_TITLES: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AcceptedSpan {
    pub start: f64,
    pub end: f64,
    pub at: f64,
}

/// The scope's stored segments plus the open one, which counts up to now (or
/// `lastSeen`, if stale).
pub fn with_open_segment(
    stored: Vec<StoredSegment>,
    open: Option<&OpenSegment>,
    scope: &str,
    now: f64,
) -> Vec<StoredSegment> {
    let mut out = stored;
    let Some(open) = open.filter(|open| open.scope == scope) else {
        return out;
    };
    let end = if now - open.last_seen > STALE_AFTER_MS {
        open.last_seen
    } else {
        open.last_seen.max(now)
    };
    if end <= open.start {
        return out;
    }
    out.push(StoredSegment {
        scope: scope.to_string(),
        source: ActivitySource::Desktop,
        start: open.start,
        end,
        key: open.key.clone(),
        name: open.name.clone(),
        label: open.label.clone(),
        afk: false,
    });
    out
}

/// The newest name each key was seen under.
pub fn names_of(segments: &[StoredSegment]) -> HashMap<String, String> {
    let mut names: HashMap<String, (String, f64)> = HashMap::new();
    for segment in segments {
        match names.get(&segment.key) {
            Some((_, at)) if !(segment.end >= *at) => {}
            _ => {
                names.insert(segment.key.clone(), (segment.name.clone(), segment.end));
            }
        }
    }
    names
        .into_iter()
        .map(|(key, (name, _))| (key, name))
        .collect()
}

/// Newest first, one per key.
pub fn recent_apps(segments: &[StoredSegment]) -> Vec<DesktopActivityApp> {
    let mut sorted: Vec<&StoredSegment> = segments.iter().collect();
    sorted.sort_by(|a, b| js::cmp_numbers(b.end, a.end));
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for segment in sorted {
        if !seen.insert(segment.key.as_str()) {
            continue;
        }
        out.push(DesktopActivityApp {
            key: segment.key.clone(),
            name: segment.name.clone(),
        });
        if out.len() >= MAX_RECENT_APPS {
            break;
        }
    }
    out
}

/// Accepted spans still inside their hold.
pub fn live_accepted(accepted: &[AcceptedSpan], now: f64) -> Vec<AcceptedSpan> {
    accepted
        .iter()
        .filter(|span| now - span.at < ACCEPTED_HOLD_MS)
        .copied()
        .collect()
}

fn clip(segment: &StoredSegment, from: f64, to: f64) -> Option<StoredSegment> {
    let start = segment.start.max(from);
    let end = segment.end.min(to);
    (end > start).then(|| StoredSegment {
        start,
        end,
        ..segment.clone()
    })
}

/// Titles of the dominant app inside a block, most time first.
fn titles_for(segments: &[StoredSegment], key: &str, start: f64, end: f64) -> Vec<String> {
    let mut per_title: Vec<(String, f64)> = Vec::new();
    for segment in segments {
        let Some(label) = segment.label.as_ref().filter(|_| segment.key == key) else {
            continue;
        };
        let overlap = segment.end.min(end) - segment.start.max(start);
        if overlap <= 0.0 {
            continue;
        }
        match per_title.iter_mut().find(|(title, _)| title == label) {
            Some((_, ms)) => *ms += overlap,
            None => per_title.push((label.clone(), overlap)),
        }
    }
    per_title.sort_by(|a, b| js::cmp_numbers(b.1, a.1).then_with(|| js::cmp_strings(&a.0, &b.0)));
    per_title
        .into_iter()
        .take(MAX_TITLES)
        .map(|(title, _)| title)
        .collect()
}

pub struct ComposeInput<'a> {
    /// The scope's segments overlapping the range, open segment included.
    pub segments: &'a [StoredSegment],
    /// Names across everything stored for the scope.
    pub names: &'a HashMap<String, String>,
    pub from: f64,
    pub to: f64,
    /// Tracked entries, dismissals and just-accepted spans alike: time that is accounted for.
    pub holes: &'a [ActivityInterval],
    pub rules: &'a [ActivityRule],
}

pub fn compose_suggestions(input: ComposeInput<'_>) -> Vec<DesktopActivitySuggestion> {
    let clipped: Vec<StoredSegment> = input
        .segments
        .iter()
        .filter_map(|s| clip(s, input.from, input.to))
        .collect();
    let core: Vec<ActivitySegment> = clipped.iter().map(StoredSegment::as_core).collect();
    build_suggestions(
        &core,
        input.holes,
        input.rules,
        BuildSuggestionsOptions::default(),
    )
    .into_iter()
    .map(|suggestion| {
        let titles = match suggestion.top_keys.first() {
            Some(dominant) => titles_for(&clipped, &dominant.key, suggestion.start, suggestion.end),
            None => Vec::new(),
        };
        DesktopActivitySuggestion {
            start: suggestion.start,
            end: suggestion.end,
            top_apps: suggestion
                .top_keys
                .iter()
                .map(|share| DesktopActivityTopApp {
                    key: share.key.clone(),
                    name: input
                        .names
                        .get(&share.key)
                        .cloned()
                        .unwrap_or_else(|| share.key.clone()),
                    seconds: share.seconds,
                    share: share.share,
                })
                .collect(),
            titles,
            rule_id: suggestion.rule_id,
            proposed: suggestion.proposed,
        }
    })
    .collect()
}

/// The range an accept check rebuilds suggestions over.
pub fn accept_range(start: f64, end: f64, now: f64) -> (f64, f64) {
    (start - ACCEPT_CONTEXT_MS, now.min(end + ACCEPT_CONTEXT_MS))
}

pub fn refused(reason: DesktopActivityAcceptRefusal) -> DesktopActivityAcceptCheck {
    DesktopActivityAcceptCheck::Refused { ok: False, reason }
}

/// Whether a suggestion may still become an entry, from suggestions rebuilt
/// against the entries as they are now (the page's copy can be seconds old):
///
/// - nothing untracked overlaps the request any more → `already-tracked`;
/// - a plain accept → clipped to the untracked block it overlaps most;
/// - an edited accept → the person's own times, chosen on purpose.
pub fn check_accept(
    start: f64,
    end: f64,
    edited: bool,
    rebuilt: &[DesktopActivitySuggestion],
) -> DesktopActivityAcceptCheck {
    if !(end > start) {
        return refused(DesktopActivityAcceptRefusal::BadRange);
    }
    let overlap = |block: &DesktopActivitySuggestion| block.end.min(end) - block.start.max(start);
    let mut best: Option<&DesktopActivitySuggestion> = None;
    for block in rebuilt.iter().filter(|block| overlap(block) > 0.0) {
        if best.is_none_or(|current| overlap(block) > overlap(current)) {
            best = Some(block);
        }
    }
    let Some(best) = best else {
        return refused(DesktopActivityAcceptRefusal::AlreadyTracked);
    };
    if edited {
        return DesktopActivityAcceptCheck::Ok {
            ok: True,
            start,
            end,
        };
    }
    DesktopActivityAcceptCheck::Ok {
        ok: True,
        start: start.max(best.start),
        end: end.min(best.end),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: f64 = 60_000.0;
    /// `Date.UTC(2026, 8, 22, 9, 0, 0)`.
    const T0: f64 = 1_790_067_600_000.0;

    fn seg(key: &str, start: f64, end: f64) -> StoredSegment {
        StoredSegment {
            scope: "u1:w1".into(),
            source: ActivitySource::Desktop,
            start,
            end,
            key: key.into(),
            name: key.to_uppercase(),
            label: None,
            afk: false,
        }
    }

    fn labelled(key: &str, start: f64, end: f64, label: &str) -> StoredSegment {
        StoredSegment {
            label: Some(label.into()),
            ..seg(key, start, end)
        }
    }

    fn compose(
        segments: &[StoredSegment],
        holes: &[ActivityInterval],
    ) -> Vec<DesktopActivitySuggestion> {
        let rules = vec![ActivityRule {
            id: "r1".into(),
            pattern: "com.example.*".into(),
            description: Some("Editing".into()),
            project_id: None,
            task_id: None,
            tag_ids: None,
            billable: None,
        }];
        compose_suggestions(ComposeInput {
            segments,
            names: &names_of(segments),
            from: T0 - 60.0 * MIN,
            to: T0 + 240.0 * MIN,
            holes,
            rules: &rules,
        })
    }

    #[test]
    fn counts_the_open_segment_up_to_now_or_to_last_seen_when_stale_for_its_scope_only() {
        let open = OpenSegment {
            scope: "u1:w1".into(),
            key: "a".into(),
            name: "A".into(),
            label: None,
            start: T0,
            last_seen: T0 + MIN,
        };
        assert_eq!(
            with_open_segment(vec![], Some(&open), "u1:w1", T0 + 2.0 * MIN)[0].end,
            T0 + 2.0 * MIN
        );
        assert_eq!(
            with_open_segment(vec![], Some(&open), "u1:w1", T0 + 30.0 * MIN)[0].end,
            T0 + MIN
        );
        assert!(with_open_segment(vec![], Some(&open), "u2:w1", T0 + 2.0 * MIN).is_empty());
    }

    #[test]
    fn names_apps_applies_rules_and_clips_to_the_range() {
        let suggestions = compose(
            &[
                seg("com.example.editor", T0, T0 + 25.0 * MIN),
                seg("chat", T0 + 25.0 * MIN, T0 + 27.0 * MIN),
            ],
            &[],
        );
        assert_eq!(suggestions.len(), 1);
        let suggestion = &suggestions[0];
        assert_eq!(suggestion.start, T0);
        assert_eq!(suggestion.end, T0 + 27.0 * MIN);
        assert_eq!(
            suggestion
                .top_apps
                .iter()
                .map(|a| (a.name.clone(), a.seconds))
                .collect::<Vec<_>>(),
            [
                ("COM.EXAMPLE.EDITOR".to_string(), 1500.0),
                ("CHAT".to_string(), 120.0)
            ]
        );
        assert_eq!(suggestion.rule_id.as_deref(), Some("r1"));
        assert_eq!(suggestion.proposed.description.as_deref(), Some("Editing"));
        assert!(suggestion.titles.is_empty());
    }

    #[test]
    fn subtracts_tracked_time_dismissals_and_accepted_spans_alike() {
        let holes = [
            ActivityInterval {
                start: T0,
                end: T0 + 20.0 * MIN,
            },
            ActivityInterval {
                start: T0 + 40.0 * MIN,
                end: T0 + 60.0 * MIN,
            },
        ];
        let suggestions = compose(&[seg("a", T0, T0 + 60.0 * MIN)], &holes);
        assert_eq!(
            suggestions
                .iter()
                .map(|s| (s.start, s.end))
                .collect::<Vec<_>>(),
            [(T0 + 20.0 * MIN, T0 + 40.0 * MIN)]
        );
    }

    #[test]
    fn offers_up_to_three_titles_of_the_dominant_app_most_time_first() {
        let suggestions = compose(
            &[
                labelled("a", T0, T0 + 10.0 * MIN, "one"),
                labelled("a", T0 + 10.0 * MIN, T0 + 30.0 * MIN, "two"),
                labelled("a", T0 + 30.0 * MIN, T0 + 31.0 * MIN, "three"),
                labelled("a", T0 + 31.0 * MIN, T0 + 33.0 * MIN, "four"),
                labelled("b", T0 + 33.0 * MIN, T0 + 34.0 * MIN, "other app"),
            ],
            &[],
        );
        assert_eq!(suggestions[0].titles, ["two", "one", "four"]);
    }

    #[test]
    fn lists_apps_newest_first_once_each_under_their_newest_name() {
        let segments = [
            StoredSegment {
                name: "Old A".into(),
                ..seg("a", T0, T0 + MIN)
            },
            seg("b", T0 + MIN, T0 + 2.0 * MIN),
            StoredSegment {
                name: "New A".into(),
                ..seg("a", T0 + 2.0 * MIN, T0 + 3.0 * MIN)
            },
        ];
        assert_eq!(
            recent_apps(&segments),
            [
                DesktopActivityApp {
                    key: "a".into(),
                    name: "New A".into()
                },
                DesktopActivityApp {
                    key: "b".into(),
                    name: "B".into()
                }
            ]
        );
        assert_eq!(names_of(&segments)["a"], "New A");
    }

    fn rebuilt() -> Vec<DesktopActivitySuggestion> {
        compose(
            &[
                seg("a", T0, T0 + 30.0 * MIN),
                seg("b", T0 + 90.0 * MIN, T0 + 100.0 * MIN),
            ],
            &[],
        )
    }

    #[test]
    fn clips_a_plain_accept_to_the_block_it_overlaps_most() {
        assert_eq!(
            check_accept(T0 - 5.0 * MIN, T0 + 20.0 * MIN, false, &rebuilt()),
            DesktopActivityAcceptCheck::Ok {
                ok: True,
                start: T0,
                end: T0 + 20.0 * MIN
            }
        );
    }

    #[test]
    fn keeps_an_edited_accepts_own_times() {
        assert_eq!(
            check_accept(T0 - 5.0 * MIN, T0 + 20.0 * MIN, true, &rebuilt()),
            DesktopActivityAcceptCheck::Ok {
                ok: True,
                start: T0 - 5.0 * MIN,
                end: T0 + 20.0 * MIN
            }
        );
    }

    #[test]
    fn refuses_what_is_already_tracked_and_a_backwards_range() {
        assert_eq!(
            check_accept(T0 + 40.0 * MIN, T0 + 80.0 * MIN, true, &rebuilt()),
            refused(DesktopActivityAcceptRefusal::AlreadyTracked)
        );
        assert_eq!(
            check_accept(T0, T0, false, &rebuilt()),
            refused(DesktopActivityAcceptRefusal::BadRange)
        );
    }

    #[test]
    fn forgets_an_accepted_span_after_the_hold() {
        let spans = [AcceptedSpan {
            start: 0.0,
            end: 1.0,
            at: T0,
        }];
        assert_eq!(live_accepted(&spans, T0 + ACCEPTED_HOLD_MS - 1.0).len(), 1);
        assert_eq!(live_accepted(&spans, T0 + ACCEPTED_HOLD_MS).len(), 0);
    }
}
