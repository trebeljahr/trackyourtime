import { displayPreferencesSchema, REQUIRES_API_LEVEL, type UserPreferences } from "@starter/shared";
import { PRIVATE_ACCOUNT_INVENTORY_SCOPE } from "@starter/core";
import { privateClientScope } from "./private-client-scope";
import { privateAccountInventoryStorageHost } from "./private-replica";
import { privateWorkspaceStorage } from "./private-session";
import { privateScopedRpc } from "./private-scoped-rpc";
import { currentServerApiLevel } from "./server-level";
const KEY = "account-display-preferences";
import { privateMetadataNetworkFailure } from "./private-metadata-network";
/** Account preferences remain ordinary account metadata on the server. Their
 * device copy is encrypted; this read never asks for workspace settings/money.
 * Cached rendering preferences grant no workspace or device authorization. */
export async function privateDisplayPreferences(userId: string): Promise<UserPreferences> {
  const binding = privateClientScope(userId), host = await privateAccountInventoryStorageHost(userId);
  try {
    const storage = await privateWorkspaceStorage(userId, PRIVATE_ACCOUNT_INVENTORY_SCOPE, host.storage); binding.check();
    const validate = (input: unknown) => { const row = displayPreferencesSchema.parse(input); if (row.userId !== userId) throw new Error("Display preferences belong to another account"); return row; };
    const cached = await host.exclusive(async () => { const raw = await storage.getItem(KEY); binding.check(); return raw === null ? null : validate(JSON.parse(raw)); }); binding.check();
    const level = currentServerApiLevel();
    if (typeof level !== "number" || !Number.isSafeInteger(level) || level < REQUIRES_API_LEVEL["profile.displayPreferences"]) {
      if (cached) return cached;
      throw new Error("Confirm this server supports separate account preferences before opening private settings");
    }
    const { rpc, supported } = privateScopedRpc(userId, "profile.displayPreferences");
    let raw;
    try { supported(); raw = await rpc.profile.displayPreferences.query(); supported(); }
    catch (error) { binding.check(); if (cached && privateMetadataNetworkFailure(error)) return cached; throw error; }
    const next = validate(raw); binding.check();
    await host.exclusive(async () => { binding.check(); await storage.setItem(KEY, JSON.stringify(next)); binding.check(); }); binding.check(); return next;
  } finally { host.close(); }
}
