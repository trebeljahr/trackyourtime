/*
 * The bridge's activity types are structural copies of core's, because
 * `@starter/shared` cannot import `@starter/core`. These assertions make a
 * drift a `tsc` failure (`pnpm typecheck:electron`) rather than a rule that
 * silently stops matching on one side.
 */

import type {
  ActivityInterval,
  ActivityRule,
  AutopilotFiling,
  ProposedEntryFields,
} from "../../../packages/core/src/activity/index.ts";
import type {
  DesktopActivityInterval,
  DesktopActivityProposal,
  DesktopActivityRule,
  DesktopAutopilotFiling,
} from "../../../packages/shared/src/desktop-bridge.ts";

type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const ruleMatches: Exactly<ActivityRule, DesktopActivityRule> = true;
const intervalMatches: Exactly<ActivityInterval, DesktopActivityInterval> = true;
const proposalMatches: Exactly<ProposedEntryFields, DesktopActivityProposal> = true;
const filingMatches: Exactly<AutopilotFiling, DesktopAutopilotFiling> = true;

/** Referenced so the checks are not dead code to a bundler or a linter. */
export const WIRE_TYPES_MATCH: boolean = ruleMatches && intervalMatches && proposalMatches && filingMatches;
