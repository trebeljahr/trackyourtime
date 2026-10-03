// Report routes.
//
// Reports are money end to end — every one of them carries an `amount`, and
// the summary and weekly grids carry nothing BUT totals. There is no useful
// projection of a total: stripping the rate off the rows underneath it leaves
// a number that still looks like earnings and is now wrong, and zeroing it
// leaves a page of honest-looking zeros that a spreadsheet will happily sum.
//
// So this layer REFUSES instead. See `requireMoneyVisibility` for exactly
// when, and why the common case is still allowed.
import {
  detailedReportSchema,
  projectDetailedEntry,
  summaryReportSchema,
  weeklyReportSchema,
  type Visibility,
} from "@starter/shared";
import {
  buildDetailed,
  buildSummary,
  buildWeekly,
} from "../../../trpc/routers/reports.js";
import { scopeFromApiToken } from "../../../services/scope.js";
import type { ApiHandlers } from "../auth.js";
import { sendData } from "../envelope.js";
import { coerceQuery, parseWith } from "../query.js";
import { moneyVisibilityProblem } from "../problem.js";

/**
 * When a report may be served.
 *
 * Two of the three combinations are fine and the third is refused:
 *
 *  - `canViewOthersTime` off — the rows are author-only whatever the money
 *    flag says, so every amount in the report is the caller's own earnings.
 *    Allowed.
 *  - both on — the caller may see colleagues' time AND their money. Allowed.
 *  - time on, money off — the report would span colleagues' entries while the
 *    caller may not see what they are worth. There is no honest number to put
 *    in `totalAmount`, so the request is refused rather than answered wrongly.
 *
 * This deliberately does NOT change the tRPC path. `canViewOthersMoney` has no
 * enforcement in `reports.ts` today; fixing that is a separate change with its
 * own blast radius. What this must not do is EXTEND the gap onto a brand-new
 * surface, which is what serving it here unfiltered would be.
 *
 * Exported because `GET /entries` serves rows carrying the same `amount` and
 * therefore owes the same answer — one predicate and one wording, so the two
 * surfaces cannot come to disagree about when money may be shown.
 */
export function requireMoneyVisibility(visibility: Visibility): void {
  if (visibility.canViewOthersTime && !visibility.canViewOthersMoney) {
    throw moneyVisibilityProblem();
  }
}

export const reportHandlers: ApiHandlers = {
  "get /reports/summary": async (req, res) => {
    const scope = scopeFromApiToken(req.apiToken);
    requireMoneyVisibility(scope.visibility);
    const input = parseWith(
      summaryReportSchema,
      coerceQuery(req.apiQuery, summaryReportSchema),
    );
    sendData(res, await buildSummary(scope, input, input.groupBy));
  },

  "get /reports/detailed": async (req, res) => {
    const scope = scopeFromApiToken(req.apiToken);
    requireMoneyVisibility(scope.visibility);
    const input = parseWith(
      detailedReportSchema,
      coerceQuery(req.apiQuery, detailedReportSchema),
    );
    const result = await buildDetailed(scope, input, {
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.limit ? { limit: input.limit } : {}),
    });

    // Belt and braces on top of the refusal above: by the time a row reaches
    // here the caller either owns it or may see its money, so this strips
    // nothing today. It is what keeps the guarantee true if the refusal is
    // ever relaxed.
    const rows = result.entries
      .map((entry) => projectDetailedEntry(entry, scope.visibility))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    // A list envelope, with the range totals alongside it. `nextCursor` is
    // always present and null on the last page — see `sendList`.
    res.status(200).json({
      data: rows,
      nextCursor: result.nextCursor ?? null,
      totalSec: result.totalSec,
      totalAmount: result.totalAmount,
      totalAmounts: result.totalAmounts,
      currency: result.currency,
    });
  },

  "get /reports/weekly": async (req, res) => {
    const scope = scopeFromApiToken(req.apiToken);
    requireMoneyVisibility(scope.visibility);
    const input = parseWith(
      weeklyReportSchema,
      coerceQuery(req.apiQuery, weeklyReportSchema),
    );
    sendData(res, await buildWeekly(scope, input, input.weekStart));
  },
};
