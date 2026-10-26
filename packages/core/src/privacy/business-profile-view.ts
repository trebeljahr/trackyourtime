import { z } from "zod";
import { BUSINESS_LOGO_MAX_BASE64_LENGTH, emptyBusinessProfile, imageDataUrl, inspectBusinessLogoBytes, normalizeBusinessProfile, updateBusinessProfileSchema, type BusinessLogo, type BusinessProfile } from "@starter/shared";
import { privateViewSource, type PrivateViewOptions } from "./view-source.js";
const fieldsSchema = z.object(updateBusinessProfileSchema.shape).omit({ originId: true });
const id = z.string().min(1).max(100), instant = z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString());
/** Decode canonical BSON binary only. Limits and actual header dimensions
 * match server uploads; MIME, pixel claims and a stored hash are not trusted. */
export async function privateStoredBusinessLogo(input: unknown): Promise<BusinessLogo | null> {
  if (input === null || input === undefined) return null;
  const row = z.object({ mime: z.enum(["image/png", "image/jpeg"]), width: z.number().int().positive(), height: z.number().int().positive(), sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(), data: z.object({ $binary: z.object({ base64: z.string().min(4).max(BUSINESS_LOGO_MAX_BASE64_LENGTH).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/), subType: z.literal("00") }).strict() }).strict() }).parse(input);
  const base64 = row.data.$binary.base64, text = atob(base64);
  if (btoa(text) !== base64) throw new Error("Private logo binary is not canonical");
  const bytes = Uint8Array.from(text, (value) => value.charCodeAt(0)), inspected = inspectBusinessLogoBytes(bytes, row.mime);
  if (!inspected.ok || inspected.logo.width !== row.width || inspected.logo.height !== row.height) throw new Error("Private business logo dimensions or format differ from its bytes");
  if (row.sha256) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const hex = Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
    if (hex !== row.sha256.toLowerCase()) throw new Error("Private business logo bytes differ from their saved hash");
  }
  return { dataUrl: imageDataUrl({ mime: row.mime, base64 }), width: row.width, height: row.height };
}
export async function privateBusinessProfileQuery(options: PrivateViewOptions & { input: unknown }): Promise<BusinessProfile> {
  const source = privateViewSource(options), { scope } = options;
  if (source.actor.role === "member" && !source.visibility.canViewOthersMoney) throw new Error("Your workspace role cannot see the business profile");
  const input = z.object({ workspaceId: id.optional() }).strict().parse(options.input ?? {});
  if (input.workspaceId !== undefined && input.workspaceId !== scope.workspaceId) throw new Error("Private business profile filter belongs to another workspace");
  const rows = source.ofKind("businessProfile"); if (rows.length > 1) throw new Error("Private business profile is ambiguous");
  if (!rows.length) { source.check(); return emptyBusinessProfile(scope.workspaceId); }
  if (rows[0]!.authorId !== null) throw new Error("Private business profile has an invalid author");
  const raw = source.value(rows[0]!), fields = fieldsSchema.parse(raw), logo = await privateStoredBusinessLogo(raw.logo); source.check();
  return { workspaceId: scope.workspaceId, ...normalizeBusinessProfile(fields), logo, updatedAt: raw.updatedAt == null ? null : instant.parse(raw.updatedAt) };
}
