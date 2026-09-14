// Minting, listing and revoking the credentials for the public REST API.
//
// Everything here is `workspaceProcedure`: a token belongs to one workspace,
// and the workspace it belongs to is the one the caller is currently resolved
// into — never one named on the input body.
//
// The workspace is only half the rule, and the half that was missing was the
// expensive one. WITHIN a workspace, a credential belongs to the person who
// minted it: every query here is scoped by `userId: ctx.user.id` as well as
// by the workspace, so a member neither sees nor can revoke a colleague's
// token. Scoping by workspace alone listed every member's token names and
// prefixes to everyone, and let any member kill a colleague's running
// integration — an availability attack that leaves no trace beyond a
// timestamp on somebody else's row.
//
// There is deliberately NO admin override, and no workspace-wide list:
//
//  - The need it would serve — "revoke the token of someone who left" — is
//    already served, and served better, by removing their membership.
//    `authenticateApiToken` resolves live membership on every request and
//    answers 401 `no_membership` without one, so a departed member's tokens
//    are dead the moment they are removed, whether or not anyone revokes
//    them one by one.
//  - Buying the override would cost a workspace-wide read, and a listed
//    token a caller does not own would have to be marked as foreign on the
//    wire for the UI not to offer actions the server refuses. No such flag
//    exists on `ApiTokenSummary`, and inventing an unmarked one is how a
//    settings screen ends up lying about whose credential a row is.
import { TRPCError } from "@trpc/server";
import mongoose from "mongoose";
import {
  createApiTokenSchema,
  revokeApiTokenSchema,
  type ApiTokenSummary,
  type CreatedApiToken,
  workspaceScopeSchema,
} from "@starter/shared";
import { ApiToken, toClientApiToken } from "../../models/ApiToken.js";
import { mintApiToken } from "../../auth/api-token.js";
import { isDuplicateKeyError } from "../../services/entries/errors.js";
import { publishSync } from "../../ws/sync.js";
import { router, workspaceProcedure } from "../trpc.js";

/**
 * How many times a collided prefix is re-rolled before giving up.
 *
 * The prefix is 48 bits, so a collision is a lottery win rather than a
 * scenario — but the index is unique, so an unhandled one would surface as a
 * raw duplicate-key 500 on somebody's very ordinary "create token" click.
 */
const MINT_ATTEMPTS = 3;

/**
 * How many live tokens one member may hold in one workspace.
 *
 * The per-token rate limit is only a limit while the number of tokens is
 * bounded: a member who can mint credentials in a loop gets the limiter's
 * budget once per token, which is no limiter at all. Twenty is far above any
 * honest use (one per script, one per CI job) and far below a useful
 * multiplier.
 *
 * Revoked and expired rows do not count. Neither can authenticate, so neither
 * buys any budget — and blocking someone whose twenty tokens all expired last
 * year would be a cap on history rather than on reach.
 */
export const MAX_LIVE_TOKENS_PER_MEMBER = 20;

const notFound = (): TRPCError =>
  new TRPCError({ code: "NOT_FOUND", message: "Token not found" });

/** The workspace-and-owner pair every query in this file is scoped by. */
export type OwnTokenFilter = {
  workspaceId: string;
  userId: string;
};

/** One specific token, addressable only by the member who minted it. */
export type OwnTokenByIdFilter = OwnTokenFilter & {
  _id: string;
  revokedAt: null;
};

/**
 * "The tokens that are mine, here."
 *
 * A function rather than an inline literal at each call site, because the
 * omission this prevents is exactly the kind that reads fine: `{ workspaceId }`
 * looks scoped, and is — to the wrong thing.
 */
export function ownTokenFilter(
  workspaceId: string,
  userId: string,
): OwnTokenFilter {
  return { workspaceId, userId };
}

/**
 * The filter `revoke` matches on.
 *
 * `userId` is what makes a colleague's id a miss rather than a kill, and
 * `revokedAt: null` keeps a second revoke from rewriting the timestamp of the
 * first — the answer to "when did this stop working?" must not move.
 */
export function revocableTokenFilter(
  id: string,
  workspaceId: string,
  userId: string,
): OwnTokenByIdFilter {
  return { _id: id, ...ownTokenFilter(workspaceId, userId), revokedAt: null };
}

/**
 * Ids arrive as untrusted strings. One that cannot address a document must
 * read as "missing", not as a 500 from a Mongo cast error.
 */
function requireTokenId(id: string): string {
  if (!mongoose.isValidObjectId(id)) throw notFound();
  return id;
}

export const apiTokensRouter = router({
  list: workspaceProcedure.input(workspaceScopeSchema).query(
    async ({ ctx }): Promise<ApiTokenSummary[]> => {
      const docs = await ApiToken.find(
        ownTokenFilter(ctx.workspaceId, ctx.user.id),
      )
        .sort({ createdAt: -1 })
        .lean();
      return docs.map(toClientApiToken);
    },
  ),

  /**
   * Mint a token. This response is the ONLY time the plaintext exists outside
   * the caller's own storage — only its sha256 is written, so there is no
   * later request, and no database dump, that can hand it back.
   */
  create: workspaceProcedure
    .input(createApiTokenSchema)
    .mutation(async ({ ctx, input }): Promise<CreatedApiToken> => {
      const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
      if (expiresAt && Number.isNaN(expiresAt.getTime())) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Invalid expiry date",
        });
      }

      // Counted per member, not per workspace: a cap on the workspace would
      // let one member exhaust everyone else's ability to mint. Two
      // simultaneous creates can both read 19 and both land — a cap that
      // overshoots by one is a guardrail doing its job, and paying for a
      // transaction to close that window would buy nothing an attacker cares
      // about.
      const live = await ApiToken.countDocuments({
        ...ownTokenFilter(ctx.workspaceId, ctx.user.id),
        revokedAt: null,
        $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
      });
      if (live >= MAX_LIVE_TOKENS_PER_MEMBER) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message:
            `You already have ${MAX_LIVE_TOKENS_PER_MEMBER} active API ` +
            `tokens. Revoke one before creating another.`,
        });
      }

      for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt += 1) {
        const minted = mintApiToken();
        try {
          const created = await ApiToken.create({
            workspaceId: ctx.workspaceId,
            userId: ctx.user.id,
            name: input.name.trim(),
            prefix: minted.prefix,
            tokenHash: minted.tokenHash,
            scopes: input.scopes,
            // The CEILING, frozen here. Every request ANDs it with the
            // member's live visibility, so revoking a permission narrows this
            // token on its next call and GRANTING one does not widen it —
            // that would be a privilege the user never re-authorised.
            grantedVisibility: {
              canViewOthersTime: ctx.visibility.canViewOthersTime,
              canViewOthersMoney: ctx.visibility.canViewOthersMoney,
            },
            expiresAt,
            lastUsedAt: null,
            revokedAt: null,
          });

          void publishSync(
            ctx.workspaceId,
            { kind: "integrations.changed", scope: "api-token" },
            input.originId,
          );
          return {
            token: toClientApiToken(created),
            plaintext: minted.plaintext,
          };
        } catch (error) {
          // Only a prefix collision is worth another roll; anything else is a
          // real failure and must not be retried into three identical writes.
          if (!isDuplicateKeyError(error)) throw error;
        }
      }

      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Could not generate a unique token. Please try again.",
      });
    }),

  /**
   * Revoke, never delete — and only your own.
   *
   * The row stays so the settings list can still say "this token existed and
   * was turned off on the 3rd" — a token that vanishes takes the answer to
   * "what was calling us until yesterday?" with it. Authentication checks
   * `revokedAt` before anything else it could have granted.
   *
   * A colleague's id answers NOT_FOUND rather than FORBIDDEN, the same rule
   * this codebase uses for every id outside the caller's reach: FORBIDDEN
   * would confirm the token exists, which is half of what an attacker
   * probing ids is after.
   */
  revoke: workspaceProcedure
    .input(revokeApiTokenSchema)
    .mutation(async ({ ctx, input }): Promise<{ id: string }> => {
      const updated = await ApiToken.findOneAndUpdate(
        revocableTokenFilter(
          requireTokenId(input.id),
          ctx.workspaceId,
          ctx.user.id,
        ),
        { $set: { revokedAt: new Date() } },
        { returnDocument: "after" },
      ).lean();
      if (!updated) throw notFound();

      void publishSync(
        ctx.workspaceId,
        { kind: "integrations.changed", scope: "api-token" },
        input.originId,
      );
      return { id: String(updated._id) };
    }),
});
