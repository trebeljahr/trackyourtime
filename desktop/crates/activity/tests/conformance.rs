//! Replays every case `fixtures/generate.mts` recorded from the TypeScript
//! core against the Rust port. The browser extension keeps running the
//! TypeScript, so any difference here is two devices disagreeing about the
//! same rows. Regenerate with `node desktop/crates/activity/fixtures/check.mjs
//! --write` after a deliberate change to `packages/core/src/activity`.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::Value;

use tyt_activity::core::*;
use tyt_activity::js;

#[derive(Deserialize)]
struct Case {
    #[serde(rename = "fn")]
    function: String,
    input: Value,
    output: Value,
}

fn field<T: DeserializeOwned>(input: &Value, name: &str) -> T {
    serde_json::from_value(input.get(name).cloned().unwrap_or(Value::Null))
        .unwrap_or_else(|error| panic!("input field {name}: {error}"))
}

fn optional<T: DeserializeOwned + Default>(input: &Value, name: &str) -> T {
    match input.get(name) {
        None | Some(Value::Null) => T::default(),
        Some(value) => serde_json::from_value(value.clone())
            .unwrap_or_else(|error| panic!("input field {name}: {error}")),
    }
}

fn to_json<T: serde::Serialize>(value: &T) -> Value {
    let mut value = serde_json::to_value(value).expect("serializes");
    js::normalize_numbers(&mut value);
    value
}

/// JSON equality with numbers compared as the f64 JavaScript holds.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(a, b)| same(a, b))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(key, value)| y.get(key).is_some_and(|other| same(value, other)))
        }
        _ => a == b,
    }
}

fn learned_of(input: &Value) -> HashMap<String, AutopilotFiling> {
    let entries: Vec<(String, AutopilotFiling)> = field(input, "learned");
    entries.into_iter().collect()
}

fn run(case: &Case) -> Value {
    let input = &case.input;
    match case.function.as_str() {
        "mergeSegments" => {
            let segments: Vec<ActivitySegment> = field(input, "segments");
            to_json(&merge_segments(&segments, optional(input, "options")))
        }
        "unionIntervals" => to_json(&union_intervals(&field::<Vec<ActivityInterval>>(
            input,
            "intervals",
        ))),
        "totalLength" => to_json(&total_length(&field::<Vec<ActivityInterval>>(
            input, "union",
        ))),
        "subtractIntervals" => to_json(&subtract_intervals(
            field(input, "interval"),
            &field::<Vec<ActivityInterval>>(input, "holes"),
        )),
        "normalizeHostPattern" => {
            to_json(&normalize_host_pattern(&field::<String>(input, "input")))
        }
        "hostMatches" => to_json(&host_matches(
            &field::<String>(input, "pattern"),
            &field::<String>(input, "host"),
        )),
        "matchRule" => {
            let rules: Vec<ActivityRule> = field(input, "rules");
            let keys: Vec<String> = field(input, "keysByTime");
            to_json(&match_rule(&rules, &keys).map(|rule| rule.id.clone()))
        }
        "ruleProposal" => to_json(&rule_proposal(&field(input, "rule"))),
        "buildSuggestions" => {
            let segments: Vec<ActivitySegment> = field(input, "segments");
            let tracked: Vec<ActivityInterval> = field(input, "tracked");
            let rules: Vec<ActivityRule> = field(input, "rules");
            to_json(&build_suggestions(
                &segments,
                &tracked,
                &rules,
                optional(input, "options"),
            ))
        }
        "filingKeyOf" => to_json(&filing_key_of_fields(&field(input, "fields"))),
        "isFileable" => to_json(&is_fileable_fields(&field(input, "fields"))),
        "learnFilings" => {
            let segments: Vec<ActivitySegment> = field(input, "segments");
            let entries: Vec<LearnableEntry> = field(input, "entries");
            let mut learned: Vec<(String, AutopilotFiling)> =
                learn_filings(&segments, &entries, optional(input, "options"))
                    .into_iter()
                    .collect();
            learned.sort_by(|a, b| js::cmp_strings(&a.0, &b.0));
            to_json(&learned)
        }
        "createFilingResolver" => {
            let rules: Vec<ActivityRule> = field(input, "rules");
            let learned = learned_of(input);
            let apps: Vec<String> = field(input, "apps");
            let mut resolve = create_filing_resolver(&rules, &learned);
            to_json(&apps.iter().map(|app| resolve(app)).collect::<Vec<_>>())
        }
        "trailingRun" => {
            let pieces: Vec<LabelledPiece> = field(input, "pieces");
            let options = DEFAULT_AUTOPILOT_OPTIONS.with(field(input, "options"));
            to_json(&trailing_run(
                &pieces,
                field(input, "from"),
                field(input, "now"),
                &options,
            ))
        }
        "trailingStreak" => {
            let pieces: Vec<LabelledPiece> = field(input, "pieces");
            to_json(&trailing_streak(
                &pieces,
                field(input, "from"),
                field(input, "now"),
                field(input, "maxInterruptMs"),
            ))
        }
        "decideAutopilot" => {
            let segments: Vec<ActivitySegment> = field(input, "segments");
            let tracked: Vec<ActivityInterval> = field(input, "tracked");
            let rules: Vec<ActivityRule> = field(input, "rules");
            let learned = learned_of(input);
            let held: HashSet<String> = field::<Vec<String>>(input, "held").into_iter().collect();
            let mut resolve = create_filing_resolver(&rules, &learned);
            to_json(&decide_autopilot(AutopilotInput {
                now: field(input, "now"),
                segments: &segments,
                tracked: &tracked,
                running: field(input, "running"),
                resolve: &mut resolve,
                held: &held,
                options: optional(input, "options"),
            }))
        }
        "lastBreakEnd" | "hadBreakSince" => {
            let segments: Vec<ActivitySegment> = field(input, "segments");
            let (since, now, break_ms) = (
                field(input, "since"),
                field(input, "now"),
                field(input, "breakMs"),
            );
            if case.function == "lastBreakEnd" {
                to_json(&last_break_end(&segments, since, now, break_ms))
            } else {
                to_json(&had_break_since(&segments, since, now, break_ms))
            }
        }
        "defaults" => to_json(&DEFAULT_AUTOPILOT_OPTIONS),
        other => panic!("no Rust counterpart for {other}"),
    }
}

fn replay(file: &str) -> usize {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures")
        .join(file);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    let cases: Vec<Case> = serde_json::from_str(&text).expect("fixture parses");
    let mut failures = Vec::new();
    for (index, case) in cases.iter().enumerate() {
        let actual = run(case);
        if !same(&actual, &case.output) {
            failures.push(format!(
                "{file} #{index} {}\n  input:    {}\n  expected: {}\n  actual:   {}",
                case.function, case.input, case.output, actual
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} cases differ:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
    cases.len()
}

#[test]
fn segments_match_the_typescript() {
    assert!(replay("core-segments.json") > 100);
}

#[test]
fn rules_match_the_typescript() {
    assert!(replay("core-rules.json") > 100);
}

#[test]
fn suggestions_match_the_typescript() {
    assert!(replay("core-suggest.json") > 50);
}

#[test]
fn autopilot_matches_the_typescript() {
    assert!(replay("core-autopilot.json") > 500);
}
