/**
 * One-time backfill: mark every account that existed before email
 * verification was switched on as verified.
 *
 *   pnpm --filter @starter/server run backfill:email-verified -- --before 2026-09-14T12:00:00Z
 *
 * Why it exists: `auth/auth.ts` sets `requireEmailVerification` whenever a
 * mail transport is configured. better-auth then refuses a password sign-in
 * from any user whose `emailVerified` is not `true` — and every account made
 * while verification was off has `false`. Without this, the first deploy with
 * mail configured would send every existing user a verification link instead
 * of letting them in.
 *
 * `--before` is the cutoff: accounts created before it are marked verified,
 * accounts created after it verify themselves. It defaults to "now", which is
 * right when the script runs straight after the deploy. Accounts that signed
 * up after the deploy but before the script ran are also marked verified by
 * that default; pass the deploy time to exclude them.
 *
 * It is idempotent: the filter only matches accounts that are not verified
 * yet, so a re-run changes nothing and reports 0. It never un-verifies.
 */
import { pathToFileURL } from "node:url";

type Where = { field: string; value: unknown; operator?: "ne" | "lt" }[];

/** The two adapter calls the backfill needs — better-auth's adapter satisfies both. */
export type BackfillAdapter = {
  count: (args: { model: string; where: Where }) => Promise<number>;
  updateMany: (args: {
    model: string;
    where: Where;
    update: Record<string, unknown>;
  }) => Promise<unknown>;
};

/** Mark unverified accounts created before `before` as verified. Returns the count. */
export async function backfillEmailVerified(
  adapter: BackfillAdapter,
  before: Date,
): Promise<number> {
  const where: Where = [
    { field: "emailVerified", operator: "ne", value: true },
    { field: "createdAt", operator: "lt", value: before },
  ];
  // Counted rather than read off updateMany, whose return value differs per
  // adapter (a modified count on Mongo, a row in memory).
  const pending = await adapter.count({ model: "user", where });
  if (pending === 0) return 0;
  await adapter.updateMany({ model: "user", where, update: { emailVerified: true } });
  return pending;
}

/** `--before <ISO date>`, or now. */
export function parseCutoff(argv: readonly string[], now = new Date()): Date {
  const index = argv.indexOf("--before");
  if (index === -1) return now;
  const value = argv[index + 1];
  const parsed = value ? new Date(value) : new Date(Number.NaN);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`--before needs an ISO date, got ${value ?? "nothing"}`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const before = parseCutoff(process.argv.slice(2));
  const { default: mongoose } = await import("mongoose");
  const { env } = await import("../config/env.js");
  const { initAuth, getAuth, disconnectAuth } = await import("../auth/auth.js");

  await mongoose.connect(env.MONGODB_URI);
  await initAuth();
  try {
    const context = await getAuth().$context;
    const count = await backfillEmailVerified(context.adapter, before);
    console.log(
      `[backfill:email-verified] marked ${count} account(s) created before ${before.toISOString()} as verified`,
    );
  } finally {
    await disconnectAuth();
    await mongoose.disconnect();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error("[backfill:email-verified] failed:", error);
    process.exitCode = 1;
  });
}
