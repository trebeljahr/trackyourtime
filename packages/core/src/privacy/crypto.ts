/** Portable, authenticated encryption. Secrets never pass through the server API. */
export type Ciphertext = { v: 1; nonce: string; data: string };
export type PasswordCiphertext = { v: 1; kdf: "PBKDF2-SHA256"; iterations: 600000; salt: string; box: Ciphertext };
export type PublicKey = { kty: "EC"; crv: "P-256"; x: string; y: string; d?: string; ext?: boolean; key_ops?: string[] };
export type RecipientBox = { v: 1; ephemeral: PublicKey; box: Ciphertext };
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
export const randomSecret = (): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(32));
export function encodeSecret(bytes: Uint8Array): string {
  let text = ""; for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function decodeSecret(text: string, maxBytes = 32 * 1024 * 1024): Uint8Array<ArrayBuffer> {
  if (typeof text !== "string" || text.length > Math.ceil(maxBytes * 4 / 3) + 4 || !/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("Invalid encrypted data");
  const raw = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  if (raw.length > maxBytes) throw new Error("Encrypted data is too large");
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
const bytes = (data: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(data);
async function aes(secret: Uint8Array): Promise<CryptoKey> {
  if (secret.length !== 32) throw new Error("Invalid encryption key");
  return crypto.subtle.importKey("raw", bytes(secret), "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function seal(secret: Uint8Array, value: unknown, context: string): Promise<Ciphertext> {
  if (!context) throw new Error("Encryption context required");
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: encoder.encode(context), tagLength: 128 }, await aes(secret), encoder.encode(JSON.stringify(value)));
  return { v: 1, nonce: encodeSecret(nonce), data: encodeSecret(new Uint8Array(data)) };
}
export async function unseal<T>(secret: Uint8Array, box: Ciphertext, context: string): Promise<T> {
  if (!context || box?.v !== 1) throw new Error("Unsupported encrypted data");
  const nonce = decodeSecret(box.nonce, 12);
  if (nonce.length !== 12) throw new Error("Invalid encrypted data");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: encoder.encode(context), tagLength: 128 }, await aes(secret), decodeSecret(box.data));
  return JSON.parse(decoder.decode(plain)) as T;
}
export async function deriveSecret(secret: Uint8Array, context: string): Promise<Uint8Array<ArrayBuffer>> {
  if (secret.length !== 32 || !context) throw new Error("A 256-bit secret and derivation context are required");
  const key = await crypto.subtle.importKey("raw", bytes(secret), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: encoder.encode("trackyourtime-privacy-v1"), info: encoder.encode(context) }, key, 256));
}
async function passwordKey(password: string, salt: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  if (password.length < 12 || password.length > 1024) throw new Error("Use a backup password of at least 12 characters");
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: bytes(salt), iterations: 600000 }, key, 256));
}
/** Account password KDF parameters. The salt is random per account and stored by
 * the server; the server hands it out before sign-in, so it is public. */
export type PasswordKdf = { v: 1; kdf: "PBKDF2-SHA256"; iterations: 600000; salt: string };
export function newPasswordKdf(): PasswordKdf {
  return { v: 1, kdf: "PBKDF2-SHA256", iterations: 600000, salt: encodeSecret(crypto.getRandomValues(new Uint8Array(16))) };
}
/** Prefix that marks a derived login secret, so it never looks like a typed password. */
export const LOGIN_SECRET_PREFIX = "tyt1.";
/**
 * Turn the account password into two independent values on the device:
 * `loginSecret` is what the server receives as the "password" (it stores only
 * its own hash of it), and `wrappingKey` encrypts the account's private keys
 * and never leaves the device. Knowing the login secret does not reveal the
 * wrapping key: both are separate HKDF outputs of the PBKDF2 result.
 */
export async function derivePasswordKeys(password: string, kdf: PasswordKdf): Promise<{ loginSecret: string; wrappingKey: Uint8Array<ArrayBuffer> }> {
  if (kdf?.v !== 1 || kdf.kdf !== "PBKDF2-SHA256" || kdf.iterations !== 600000) throw new Error("Unsupported password key parameters");
  const salt = decodeSecret(kdf.salt, 16);
  if (salt.length !== 16) throw new Error("Invalid password salt");
  const normalized = typeof password === "string" ? password.normalize("NFC") : "";
  if (normalized.length < 1 || normalized.length > 1024) throw new Error("Password must be 1 to 1024 characters");
  const key = await crypto.subtle.importKey("raw", encoder.encode(normalized), "PBKDF2", false, ["deriveBits"]);
  const master = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: bytes(salt), iterations: 600000 }, key, 256));
  try {
    const login = await deriveSecret(master, "trackyourtime-login-secret-v1");
    try { return { loginSecret: LOGIN_SECRET_PREFIX + encodeSecret(login), wrappingKey: await deriveSecret(master, "trackyourtime-password-wrap-v1") }; }
    finally { login.fill(0); }
  } finally { master.fill(0); }
}
export async function encryptBackup(value: unknown, password: string): Promise<PasswordCiphertext> {
  if (encoder.encode(JSON.stringify(value)).length > 24 * 1024 * 1024) throw new Error("Backup exceeds the supported 24 MiB plaintext limit");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await passwordKey(password, salt);
  try { return { v: 1, kdf: "PBKDF2-SHA256", iterations: 600000, salt: encodeSecret(salt), box: await seal(key, value, "trackyourtime-password-backup-v1") }; }
  finally { key.fill(0); }
}
export async function decryptBackup<T>(box: PasswordCiphertext, password: string): Promise<T> {
  if (box?.v !== 1 || box.kdf !== "PBKDF2-SHA256" || box.iterations !== 600000) throw new Error("Unsupported backup format");
  const salt = decodeSecret(box.salt, 16);
  if (salt.length !== 16) throw new Error("Invalid backup salt");
  const key = await passwordKey(password, salt);
  try { return await unseal<T>(key, box.box, "trackyourtime-password-backup-v1"); } finally { key.fill(0); }
}
export async function createKeyPair(): Promise<{ publicKey: PublicKey; privateKey: PublicKey }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  return { publicKey: await crypto.subtle.exportKey("jwk", pair.publicKey) as PublicKey, privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey) as PublicKey };
}
async function agreement(privateKey: PublicKey, publicKey: PublicKey, context: string): Promise<Uint8Array<ArrayBuffer>> {
  const own = await crypto.subtle.importKey("jwk", privateKey, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const other = await crypto.subtle.importKey("jwk", publicKey, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: other }, own, 256));
  try { return await deriveSecret(secret, context); } finally { secret.fill(0); }
}
export async function sealForRecipient(publicKey: PublicKey, value: unknown, context: string): Promise<RecipientBox> {
  const pair = await createKeyPair();
  const key = await agreement(pair.privateKey, publicKey, context);
  try { return { v: 1, ephemeral: pair.publicKey, box: await seal(key, value, context) }; } finally { key.fill(0); }
}
export async function unsealForRecipient<T>(privateKey: PublicKey, envelope: RecipientBox, context: string): Promise<T> {
  if (envelope.v !== 1) throw new Error("Unsupported recipient envelope");
  const key = await agreement(privateKey, envelope.ephemeral, context);
  try { return await unseal<T>(key, envelope.box, context); } finally { key.fill(0); }
}
export async function fingerprint(publicKey: PublicKey): Promise<string> {
  const canonical = JSON.stringify({ crv: publicKey.crv, kty: publicKey.kty, x: publicKey.x, y: publicKey.y });
  return encodeSecret(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(canonical))));
}

export async function createSigningPair(): Promise<{ publicKey: PublicKey; privateKey: PublicKey }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return { publicKey: await crypto.subtle.exportKey("jwk", pair.publicKey) as PublicKey, privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey) as PublicKey };
}
export function canonicalJson(value: unknown): string {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort) : item && typeof item === "object"
    ? Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, sort(v)])) : item;
  return JSON.stringify(sort(value));
}
export async function signPrivateChange(privateKey: PublicKey, value: unknown): Promise<string> {
  const key = await crypto.subtle.importKey("jwk", privateKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return encodeSecret(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(canonicalJson(value)))));
}
