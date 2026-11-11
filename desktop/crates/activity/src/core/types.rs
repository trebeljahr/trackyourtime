//! Captured activity, and the entries it suggests (`packages/core/src/activity/types.ts`).
//!
//! Host-free on purpose: the browser extension is the first capturer, and the
//! desktop shell feeds the same functions with its own detector. Nothing here
//! reads a clock, a zone, a DOM or a network — every instant is an epoch
//! millisecond count supplied by the caller, which is what keeps a suggestion
//! built on one device identical to the one built from the same rows on
//! another, and what makes a DST change a non-event.
//!
//! Instants are `f64`, exactly as in JavaScript, so arithmetic on them gives
//! the same results as the TypeScript the extension keeps running.
//!
//! The rule, proposal, interval and filing types ARE the bridge's types
//! (`tyt_wire`), not copies: `electron/src/activity/wire.ts` existed to keep
//! the two in step, and an alias cannot drift.

use serde::{Deserialize, Serialize};

pub use tyt_wire::DesktopActivityInterval as ActivityInterval;
pub use tyt_wire::DesktopActivityProposal as ProposedEntryFields;
pub use tyt_wire::DesktopActivityRule as ActivityRule;
pub use tyt_wire::DesktopAutopilotFiling as AutopilotFiling;
pub use tyt_wire::DesktopAutopilotHistoryEntry as LearnableEntry;
pub use tyt_wire::DesktopFilingVia as AutopilotFilingSource;

/// Which kind of detector produced a segment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ActivitySource {
    Browser,
    Desktop,
}

/// One uninterrupted stretch of attention on one thing.
///
/// `key` is what the time is attributed to: a hostname for the browser, an
/// application id for a desktop capturer. `label` is the optional detail (a
/// page or window title) that capturers store only when the person opted in.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySegment {
    pub source: ActivitySource,
    /// Epoch ms, inclusive.
    pub start: f64,
    /// Epoch ms, exclusive. Never before `start`.
    pub end: f64,
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// True for a stretch the detector knows the person was away for.
    pub afk: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityKeyShare {
    pub key: String,
    /// Whole seconds attributed to this key inside the block.
    pub seconds: f64,
    /// `seconds` over the block's attributed total, 0..1.
    pub share: f64,
}

/// One untracked stretch of activity, offered to be turned into an entry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySuggestion {
    /// Epoch ms of the first recorded activity in the block.
    pub start: f64,
    /// Epoch ms of the end of the last recorded activity in the block.
    pub end: f64,
    /// Most time first; ties by key, so the order is stable.
    pub top_keys: Vec<ActivityKeyShare>,
    /// The id of the rule that filled `proposed`, when one matched.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rule_id: Option<String>,
    pub proposed: ProposedEntryFields,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildSuggestionsOptions {
    /// Two stretches further apart than this become two blocks. Default 10.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gap_minutes: Option<f64>,
    /// A block with less activity than this is dropped. Default 5.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_minutes: Option<f64>,
    /// How many keys `topKeys` carries at most. Default 5.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_keys: Option<f64>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeSegmentsOptions {
    /// Two same-key segments this close together are one segment. Default
    /// 60 s — a capturer that closes and reopens a segment on every heartbeat
    /// or tab reload would otherwise produce a row per minute.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pulse_gap_ms: Option<f64>,
}

/// An insertion-ordered map, for the places the TypeScript iterates a `Map`
/// in insertion order and the order reaches a result (a sum, a tie). Small:
/// a block has a handful of keys, a bucket a handful of labels.
#[derive(Debug, Clone)]
pub struct OrderedMap<V> {
    entries: Vec<(String, V)>,
}

impl<V> Default for OrderedMap<V> {
    fn default() -> Self {
        OrderedMap {
            entries: Vec::new(),
        }
    }
}

impl<V> OrderedMap<V> {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, key: &str) -> Option<&V> {
        self.entries.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut V> {
        self.entries
            .iter_mut()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v)
    }

    /// `map.set(key, value)`: replaces in place, or appends.
    pub fn set(&mut self, key: &str, value: V) {
        match self.get_mut(key) {
            Some(slot) => *slot = value,
            None => self.entries.push((key.to_string(), value)),
        }
    }

    pub fn entry_or(&mut self, key: &str, make: impl FnOnce() -> V) -> &mut V {
        if let Some(index) = self.entries.iter().position(|(k, _)| k == key) {
            return &mut self.entries[index].1;
        }
        self.entries.push((key.to_string(), make()));
        &mut self.entries.last_mut().expect("just pushed").1
    }

    pub fn iter(&self) -> impl Iterator<Item = (&String, &V)> {
        self.entries.iter().map(|(k, v)| (k, v))
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}
