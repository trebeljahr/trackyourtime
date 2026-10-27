import { PrivateAccountInventoryMissingError } from "@starter/core";
import { privateAccountInventoryStorageHost } from "./private-replica";
import { privateAccountWorkspaceInventorySync } from "./private-inventory-sync";
import { privateAccountId, privateDataOrigin, privateOperationScope, privateSession, privateSessionVersion, whenPrivateAccountReady } from "./private-session";
import { privateRoutingRequired } from "./private-routing-requirement";
import { standardDeviceAccess } from "./private-device-access";
export type PrivateDeviceAccessState = "unknown" | "standard" | "locked" | "inventory" | "ready";
/** Presentation readiness uses the same independently enrolled local inventory
 * as transport. A root unlock alone cannot mount business forms on a new device. */
export async function readPrivateDeviceAccessState(userId: string): Promise<PrivateDeviceAccessState> {
  if (await whenPrivateAccountReady() !== userId) throw new Error("The signed-in account changed");
  const scope = { server: privateDataOrigin(), userId }, captured = privateOperationScope(userId), version = privateSessionVersion();
  const check = () => { captured(); if (privateAccountId() !== userId || privateSessionVersion() !== version || privateDataOrigin() !== scope.server) throw new Error("Device access changed during this read"); };
  const required = await privateRoutingRequired(scope); check();
  if (!privateSession(userId)) {
    if (required) return "locked";
    const standard = await standardDeviceAccess(scope); check(); return standard ? "standard" : "unknown";
  }
  const host = await privateAccountInventoryStorageHost(userId);
  try {
    check(); const sync = await privateAccountWorkspaceInventorySync(userId, host.storage, host.exclusive); await sync.read(); check(); return "ready";
  } catch (error) { check(); if (error instanceof PrivateAccountInventoryMissingError) return "inventory"; throw error; }
  finally { host.close(); }
}
