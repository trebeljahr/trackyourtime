import { z } from "zod";
import { businessProfileProblems, clearBusinessLogoSchema, inspectBusinessLogoBytes, mergeIdentityInput, normalizeBusinessProfile, setBusinessLogoSchema, updateBusinessProfileSchema, type BusinessLogoRefusal, type BusinessProfileFields, type PrivateKind } from "@starter/shared";
import { privateBusinessProfileQuery } from "./business-profile-view.js";
import { privateViewSource, type PrivateViewOptions } from "./view-source.js";
import type { PlainPrivateRecord } from "./records.js";
const paths = ["settings.updateBusinessProfile", "settings.setBusinessLogo", "settings.clearBusinessLogo"] as const;
export type PrivateBusinessProfileEditPath = typeof paths[number];
export const isPrivateBusinessProfileEdit = (path: string): path is PrivateBusinessProfileEditPath => (paths as readonly string[]).includes(path);
export class PrivateBusinessLogoError extends Error {
  constructor(readonly refusal: BusinessLogoRefusal) { super(refusal); this.name = "PrivateBusinessLogoError"; }
}
export const PRIVATE_BUSINESS_PROFILE_EDIT_KINDS: readonly PrivateKind[] = ["businessProfile"];
/** Identity saves preserve omitted fields and unknown originals. Logo changes
 * never touch identity timestamps or reset an in-progress address draft. */
export async function privateBusinessProfileEdit(options: PrivateViewOptions & { path: PrivateBusinessProfileEditPath; input: unknown; now?: number; newId?: () => string }) {
  const source = privateViewSource(options), { check, ofKind } = source;
  if (!isPrivateBusinessProfileEdit(options.path)) throw new Error("Unsupported private business profile edit");
  if (source.actor.role === "member") throw new Error("Only an owner or admin can change the business profile");
  const frozen = structuredClone(options.input ?? {}), raw = z.record(z.string(), z.unknown()).parse(frozen), { workspaceId, ...input } = raw;
  if (workspaceId !== undefined && workspaceId !== options.scope.workspaceId) throw new Error("Private business profile edit belongs to another workspace");
  const args = (options.path === "settings.updateBusinessProfile" ? updateBusinessProfileSchema.strict() : options.path === "settings.setBusinessLogo" ? setBusinessLogoSchema.strict() : clearBusinessLogoSchema.strict()).parse(input);
  const current = await privateBusinessProfileQuery({ ...options, input: {} }); check();
  const prior = ofKind("businessProfile")[0];
  if (options.path === "settings.clearBusinessLogo" && (!prior || prior.value.logo == null)) return { records: [], result: current };
  const newId = prior?.id ?? z.uuid().parse((options.newId ?? (() => crypto.randomUUID()))());
  const body: Record<string, unknown> = prior ? { ...prior.value } : { _id: newId, workspaceId: options.scope.workspaceId };
  if (options.path === "settings.updateBusinessProfile") {
    const { workspaceId: _workspace, logo: _logo, updatedAt: _updated, ...stored } = current; void _workspace; void _logo; void _updated;
    const { originId: _origin, ...fields } = args; void _origin;
    const merged = mergeIdentityInput<BusinessProfileFields>(stored, fields as BusinessProfileFields), [problem] = businessProfileProblems(merged, false);
    if (problem) throw new Error(problem.message);
    const stamp = new Date(options.now ?? Date.now()).toISOString();
    Object.assign(body, normalizeBusinessProfile(merged), { updatedAt: stamp }); if (!prior) body.createdAt = stamp;
  } else if (options.path === "settings.setBusinessLogo") {
    const logo = setBusinessLogoSchema.parse(args), text = atob(logo.base64);
    if (btoa(text) !== logo.base64) throw new Error("Business logo binary is not canonical");
    const bytes = Uint8Array.from(text, c => c.charCodeAt(0)), inspected = inspectBusinessLogoBytes(bytes, logo.mime);
    if (!inspected.ok) throw new PrivateBusinessLogoError(inspected.refusal);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)); check();
    body.logo = { ...inspected.logo, data: { $binary: { base64: logo.base64, subType: "00" } }, sha256: Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("") };
  } else delete body.logo;
  const record: PlainPrivateRecord = { kind: "businessProfile", id: newId, authorId: null, value: body };
  const result = await privateBusinessProfileQuery({ ...options, records: [record], input: {} }); check();
  return { records: [record], result };
}
