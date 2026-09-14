// The only I/O in services/einvoice: reading today's profile and client for
// the check and the fill. Every query is scoped by workspaceId, so a client of
// another workspace reads exactly like a missing one.
import mongoose from "mongoose";
import { normalizeClientBilling } from "@starter/shared";
import { getBusinessProfile } from "../../models/BusinessProfile.js";
import { Client } from "../../models/Client.js";
import type { FillSources } from "./fill.js";

/**
 * Today's business profile, and the client's billing details — `client` is
 * null when the client was deleted since the invoice was made, which fills
 * nothing on the recipient side.
 */
export async function loadFillSources(workspaceId: string, clientId: string): Promise<FillSources> {
  const [profile, client] = await Promise.all([
    getBusinessProfile(workspaceId),
    mongoose.isValidObjectId(clientId)
      ? Client.findOne({ _id: clientId, workspaceId }).select("billing").lean()
      : Promise.resolve(null),
  ]);
  const { workspaceId: _workspace, updatedAt: _updated, ...values } = profile;
  return {
    profile: values,
    client: client ? { billing: normalizeClientBilling(client.billing) } : null,
  };
}
