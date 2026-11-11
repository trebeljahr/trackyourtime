//! Autopilot: when captured activity should start, switch or stop a timer by
//! itself (`packages/core/src/activity/autopilot.ts`).
//!
//! Suggestions wait for a person to look at them. Autopilot acts: somebody
//! who has worked in an app for a few minutes with no timer running gets one,
//! opened at the moment that work began. Everything it does is decided here,
//! pure — no clock, no zone, no storage — so the same rows give the same
//! decision on every host, and every rule below is a unit test.
//!
//! Four rules keep it from getting in the way:
//!
//! 1. **It only starts what it can name.** An app is filed by a rule, else by
//!    what this person tracked while that app was in front
//!    ([`learn_filings`]). An app with neither — or a browser used for five
//!    different projects — is never auto-started; it stays a suggestion. A
//!    timer called nothing is worse than no timer.
//! 2. **It never touches a timer it did not start.** Switching and stopping
//!    apply only to `running.owned`, which the host sets when the running
//!    entry is still exactly the one Autopilot opened.
//! 3. **It is retroactive, never ahead of the facts.** A start or a switch is
//!    dated to the first minute of the work that justified it, and a drift
//!    stop to the last minute of the timer's own work. A start never reaches
//!    back across time that is tracked.
//! 4. **Glances do not count.** Attention is read in one-minute buckets, and a
//!    short stretch of something else inside a run belongs to the run.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use super::rules::{host_matches, match_rule, rule_proposal};
use super::segments::{merge_segments, subtract_intervals, union_intervals};
use super::types::{
    ActivityInterval, ActivityRule, ActivitySegment, AutopilotFiling, AutopilotFilingSource,
    LearnableEntry, MergeSegmentsOptions, OrderedMap, ProposedEntryFields,
};
use crate::js;

const MINUTE_MS: f64 = 60_000.0;

pub const DEFAULT_AUTOPILOT_START_MINUTES: f64 = 5.0;
pub const AUTOPILOT_START_MINUTE_CHOICES: [f64; 4] = [3.0, 5.0, 10.0, 15.0];

/// Everything a decision is tuned by. Defaults in [`DEFAULT_AUTOPILOT_OPTIONS`].
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutopilotOptions {
    /// Time on one filing, with no timer running, before Autopilot starts it.
    pub start_after_ms: f64,
    /// Time on a different filing, inside an Autopilot timer, before it switches.
    pub switch_after_ms: f64,
    /// Time present but not on the timer's own work before an Autopilot timer stops.
    pub drift_after_ms: f64,
    /// Activity must have been seen this recently for anything to happen.
    pub live_ms: f64,
    /// A run survives a stretch of other activity or absence up to this long.
    pub max_interrupt_ms: f64,
    /// A run ends at a stretch of one other KNOWN filing this long.
    pub absorb_other_ms: f64,
    /// How far back a run may reach.
    pub lookback_ms: f64,
    /// The bucket attention is read in.
    pub bucket_ms: f64,
}

pub const DEFAULT_AUTOPILOT_OPTIONS: AutopilotOptions = AutopilotOptions {
    start_after_ms: DEFAULT_AUTOPILOT_START_MINUTES * MINUTE_MS,
    switch_after_ms: 10.0 * MINUTE_MS,
    drift_after_ms: 20.0 * MINUTE_MS,
    live_ms: 3.0 * MINUTE_MS,
    max_interrupt_ms: 10.0 * MINUTE_MS,
    absorb_other_ms: 5.0 * MINUTE_MS,
    lookback_ms: 4.0 * 60.0 * MINUTE_MS,
    bucket_ms: MINUTE_MS,
};

/// `Partial<AutopilotOptions>`, spread over the defaults.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutopilotOptionsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_after_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub switch_after_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub drift_after_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_interrupt_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub absorb_other_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lookback_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bucket_ms: Option<f64>,
}

impl AutopilotOptions {
    pub fn with(self, patch: AutopilotOptionsPatch) -> Self {
        AutopilotOptions {
            start_after_ms: patch.start_after_ms.unwrap_or(self.start_after_ms),
            switch_after_ms: patch.switch_after_ms.unwrap_or(self.switch_after_ms),
            drift_after_ms: patch.drift_after_ms.unwrap_or(self.drift_after_ms),
            live_ms: patch.live_ms.unwrap_or(self.live_ms),
            max_interrupt_ms: patch.max_interrupt_ms.unwrap_or(self.max_interrupt_ms),
            absorb_other_ms: patch.absorb_other_ms.unwrap_or(self.absorb_other_ms),
            lookback_ms: patch.lookback_ms.unwrap_or(self.lookback_ms),
            bucket_ms: patch.bucket_ms.unwrap_or(self.bucket_ms),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LearnFilingsOptions {
    /// An app must have been in front this long during one filing's entries. Default 15 min.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_evidence_ms: Option<f64>,
    /// That filing's share of the app's tracked time. Default 0.6.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_share: Option<f64>,
}

pub const DEFAULT_LEARN_MIN_EVIDENCE_MS: f64 = 15.0 * MINUTE_MS;
pub const DEFAULT_LEARN_MIN_SHARE: f64 = 0.6;

/// The identity of a filing: description (case and spacing folded), project
/// and task, as `JSON.stringify([description, projectId, taskId])`. Billable
/// and tags are left out — they follow the work rather than define it.
pub fn filing_key_of(
    description: Option<&str>,
    project_id: Option<&str>,
    task_id: Option<&str>,
) -> String {
    let description = js::lower(js::trim(&js::collapse_whitespace(
        description.unwrap_or(""),
    )));
    serde_json::to_string(&(description, project_id, task_id)).expect("strings serialize")
}

/// [`filing_key_of`] for proposed fields.
pub fn filing_key_of_fields(fields: &ProposedEntryFields) -> String {
    filing_key_of(
        fields.description.as_deref(),
        fields.project_id.as_ref().and_then(|p| p.as_deref()),
        fields.task_id.as_ref().and_then(|t| t.as_deref()),
    )
}

/// Whether a filing names anything: a description or a project.
pub fn is_fileable(description: Option<&str>, project_id: Option<&str>) -> bool {
    !js::trim(description.unwrap_or("")).is_empty() || project_id.is_some()
}

pub fn is_fileable_fields(fields: &ProposedEntryFields) -> bool {
    is_fileable(
        fields.description.as_deref(),
        fields.project_id.as_ref().and_then(|p| p.as_deref()),
    )
}

/// The key a "not this app" hold is stored under, beside filing keys.
pub fn app_hold_key(app_key: &str) -> String {
    format!("app:{app_key}")
}

/// What each app has been filed under, learned from this person's own entries.
///
/// Every entry credits the apps that were in front during it with the
/// overlap. An app is learned when one filing holds at least `minShare` of
/// its credited time and at least `minEvidenceMs` of it: an editor used for
/// one client learns that client, a browser used for everything learns
/// nothing. The fields come from the newest entry of the winning filing.
///
/// Entries with neither a description nor a project teach nothing.
pub fn learn_filings(
    segments: &[ActivitySegment],
    entries: &[LearnableEntry],
    options: LearnFilingsOptions,
) -> HashMap<String, AutopilotFiling> {
    let min_evidence = options
        .min_evidence_ms
        .unwrap_or(DEFAULT_LEARN_MIN_EVIDENCE_MS);
    let min_share = options.min_share.unwrap_or(DEFAULT_LEARN_MIN_SHARE);

    let present: Vec<ActivitySegment> = segments.iter().filter(|s| !s.afk).cloned().collect();
    let active = merge_segments(&present, MergeSegmentsOptions::default());
    // app → filing key → ms
    let mut credit: OrderedMap<OrderedMap<f64>> = OrderedMap::new();
    // filing key → the newest entry filed under it
    let mut newest: HashMap<String, &LearnableEntry> = HashMap::new();

    for entry in entries {
        if !(entry.end > entry.start) {
            continue;
        }
        if !is_fileable(Some(&entry.description), entry.project_id.as_deref()) {
            continue;
        }
        let key = filing_key_of(
            Some(&entry.description),
            entry.project_id.as_deref(),
            entry.task_id.as_deref(),
        );
        match newest.get(&key) {
            Some(known) if !(entry.end > known.end) => {}
            _ => {
                newest.insert(key.clone(), entry);
            }
        }

        for segment in &active {
            let overlap = segment.end.min(entry.end) - segment.start.max(entry.start);
            if overlap <= 0.0 {
                continue;
            }
            let per_filing = credit.entry_or(&segment.key, OrderedMap::new);
            *per_filing.entry_or(&key, || 0.0) += overlap;
        }
    }

    let mut learned = HashMap::new();
    for (app, per_filing) in credit.iter() {
        let mut total = 0.0;
        let mut best_key: Option<&String> = None;
        let mut best_ms = 0.0;
        let mut sorted: Vec<(&String, &f64)> = per_filing.iter().collect();
        sorted.sort_by(|a, b| js::compare_keys(a.0, b.0));
        for (key, ms) in sorted {
            total += ms;
            if *ms > best_ms {
                best_key = Some(key);
                best_ms = *ms;
            }
        }
        let Some(best_key) = best_key else { continue };
        if best_ms < min_evidence || best_ms / total < min_share {
            continue;
        }
        let Some(entry) = newest.get(best_key) else {
            continue;
        };
        learned.insert(
            app.clone(),
            AutopilotFiling {
                key: best_key.clone(),
                via: AutopilotFilingSource::Learned,
                fields: ProposedEntryFields {
                    description: Some(entry.description.clone()),
                    project_id: Some(entry.project_id.clone()),
                    task_id: Some(entry.task_id.clone()),
                    tag_ids: Some(entry.tag_ids.clone()),
                    billable: Some(entry.billable),
                },
                rule_id: None,
            },
        );
    }
    learned
}

/// How an app is filed: its rule first (the person said so), else what was
/// learned. A rule that names neither a description nor a project files
/// nothing, and does not fall through to learning either — the person wrote
/// a rule for this app, and it is not ours to second-guess.
pub struct FilingResolver<'a> {
    rules: &'a [ActivityRule],
    learned: &'a HashMap<String, AutopilotFiling>,
    cache: HashMap<String, Option<AutopilotFiling>>,
}

impl<'a> FilingResolver<'a> {
    pub fn new(rules: &'a [ActivityRule], learned: &'a HashMap<String, AutopilotFiling>) -> Self {
        FilingResolver {
            rules,
            learned,
            cache: HashMap::new(),
        }
    }

    pub fn resolve(&mut self, app_key: &str) -> Option<AutopilotFiling> {
        if let Some(cached) = self.cache.get(app_key) {
            return cached.clone();
        }
        let filing = match match_rule(self.rules, &[app_key]) {
            Some(rule) => {
                let fields = rule_proposal(rule);
                if is_fileable_fields(&fields) {
                    Some(AutopilotFiling {
                        key: filing_key_of_fields(&fields),
                        fields,
                        via: AutopilotFilingSource::Rule,
                        rule_id: Some(rule.id.clone()),
                    })
                } else {
                    None
                }
            }
            None => self.learned.get(app_key).cloned(),
        };
        self.cache.insert(app_key.to_string(), filing.clone());
        filing
    }
}

/// `createFilingResolver`, as a closure.
pub fn create_filing_resolver<'a>(
    rules: &'a [ActivityRule],
    learned: &'a HashMap<String, AutopilotFiling>,
) -> impl FnMut(&str) -> Option<AutopilotFiling> + 'a {
    let mut resolver = FilingResolver::new(rules, learned);
    move |app| resolver.resolve(app)
}

/// Whether `appKey` is covered by any rule (to tell "unknown" from "filed as nothing").
pub fn has_rule_for(rules: &[ActivityRule], app_key: &str) -> bool {
    rules
        .iter()
        .any(|rule| host_matches(&rule.pattern, app_key))
}

// ── attention ─────────────────────────────────────────────────────────

/// A piece of untracked activity, labelled with the filing its app resolves to.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelledPiece {
    pub start: f64,
    pub end: f64,
    pub app: String,
    /// Null for an app Autopilot cannot file.
    pub filing: Option<String>,
}

/// A stretch of attention on one filing, read backwards from now.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutopilotRun {
    pub filing_key: String,
    /// The first instant of the filing's own activity in the run.
    pub start: f64,
    /// The end of the filing's last activity in the run.
    pub last_at: f64,
    /// Time spent on the filing inside the run (not its span).
    pub credited_ms: f64,
    /// The app that contributed most of it.
    pub app_key: String,
}

const UNKNOWN: &str = "?";

#[derive(Default)]
struct Bucket {
    ms: OrderedMap<f64>,
    /// Earliest piece start per label inside the bucket.
    first: OrderedMap<f64>,
    /// Latest piece end per label inside the bucket.
    last: OrderedMap<f64>,
    /// ms per app, per label.
    apps: OrderedMap<OrderedMap<f64>>,
}

/// Pieces shorter than this in a bucket do not make it "present".
const PRESENCE_MS: f64 = 1_000.0;

fn bucket_label(bucket: &Bucket) -> Option<String> {
    let mut total = 0.0;
    let mut best_known: Option<&String> = None;
    let mut best_known_ms = 0.0;
    let mut sorted: Vec<(&String, &f64)> = bucket.ms.iter().collect();
    sorted.sort_by(|a, b| js::compare_keys(a.0, b.0));
    for (label, ms) in sorted {
        total += ms;
        if label != UNKNOWN && *ms > best_known_ms {
            best_known = Some(label);
            best_known_ms = *ms;
        }
    }
    if total < PRESENCE_MS {
        return None;
    }
    let unknown_ms = bucket.ms.get(UNKNOWN).copied().unwrap_or(0.0);
    match best_known {
        Some(label) if best_known_ms >= unknown_ms => Some(label.clone()),
        _ => Some(UNKNOWN.to_string()),
    }
}

/// The run of attention that is going on now: the most recent filing,
/// followed back through time for as long as it holds.
///
/// Read in buckets of `bucketMs`, aligned to `now`. A bucket belongs to the
/// known filing with the most time in it, unless unfiled apps had more.
/// Walking backwards from now, the first known filing is the target; the run
/// then extends over every bucket of it, and over interruptions — absence,
/// unfiled apps, other filings — until one lasts longer than
/// `maxInterruptMs`, or one other filing holds for `absorbOtherMs` in a row.
/// Nothing before `from`.
pub fn trailing_run(
    pieces: &[LabelledPiece],
    from: f64,
    now: f64,
    options: &AutopilotOptions,
) -> Option<AutopilotRun> {
    let size = options.bucket_ms;
    let count = ((now - from) / size).ceil();
    if !(count > 0.0) {
        return None;
    }
    let count = count as usize;

    // Bucket k covers [now - (k + 1) * size, now - k * size); k = 0 is the newest.
    let mut buckets: Vec<Bucket> = (0..count).map(|_| Bucket::default()).collect();
    for piece in pieces {
        let start = piece.start.max(from);
        let end = piece.end.min(now);
        if end <= start {
            continue;
        }
        let label = piece.filing.as_deref().unwrap_or(UNKNOWN);
        let newest = ((now - end) / size).floor();
        let oldest = ((count - 1) as f64).min(((now - start - 1.0) / size).floor());
        let mut k = newest.max(0.0);
        while k <= oldest {
            let index = k as usize;
            let bucket_end = now - k * size;
            let bucket_start = bucket_end - size;
            let a = start.max(bucket_start);
            let b = end.min(bucket_end);
            k += 1.0;
            if b <= a {
                continue;
            }
            let bucket = &mut buckets[index];
            *bucket.ms.entry_or(label, || 0.0) += b - a;
            let first = bucket.first.entry_or(label, || f64::INFINITY);
            *first = first.min(a);
            let last = bucket.last.entry_or(label, || f64::NEG_INFINITY);
            *last = last.max(b);
            let apps = bucket.apps.entry_or(label, OrderedMap::new);
            *apps.entry_or(&piece.app, || 0.0) += b - a;
        }
    }

    let mut target: Option<String> = None;
    let mut since_target = 0.0;
    let mut other_streak = 0.0;
    let mut credited = 0.0;
    let mut start = 0.0;
    let mut last_at = 0.0;
    let mut app_ms: OrderedMap<f64> = OrderedMap::new();

    for (k, bucket) in buckets.iter().enumerate() {
        let kf = k as f64;
        let label = bucket_label(bucket);
        if target.is_none() {
            if let Some(found) = label.as_deref().filter(|l| *l != UNKNOWN) {
                target = Some(found.to_string());
                last_at = bucket.last.get(found).copied().unwrap_or(now - kf * size);
            }
        }
        if let Some(target) = target.as_deref() {
            if label.as_deref() == Some(target) {
                credited += bucket.ms.get(target).copied().unwrap_or(0.0);
                start = bucket
                    .first
                    .get(target)
                    .copied()
                    .unwrap_or(now - (kf + 1.0) * size);
                if let Some(apps) = bucket.apps.get(target) {
                    for (app, ms) in apps.iter() {
                        *app_ms.entry_or(app, || 0.0) += ms;
                    }
                }
                since_target = 0.0;
                other_streak = 0.0;
                continue;
            }
        }
        since_target += size;
        other_streak = match label.as_deref() {
            Some(l) if l != UNKNOWN => other_streak + size,
            _ => 0.0,
        };
        if since_target > options.max_interrupt_ms {
            break;
        }
        if target.is_some() && other_streak >= options.absorb_other_ms {
            break;
        }
    }

    let target = target?;
    if credited <= 0.0 {
        return None;
    }
    let mut ranked: Vec<(&String, &f64)> = app_ms.iter().collect();
    ranked.sort_by(|a, b| js::cmp_numbers(*b.1, *a.1).then_with(|| js::compare_keys(a.0, b.0)));
    let app_key = ranked
        .first()
        .map(|(app, _)| (*app).clone())
        .unwrap_or_default();
    Some(AutopilotRun {
        filing_key: target,
        start,
        last_at,
        credited_ms: credited,
        app_key,
    })
}

/// The app that has had most of the attention since the last real break,
/// for the "what is this?" prompt.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutopilotStreak {
    pub app_key: String,
    pub since: f64,
    pub app_ms: f64,
}

/// Walks back from now while gaps stay under `maxInterruptMs`.
pub fn trailing_streak(
    pieces: &[LabelledPiece],
    from: f64,
    now: f64,
    max_interrupt_ms: f64,
) -> Option<AutopilotStreak> {
    let mut sorted: Vec<LabelledPiece> = pieces
        .iter()
        .map(|piece| LabelledPiece {
            start: piece.start.max(from),
            end: piece.end.min(now),
            ..piece.clone()
        })
        .filter(|piece| piece.end > piece.start)
        .collect();
    sorted.sort_by(|a, b| {
        js::cmp_numbers(b.end, a.end).then_with(|| js::cmp_numbers(b.start, a.start))
    });
    let mut cursor = now;
    let mut per_app: OrderedMap<(f64, f64)> = OrderedMap::new();
    for piece in &sorted {
        if cursor - piece.end > max_interrupt_ms {
            break;
        }
        let known = per_app
            .get(&piece.app)
            .copied()
            .unwrap_or((0.0, piece.start));
        per_app.set(
            &piece.app,
            (
                known.0 + (piece.end - piece.start),
                known.1.min(piece.start),
            ),
        );
        cursor = cursor.min(piece.start);
    }
    let mut ranked: Vec<(&String, &(f64, f64))> = per_app.iter().collect();
    ranked.sort_by(|a, b| js::cmp_numbers(b.1 .0, a.1 .0).then_with(|| js::compare_keys(a.0, b.0)));
    ranked.first().map(|(app, (ms, since))| AutopilotStreak {
        app_key: (*app).clone(),
        since: *since,
        app_ms: *ms,
    })
}

// ── deciding ──────────────────────────────────────────────────────────

/// The running entry, as Autopilot sees it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutopilotRunning {
    pub start: f64,
    /// [`filing_key_of`] its fields.
    pub filing_key: String,
    /// Still exactly the entry Autopilot opened (same start, same filing).
    pub owned: bool,
}

pub struct AutopilotInput<'a> {
    pub now: f64,
    /// Recent activity, the open segment included.
    pub segments: &'a [ActivitySegment],
    /// Time accounted for — entries, queued writes, dismissals — WITHOUT the
    /// running entry, which `running` describes.
    pub tracked: &'a [ActivityInterval],
    pub running: Option<AutopilotRunning>,
    pub resolve: &'a mut dyn FnMut(&str) -> Option<AutopilotFiling>,
    /// Filing keys and [`app_hold_key`]s Autopilot must not start right now.
    pub held: &'a HashSet<String>,
    pub options: AutopilotOptionsPatch,
}

/// What Autopilot is looking at, for the screen.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutopilotWatch {
    pub app_key: String,
    /// When the watched stretch began.
    pub since: f64,
    /// Time on it so far.
    pub credited_ms: f64,
    /// What it would be filed under; null when Autopilot cannot tell.
    pub filing: Option<AutopilotFiling>,
    /// On hold until the next break (undone, stopped by hand, or "not work").
    pub held: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum AutopilotDecision {
    None {
        watch: Option<AutopilotWatch>,
    },
    Start {
        at: f64,
        filing: AutopilotFiling,
        #[serde(rename = "appKey")]
        app_key: String,
        #[serde(rename = "creditedMs")]
        credited_ms: f64,
    },
    Switch {
        at: f64,
        filing: AutopilotFiling,
        #[serde(rename = "appKey")]
        app_key: String,
        #[serde(rename = "creditedMs")]
        credited_ms: f64,
    },
    /// An Autopilot timer whose work stopped while the person stayed: ended at its last minute.
    Stop {
        at: f64,
    },
}

fn is_held(held: &HashSet<String>, filing_key: Option<&str>, app_key: &str) -> bool {
    filing_key.is_some_and(|key| held.contains(key)) || held.contains(&app_hold_key(app_key))
}

/// One decision, for now.
///
/// - **Nothing running:** start the trailing run's filing, dated to its first
///   minute, once it holds `startAfterMs` — unless it is on hold.
/// - **An Autopilot timer running:** switch to a different filing that has
///   held `switchAfterMs`, at its first minute; or, when the person is here
///   but nothing of the timer's own work has happened for `driftAfterMs`,
///   stop it at the end of that work.
/// - **Anything else running, or nobody here** (no activity within `liveMs`):
///   nothing. Absence belongs to the idle guard, which asks.
pub fn decide_autopilot(input: AutopilotInput<'_>) -> AutopilotDecision {
    let options = DEFAULT_AUTOPILOT_OPTIONS.with(input.options);
    let now = input.now;
    let none = |watch: Option<AutopilotWatch>| AutopilotDecision::None { watch };

    let present: Vec<ActivitySegment> = input.segments.iter().filter(|s| !s.afk).cloned().collect();
    let active = merge_segments(&present, MergeSegmentsOptions::default());
    let last_seen = active.iter().fold(f64::NEG_INFINITY, |max, segment| {
        max.max(segment.end.min(now))
    });
    if !(now - last_seen <= options.live_ms) {
        return none(None);
    }

    if let Some(running) = &input.running {
        if !running.owned {
            return none(None);
        }
    }

    let tracked = union_intervals(input.tracked);
    // Something tracked covers now — a queued start the running entry does
    // not show yet. Nothing to do until the two agree.
    if input.running.is_none() && tracked.iter().any(|t| t.start <= now && t.end > now) {
        return none(None);
    }

    // A run never reaches back across tracked time: a start dated before the
    // last entry ended would overlap it.
    let mut from = now - options.lookback_ms;
    for interval in &tracked {
        if interval.end <= now {
            from = from.max(interval.end);
        }
    }
    if let Some(running) = &input.running {
        from = from.max(running.start);
    }

    let mut resolved: HashMap<String, Option<AutopilotFiling>> = HashMap::new();
    let resolve = input.resolve;
    let mut filing_of = |app: &str| -> Option<AutopilotFiling> {
        if !resolved.contains_key(app) {
            let filing = resolve(app);
            resolved.insert(app.to_string(), filing);
        }
        resolved.get(app).cloned().flatten()
    };

    let mut pieces: Vec<LabelledPiece> = Vec::new();
    for segment in &active {
        if segment.end <= from || segment.start >= now {
            continue;
        }
        let clipped = ActivityInterval {
            start: segment.start.max(from),
            end: segment.end.min(now),
        };
        for piece in subtract_intervals(clipped, &tracked) {
            let filing = filing_of(&segment.key).map(|f| f.key);
            pieces.push(LabelledPiece {
                start: piece.start,
                end: piece.end,
                app: segment.key.clone(),
                filing,
            });
        }
    }

    let run = trailing_run(&pieces, from, now, &options);
    let run_filing = run.as_ref().and_then(|run| filing_of(&run.app_key));

    let Some(running) = input.running else {
        if let (Some(run), Some(run_filing)) = (&run, &run_filing) {
            if run_filing.key == run.filing_key {
                let held = is_held(input.held, Some(&run.filing_key), &run.app_key);
                if !held && run.credited_ms >= options.start_after_ms {
                    return AutopilotDecision::Start {
                        at: run.start,
                        filing: run_filing.clone(),
                        app_key: run.app_key.clone(),
                        credited_ms: run.credited_ms,
                    };
                }
                return none(Some(AutopilotWatch {
                    app_key: run.app_key.clone(),
                    since: run.start,
                    credited_ms: run.credited_ms,
                    filing: Some(run_filing.clone()),
                    held,
                }));
            }
        }
        let Some(streak) = trailing_streak(&pieces, from, now, options.max_interrupt_ms) else {
            return none(None);
        };
        let filing = filing_of(&streak.app_key);
        let held = is_held(
            input.held,
            filing.as_ref().map(|f| f.key.as_str()),
            &streak.app_key,
        );
        return none(Some(AutopilotWatch {
            app_key: streak.app_key,
            since: streak.since,
            credited_ms: streak.app_ms,
            filing,
            held,
        }));
    };

    // An Autopilot timer is running.
    if let (Some(run), Some(run_filing)) = (&run, &run_filing) {
        if run_filing.key == run.filing_key
            && run.filing_key != running.filing_key
            && run.start > running.start
            && run.credited_ms >= options.switch_after_ms
            && !is_held(input.held, Some(&run.filing_key), &run.app_key)
        {
            return AutopilotDecision::Switch {
                at: run.start,
                filing: run_filing.clone(),
                app_key: run.app_key.clone(),
                credited_ms: run.credited_ms,
            };
        }
    }

    let own_last = pieces
        .iter()
        .filter(|piece| piece.filing.as_deref() == Some(running.filing_key.as_str()))
        .fold(f64::NEG_INFINITY, |max, piece| max.max(piece.end));
    if own_last.is_finite() && own_last > running.start {
        // Absence is the idle guard's to judge — it may have asked, and been
        // told to keep it. Drift counts only time the person was here doing
        // something else, so it is measured from the end of the last break,
        // and the stop never takes back time on the far side of one.
        let anchor = own_last.max(
            last_break_end(&active, own_last, now, options.max_interrupt_ms).unwrap_or(own_last),
        );
        if now - anchor >= options.drift_after_ms {
            return AutopilotDecision::Stop { at: anchor };
        }
    }

    if let Some(run) = &run {
        if run.filing_key == running.filing_key {
            return none(Some(AutopilotWatch {
                app_key: run.app_key.clone(),
                since: run.start,
                credited_ms: run.credited_ms,
                filing: run_filing,
                held: false,
            }));
        }
    }
    none(None)
}

/// Activity in `[since, now)`, as a sorted, disjoint union.
fn busy_between(segments: &[ActivitySegment], since: f64, now: f64) -> Vec<ActivityInterval> {
    let clipped: Vec<ActivityInterval> = segments
        .iter()
        .filter(|segment| !segment.afk && segment.end > since && segment.start < now)
        .map(|segment| ActivityInterval {
            start: segment.start.max(since),
            end: segment.end.min(now),
        })
        .collect();
    union_intervals(&clipped)
}

/// Where the last stretch of no activity at all lasting `breakMs` or more,
/// between `since` and `now`, ended — or None when there was none. A
/// trailing one (the person is away now) ends at `now`.
pub fn last_break_end(
    segments: &[ActivitySegment],
    since: f64,
    now: f64,
    break_ms: f64,
) -> Option<f64> {
    let mut cursor = since;
    let mut found = None;
    for interval in busy_between(segments, since, now) {
        if interval.start - cursor >= break_ms {
            found = Some(interval.start);
        }
        cursor = cursor.max(interval.end);
    }
    if now - cursor >= break_ms {
        found = Some(now);
    }
    found
}

/// Whether the person took a break of at least `breakMs` between `since` and
/// `now` — a stretch with no activity at all, the trailing one included. A
/// hold ("not now", an undo, a timer stopped by hand) lasts until one.
pub fn had_break_since(segments: &[ActivitySegment], since: f64, now: f64, break_ms: f64) -> bool {
    if now - since < break_ms {
        return false;
    }
    last_break_end(segments, since, now, break_ms).is_some()
}

#[cfg(test)]
mod tests {
    use super::super::rules::tests::rule;
    use super::super::types::ActivitySource;
    use super::*;

    const MIN: f64 = 60_000.0;
    /// `Date.parse("2026-10-19T08:00:00.000Z")`.
    const T0: f64 = 1_792_396_800_000.0;
    fn at(min: f64) -> f64 {
        T0 + min * MIN
    }

    fn seg(key: &str, start_min: f64, end_min: f64) -> ActivitySegment {
        ActivitySegment {
            source: ActivitySource::Desktop,
            start: at(start_min),
            end: at(end_min),
            key: key.into(),
            label: None,
            afk: false,
        }
    }

    fn entry(start_min: f64, end_min: f64) -> LearnableEntry {
        LearnableEntry {
            start: at(start_min),
            end: at(end_min),
            description: "Website redesign".into(),
            project_id: Some("p-web".into()),
            task_id: None,
            tag_ids: vec![],
            billable: true,
        }
    }

    const FIGMA: &str = "com.figma.desktop";
    const SLACK: &str = "com.tinyspeck.slackmacgap";
    const CODE: &str = "com.microsoft.vscode";
    const CHROME: &str = "com.google.chrome";

    fn rules() -> Vec<ActivityRule> {
        let mut figma = rule("r-figma", FIGMA);
        figma.description = Some("Website redesign".into());
        figma.project_id = Some(Some("p-web".into()));
        let mut code = rule("r-code", CODE);
        code.description = Some("API work".into());
        code.project_id = Some(Some("p-api".into()));
        vec![figma, code]
    }

    fn web() -> String {
        filing_key_of(Some("Website redesign"), Some("p-web"), None)
    }
    fn api() -> String {
        filing_key_of(Some("API work"), Some("p-api"), None)
    }

    struct Decide {
        now: f64,
        segments: Vec<ActivitySegment>,
        tracked: Vec<ActivityInterval>,
        running: Option<AutopilotRunning>,
        rules: Vec<ActivityRule>,
        learned: HashMap<String, AutopilotFiling>,
        held: HashSet<String>,
        options: AutopilotOptionsPatch,
    }

    impl Decide {
        fn new(now: f64, segments: Vec<ActivitySegment>) -> Self {
            Decide {
                now,
                segments,
                tracked: vec![],
                running: None,
                rules: rules(),
                learned: HashMap::new(),
                held: HashSet::new(),
                options: AutopilotOptionsPatch::default(),
            }
        }
        fn run(&self) -> AutopilotDecision {
            let mut resolve = create_filing_resolver(&self.rules, &self.learned);
            decide_autopilot(AutopilotInput {
                now: self.now,
                segments: &self.segments,
                tracked: &self.tracked,
                running: self.running.clone(),
                resolve: &mut resolve,
                held: &self.held,
                options: self.options,
            })
        }
    }

    #[test]
    fn filing_keys_fold_case_and_spacing_and_ignore_billable_and_tags() {
        assert_eq!(
            filing_key_of(Some("  Website   Redesign "), Some("p-web"), None),
            filing_key_of(Some("website redesign"), Some("p-web"), None)
        );
        assert_ne!(
            filing_key_of(Some("x"), Some("p-a"), None),
            filing_key_of(Some("x"), Some("p-b"), None)
        );
        assert_eq!(
            filing_key_of(Some("A b"), None, Some("t")),
            r#"["a b",null,"t"]"#
        );
    }

    #[test]
    fn a_filing_needs_a_description_or_a_project() {
        assert!(!is_fileable(None, None));
        assert!(!is_fileable(Some("  "), None));
        assert!(is_fileable(Some("x"), None));
        assert!(is_fileable(None, Some("p")));
    }

    #[test]
    fn an_app_used_for_one_filing_learns_it() {
        let mut newer = entry(60.0, 80.0);
        newer.tag_ids = vec!["t-1".into()];
        newer.billable = false;
        let learned = learn_filings(
            &[seg(FIGMA, 0.0, 30.0), seg(FIGMA, 60.0, 80.0)],
            &[entry(0.0, 30.0), newer],
            LearnFilingsOptions::default(),
        );
        let figma = &learned[FIGMA];
        assert_eq!(figma.key, web());
        assert_eq!(figma.via, AutopilotFilingSource::Learned);
        assert_eq!(figma.fields.tag_ids, Some(vec!["t-1".to_string()]));
        assert_eq!(figma.fields.billable, Some(false));
    }

    #[test]
    fn an_app_split_across_filings_learns_nothing() {
        let mut admin = entry(30.0, 60.0);
        admin.description = "Invoices".into();
        admin.project_id = Some("p-admin".into());
        let learned = learn_filings(
            &[seg(CHROME, 0.0, 30.0), seg(CHROME, 30.0, 60.0)],
            &[entry(0.0, 30.0), admin],
            LearnFilingsOptions::default(),
        );
        assert!(!learned.contains_key(CHROME));
    }

    #[test]
    fn too_little_evidence_learns_nothing() {
        let learned = learn_filings(
            &[seg(FIGMA, 0.0, 10.0)],
            &[entry(0.0, 10.0)],
            LearnFilingsOptions::default(),
        );
        assert!(!learned.contains_key(FIGMA));
    }

    #[test]
    fn nameless_entries_teach_nothing() {
        let mut nameless = entry(0.0, 60.0);
        nameless.description = String::new();
        nameless.project_id = None;
        assert!(learn_filings(
            &[seg(FIGMA, 0.0, 60.0)],
            &[nameless],
            LearnFilingsOptions::default()
        )
        .is_empty());
    }

    #[test]
    fn a_rule_wins_over_what_was_learned_and_an_empty_rule_files_nothing() {
        let api_filing = AutopilotFiling {
            key: api(),
            via: AutopilotFilingSource::Learned,
            fields: ProposedEntryFields {
                description: Some("API work".into()),
                project_id: Some(Some("p-api".into())),
                ..Default::default()
            },
            rule_id: None,
        };
        let learned: HashMap<String, AutopilotFiling> = [
            (FIGMA.to_string(), api_filing.clone()),
            (SLACK.to_string(), api_filing),
        ]
        .into_iter()
        .collect();
        let mut slack = rule("r-slack", SLACK);
        slack.tag_ids = Some(vec!["t".into()]);
        let mut all = rules();
        all.push(slack);
        let mut resolve = create_filing_resolver(&all, &learned);
        let figma = resolve(FIGMA).unwrap();
        assert_eq!(figma.via, AutopilotFilingSource::Rule);
        assert_eq!(figma.rule_id.as_deref(), Some("r-figma"));
        assert!(resolve(SLACK).is_none());
        assert!(resolve(CHROME).is_none());
    }

    fn piece(app: &str, filing: Option<String>, start_min: f64, end_min: f64) -> LabelledPiece {
        LabelledPiece {
            app: app.into(),
            filing,
            start: at(start_min),
            end: at(end_min),
        }
    }

    fn run_options() -> AutopilotOptions {
        AutopilotOptions {
            bucket_ms: MIN,
            max_interrupt_ms: 10.0 * MIN,
            absorb_other_ms: 5.0 * MIN,
            ..DEFAULT_AUTOPILOT_OPTIONS
        }
    }

    #[test]
    fn a_run_follows_its_filing_back_through_short_interruptions() {
        let run = trailing_run(
            &[
                piece(FIGMA, Some(web()), 0.0, 10.0),
                piece(SLACK, None, 10.0, 13.0),
                piece(CODE, Some(api()), 13.0, 15.0),
                piece(FIGMA, Some(web()), 15.0, 20.0),
            ],
            at(-60.0),
            at(20.0),
            &run_options(),
        )
        .unwrap();
        assert_eq!(run.filing_key, web());
        assert_eq!(run.start, at(0.0));
        assert_eq!(run.credited_ms, 15.0 * MIN);
        assert_eq!(run.app_key, FIGMA);
    }

    #[test]
    fn five_minutes_of_another_filing_ends_a_run() {
        let run = trailing_run(
            &[
                piece(FIGMA, Some(web()), 0.0, 10.0),
                piece(CODE, Some(api()), 10.0, 16.0),
                piece(FIGMA, Some(web()), 16.0, 20.0),
            ],
            at(-60.0),
            at(20.0),
            &run_options(),
        )
        .unwrap();
        assert_eq!(run.start, at(16.0));
        assert_eq!(run.credited_ms, 4.0 * MIN);
    }

    #[test]
    fn a_long_absence_ends_a_run() {
        let run = trailing_run(
            &[
                piece(FIGMA, Some(web()), 0.0, 10.0),
                piece(FIGMA, Some(web()), 25.0, 30.0),
            ],
            at(-60.0),
            at(30.0),
            &run_options(),
        )
        .unwrap();
        assert_eq!(run.start, at(25.0));
    }

    #[test]
    fn a_run_is_not_followed_before_from() {
        let run = trailing_run(
            &[piece(FIGMA, Some(web()), 0.0, 30.0)],
            at(12.0),
            at(30.0),
            &run_options(),
        )
        .unwrap();
        assert_eq!(run.start, at(12.0));
    }

    #[test]
    fn only_unfiled_activity_is_no_run() {
        assert!(trailing_run(
            &[piece(CHROME, None, 0.0, 30.0)],
            at(-60.0),
            at(30.0),
            &run_options()
        )
        .is_none());
    }

    #[test]
    fn five_minutes_in_a_filed_app_start_its_timer_dated_to_the_first_minute() {
        match Decide::new(at(6.0), vec![seg(FIGMA, 0.0, 6.0)]).run() {
            AutopilotDecision::Start {
                at: start,
                filing,
                app_key,
                ..
            } => {
                assert_eq!(start, at(0.0));
                assert_eq!(filing.key, web());
                assert_eq!(filing.via, AutopilotFilingSource::Rule);
                assert_eq!(app_key, FIGMA);
            }
            other => panic!("expected start, got {other:?}"),
        }
    }

    #[test]
    fn before_the_threshold_it_only_watches() {
        match Decide::new(at(3.0), vec![seg(FIGMA, 0.0, 3.0)]).run() {
            AutopilotDecision::None { watch: Some(watch) } => {
                assert_eq!(watch.app_key, FIGMA);
                assert_eq!(watch.filing.map(|f| f.key), Some(web()));
                assert_eq!(watch.credited_ms, 3.0 * MIN);
            }
            other => panic!("expected a watch, got {other:?}"),
        }
    }

    #[test]
    fn the_threshold_is_an_option() {
        let mut decide = Decide::new(at(3.0), vec![seg(FIGMA, 0.0, 3.0)]);
        decide.options.start_after_ms = Some(3.0 * MIN);
        assert!(matches!(decide.run(), AutopilotDecision::Start { .. }));
    }

    #[test]
    fn an_app_it_cannot_file_is_never_started_and_is_watched_for_the_question() {
        match Decide::new(at(30.0), vec![seg(CHROME, 0.0, 30.0)]).run() {
            AutopilotDecision::None { watch: Some(watch) } => {
                assert_eq!(watch.app_key, CHROME);
                assert_eq!(watch.filing, None);
                assert_eq!(watch.since, at(0.0));
            }
            other => panic!("expected a watch, got {other:?}"),
        }
    }

    #[test]
    fn nobody_here_nothing_happens() {
        assert_eq!(
            Decide::new(at(20.0), vec![seg(FIGMA, 0.0, 10.0)]).run(),
            AutopilotDecision::None { watch: None }
        );
    }

    #[test]
    fn a_start_never_reaches_back_across_tracked_time() {
        let mut decide = Decide::new(at(30.0), vec![seg(FIGMA, 0.0, 30.0)]);
        decide.tracked = vec![ActivityInterval {
            start: at(5.0),
            end: at(20.0),
        }];
        match decide.run() {
            AutopilotDecision::Start { at: start, .. } => assert_eq!(start, at(20.0)),
            other => panic!("expected start, got {other:?}"),
        }
    }

    #[test]
    fn a_held_filing_or_app_is_not_started() {
        let mut decide = Decide::new(at(10.0), vec![seg(FIGMA, 0.0, 10.0)]);
        decide.held = [web()].into_iter().collect();
        assert!(matches!(decide.run(), AutopilotDecision::None { .. }));
        decide.held = [app_hold_key(FIGMA)].into_iter().collect();
        match decide.run() {
            AutopilotDecision::None { watch: Some(watch) } => assert!(watch.held),
            other => panic!("expected a held watch, got {other:?}"),
        }
    }

    #[test]
    fn a_timer_it_did_not_start_is_left_alone() {
        let mut decide = Decide::new(at(40.0), vec![seg(FIGMA, 0.0, 10.0), seg(CODE, 10.0, 40.0)]);
        decide.running = Some(AutopilotRunning {
            start: at(0.0),
            filing_key: web(),
            owned: false,
        });
        assert_eq!(decide.run(), AutopilotDecision::None { watch: None });
    }

    #[test]
    fn learned_filings_start_too() {
        let mut research = entry(-300.0, -200.0);
        research.description = "Research".into();
        let learned = learn_filings(
            &[seg(CHROME, -300.0, -200.0)],
            &[research],
            LearnFilingsOptions::default(),
        );
        let mut decide = Decide::new(at(6.0), vec![seg(CHROME, 0.0, 6.0)]);
        decide.rules = vec![];
        decide.learned = learned;
        match decide.run() {
            AutopilotDecision::Start { filing, .. } => {
                assert_eq!(filing.via, AutopilotFilingSource::Learned);
                assert_eq!(filing.fields.description.as_deref(), Some("Research"));
            }
            other => panic!("expected start, got {other:?}"),
        }
    }

    fn owned_web() -> Option<AutopilotRunning> {
        Some(AutopilotRunning {
            start: at(0.0),
            filing_key: web(),
            owned: true,
        })
    }

    #[test]
    fn ten_minutes_on_another_filing_switch_an_autopilot_timer_at_its_first_minute() {
        let mut decide = Decide::new(at(31.0), vec![seg(FIGMA, 0.0, 20.0), seg(CODE, 20.0, 31.0)]);
        decide.running = owned_web();
        match decide.run() {
            AutopilotDecision::Switch {
                at: start, filing, ..
            } => {
                assert_eq!(start, at(20.0));
                assert_eq!(filing.key, api());
            }
            other => panic!("expected switch, got {other:?}"),
        }
    }

    #[test]
    fn a_short_visit_to_another_filing_does_not_switch() {
        let mut decide = Decide::new(
            at(30.0),
            vec![
                seg(FIGMA, 0.0, 20.0),
                seg(CODE, 20.0, 26.0),
                seg(FIGMA, 26.0, 30.0),
            ],
        );
        decide.running = owned_web();
        assert!(matches!(decide.run(), AutopilotDecision::None { .. }));
    }

    #[test]
    fn present_but_off_the_timers_work_for_twenty_minutes_stops_it_where_the_work_ended() {
        let mut decide = Decide::new(
            at(41.0),
            vec![seg(FIGMA, 0.0, 20.0), seg(CHROME, 20.0, 41.0)],
        );
        decide.running = owned_web();
        assert_eq!(decide.run(), AutopilotDecision::Stop { at: at(20.0) });
    }

    #[test]
    fn drift_is_counted_from_the_end_of_a_break_not_across_it() {
        let mut early = Decide::new(
            at(75.0),
            vec![seg(FIGMA, 0.0, 20.0), seg(CHROME, 60.0, 75.0)],
        );
        early.running = owned_web();
        assert!(matches!(early.run(), AutopilotDecision::None { .. }));
        let mut later = Decide::new(
            at(81.0),
            vec![seg(FIGMA, 0.0, 20.0), seg(CHROME, 60.0, 81.0)],
        );
        later.running = owned_web();
        assert_eq!(later.run(), AutopilotDecision::Stop { at: at(60.0) });
    }

    #[test]
    fn a_held_filing_is_not_switched_to() {
        let mut decide = Decide::new(at(31.0), vec![seg(FIGMA, 0.0, 20.0), seg(CODE, 20.0, 31.0)]);
        decide.running = owned_web();
        decide.held = [api()].into_iter().collect();
        assert!(matches!(decide.run(), AutopilotDecision::None { .. }));
    }

    #[test]
    fn breaks_are_found_between_and_after_activity() {
        let segments = [seg(FIGMA, 0.0, 10.0), seg(FIGMA, 25.0, 30.0)];
        assert_eq!(
            last_break_end(&segments, at(0.0), at(30.0), 10.0 * MIN),
            Some(at(25.0))
        );
        assert_eq!(
            last_break_end(&segments, at(0.0), at(45.0), 10.0 * MIN),
            Some(at(45.0))
        );
        assert_eq!(
            last_break_end(&segments, at(0.0), at(30.0), 20.0 * MIN),
            None
        );
        assert!(had_break_since(&segments, at(0.0), at(30.0), 10.0 * MIN));
        assert!(!had_break_since(&segments, at(26.0), at(30.0), 10.0 * MIN));
    }
}
