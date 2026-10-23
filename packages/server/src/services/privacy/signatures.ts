import type { PublicKey } from "@starter/core";
import { webcrypto } from "node:crypto";
import { TRPCError } from "@trpc/server";
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)]));
  return value;
}
/** A reset login cannot replace recovery keys without the existing private key. */
export async function verifyPrivateChange(publicKey: PublicKey, value: unknown, signature: string): Promise<void> {
  try {
    const key = await webcrypto.subtle.importKey("jwk", publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const valid = await webcrypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, Buffer.from(signature, "base64url"), new TextEncoder().encode(JSON.stringify(canonical(value))));
    if (valid) return;
  } catch { /* One refusal, independent of which signature component failed. */ }
  throw new TRPCError({ code: "FORBIDDEN", message: "Private-data unlock is required for this change." });
}
