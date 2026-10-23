import { installStorageQuota } from "../services/storage-quota.js";
// A credential for the public REST API, bound to ONE workspace.
//
// Nothing here can reproduce the token: only `sha256(plaintext)` is stored,
// and the plaintext is returned exactly once, from `apiTokens.create`. Losing
// it means minting a new one, which is the point — a token that could be
// re-read from the database is a token that a database leak hands out.
import mongoose, { Schema, type Document } from "mongoose";
import type { ApiTokenScope, ApiTokenSummary, VisibilityGrant } from "@starter/shared";

export interface IApiToken extends Document {
  workspaceId: string;
  /** The member who minted it. The token acts as this person, never wider. */
  userId: string;
  name: string;
  /** Non-secret, displayed, and the unique key every lookup goes through. */
  prefix: string;
  /** sha256 of the WHOLE plaintext, hex. Never the secret half alone. */
  tokenHash: string;
  scopes: ApiTokenScope[];
  grantedVisibility: VisibilityGrant;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ApiTokenDocLike = {
  _id?: unknown;
  workspaceId: string;
  userId: string;
  name: string;
  prefix: string;
  scopes?: ApiTokenScope[] | null;
  grantedVisibility?: VisibilityGrant | null;
  expiresAt?: Date | null;
  lastUsedAt?: Date | null;
  revokedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const apiTokenSchema = new Schema<IApiToken>(
  {
    workspaceId: { type: String, required: true },
    userId: { type: String, required: true },
    name: { type: String, required: true, maxlength: 120, trim: true },
    // `unique` here already declares the index; a second `index: true` would
    // make mongoose warn about a duplicate.
    prefix: { type: String, required: true, unique: true },
    tokenHash: { type: String, required: true },
    // NOT `required`. An array field that is required fails validation on
    // every document written before the field existed, the next time anything
    // saves one — the same trap `TimeEntry.tagIds` and `createdBy` are marked
    // with. An absent list reads as "no scopes", which grants nothing.
    scopes: { type: [String], default: [] },
    /**
     * The visibility its creator had when they minted it — a CEILING, not a
     * snapshot to serve from. Every request intersects it with the member's
     * live visibility (`narrowVisibility`), so a later demotion narrows the
     * token on the next call and a later grant does not widen it at all.
     */
    grantedVisibility: {
      type: new Schema<VisibilityGrant>(
        {
          canViewOthersTime: { type: Boolean, required: true, default: false },
          canViewOthersMoney: { type: Boolean, required: true, default: false },
        },
        { _id: false },
      ),
      default: () => ({ canViewOthersTime: false, canViewOthersMoney: false }),
    },
    expiresAt: { type: Date, default: null },
    lastUsedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

/** The settings list: this workspace's tokens, newest first. */
apiTokenSchema.index({ workspaceId: 1, createdAt: -1 });

export const ApiToken = mongoose.model<IApiToken>("ApiToken", apiTokenSchema);

/** Convert an ApiToken document into the exact wire shape — never the hash. */
export function toClientApiToken(doc: ApiTokenDocLike): ApiTokenSummary {
  return {
    id: String(doc._id),
    name: doc.name,
    prefix: doc.prefix,
    scopes: doc.scopes ?? [],
    expiresAt: doc.expiresAt ? doc.expiresAt.toISOString() : null,
    lastUsedAt: doc.lastUsedAt ? doc.lastUsedAt.toISOString() : null,
    revokedAt: doc.revokedAt ? doc.revokedAt.toISOString() : null,
    createdAt: doc.createdAt.toISOString(),
  };
}

installStorageQuota(ApiToken);
