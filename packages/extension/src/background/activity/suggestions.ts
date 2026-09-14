/**
 * Suggestions for one span of time, from what this device recorded.
 *
 * The tracked intervals come in from outside: fetching entries is network
 * work, and nothing under `background/activity/` may do any.
 */
import {
  buildSuggestions,
  type ActivityInterval,
  type ActivityRule,
  type ActivitySegment,
  type ActivitySuggestion,
} from "@starter/core/activity/index";
import { normalizeHostPattern } from "@starter/core/activity/index";
import { STALE_AFTER_MS } from "./capture";
import { loadActivityScope } from "./settings";
import {
  listDismissals,
  listRules,
  loadOpenSegment,
  putRule,
  deleteRule,
  addDismissal,
  readSegments,
} from "./store";

export type SuggestionRange = { from: number; to: number };

const clip = (segment: ActivitySegment, range: SuggestionRange): ActivitySegment | null => {
  const start = Math.max(segment.start, range.from);
  const end = Math.min(segment.end, range.to);
  return end > start ? { ...segment, start, end } : null;
};

/**
 * Untracked activity inside `range`, as suggestions.
 *
 * The open segment counts up to now (or up to its `lastSeen` when stale), so
 * the stretch the person is in the middle of is suggestible without waiting
 * for them to switch tabs.
 */
export async function suggestionsFor(
  scope: string,
  range: SuggestionRange,
  tracked: readonly ActivityInterval[],
  now: number,
): Promise<ActivitySuggestion[]> {
  const [stored, rules, dismissals, open] = await Promise.all([
    readSegments(scope, range.from, range.to),
    listRules(scope),
    listDismissals(scope),
    loadOpenSegment(),
  ]);

  const segments: ActivitySegment[] = stored.map(({ scope: _scope, ...segment }) => segment);
  if (open !== null && open.scope === scope) {
    const end = now - open.lastSeen > STALE_AFTER_MS ? open.lastSeen : now;
    segments.push({
      source: "browser",
      start: open.start,
      end,
      key: open.key,
      ...(open.label !== undefined ? { label: open.label } : {}),
      afk: false,
    });
  }

  const clipped = segments
    .map((segment) => clip(segment, range))
    .filter((segment): segment is ActivitySegment => segment !== null);

  return buildSuggestions(clipped, [...tracked, ...dismissals], rules);
}

export async function activityRules(scope: string): Promise<ActivityRule[]> {
  return listRules(scope);
}

/**
 * Hide a suggestion by recording its span as accounted for. Resolves false
 * when there is no scope to record it under.
 */
export async function dismissActivity(start: number, end: number): Promise<boolean> {
  const scope = await loadActivityScope();
  if (scope === null) return false;
  await addDismissal({ scope, start, end });
  return true;
}

export type NewActivityRule = Omit<ActivityRule, "id">;

/**
 * Add "always file <pattern> under …".
 *
 * A rule for a pattern that already has one replaces it rather than stacking
 * a second, because only the first match is ever used and a silently
 * shadowed rule is one nobody can explain.
 */
export async function addActivityRuleFor(input: NewActivityRule): Promise<boolean> {
  const scope = await loadActivityScope();
  if (scope === null) return false;
  const pattern = normalizeHostPattern(input.pattern);
  if (pattern === "") return false;

  const existing = (await listRules(scope)).filter((rule) => rule.pattern === pattern);
  for (const rule of existing) await deleteRule(scope, rule.id);

  const rule: ActivityRule = { ...input, id: crypto.randomUUID(), pattern };
  for (const key of Object.keys(rule) as (keyof ActivityRule)[]) {
    if (rule[key] === undefined) delete rule[key];
  }
  await putRule(scope, rule, Date.now());
  return true;
}

export async function removeActivityRuleFor(id: string): Promise<boolean> {
  const scope = await loadActivityScope();
  if (scope === null) return false;
  await deleteRule(scope, id);
  return true;
}
