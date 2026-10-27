import { getNativeTokenRevision } from "./native-session";
import { privateAccountId, privateDataOrigin, privateSessionVersion } from "./private-session";
import { PrivateContentUnavailableError } from "./private-content-error";

/** Local-only provenance, captured before any readiness wait. No credential,
 * content or key is serialized. The fetch boundary removes this header. */
export const LOCAL_REQUEST_SCOPE_HEADER = "x-trackyourtime-local-scope";
export type PrivateRequestScope = Readonly<{ server: string; userId: string; version: number; tokenRevision: number }>;
export function capturePrivateRequestScope(): PrivateRequestScope {
  const userId = privateAccountId();
  if (!userId) throw new PrivateContentUnavailableError("Resolve the signed-in account before sending workspace data");
  return Object.freeze({ server: privateDataOrigin(), userId, version: privateSessionVersion(), tokenRevision: getNativeTokenRevision() });
}
export function checkPrivateRequestScope(value: unknown): void {
  if (!value || typeof value !== "object") throw new PrivateContentUnavailableError("The original workspace request could not be verified");
  const scope = value as PrivateRequestScope;
  if (typeof scope.userId !== "string" || !scope.userId || scope.userId !== privateAccountId() || scope.server !== privateDataOrigin() || scope.version !== privateSessionVersion() || scope.tokenRevision !== getNativeTokenRevision()) {
    throw new PrivateContentUnavailableError("The account or server changed before workspace data could be sent");
  }
}
export function privateRequestScopeHeaders(opList?: readonly { context: Record<string, unknown> }[]) {
  if (!opList?.some((op) => op.context.privateContentScope || op.context.privateCreationScope)) return {};
  return { [LOCAL_REQUEST_SCOPE_HEADER]: JSON.stringify(opList.map((op) => [op.context.privateContentScope ?? null, op.context.privateCreationScope ?? null])) };
}
export function consumePrivateRequestScopes(init: RequestInit | undefined, count: number): unknown[][] | null {
  const headers = new Headers(init?.headers), raw = headers.get(LOCAL_REQUEST_SCOPE_HEADER);
  headers.delete(LOCAL_REQUEST_SCOPE_HEADER);
  if (init) init.headers = headers;
  if (raw === null) return null;
  try {
    if (raw.length > 1024 * 1024) throw new Error();
    const values: unknown = JSON.parse(raw);
    if (!Array.isArray(values) || values.length !== count || values.some((value) => !Array.isArray(value) || value.length !== 2)) throw new Error();
    return values;
  } catch { throw new PrivateContentUnavailableError("The original workspace request could not be verified"); }
}
