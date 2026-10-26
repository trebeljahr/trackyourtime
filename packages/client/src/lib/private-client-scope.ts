import { privateDataOrigin, privateOperationScope, privateSession, privateSessionVersion } from "./private-session";
/** Long-lived private handles retain an epoch and public scope, never root keys. */
export function privateClientScope(userId: string) {
  const server = privateDataOrigin(), version = privateSessionVersion(), captured = privateOperationScope(userId);
  const check = () => {
    captured();
    if (privateDataOrigin() !== server || privateSessionVersion() !== version || !privateSession(userId)) throw new Error("Private data changed during this operation");
  };
  const current = () => { try { check(); return true; } catch { return false; } };
  check(); return { server, userId, check, current };
}
