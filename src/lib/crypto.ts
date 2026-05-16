/**
 * Application-level secret encryption (server-only).
 *
 * AES-256-GCM with a master key from env. Output format is
 * base64(IV[12] || authTag[16] || ciphertext). GCM gives us
 * authenticated encryption — any tampering with the stored blob
 * makes decryption fail loudly rather than returning corrupt
 * plaintext.
 *
 * Used for shops.aurinko_access_token_enc — the one piece of
 * per-shop credential material we hold. Vapi assistant IDs,
 * Twilio phone numbers, and Stripe acct_XXX identifiers are not
 * credentials and stay in plaintext.
 *
 * Key rotation procedure (manual, for now):
 *   1. Decrypt all rows with the current key.
 *   2. Set the new key.
 *   3. Re-encrypt all rows.
 * Not a real concern at pilot scale — revisit if/when we have many
 * connected shops.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto"

const ALG = "aes-256-gcm"
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16

export class CryptoConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CryptoConfigError"
  }
}

function loadKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY?.trim()
  if (!raw) {
    throw new CryptoConfigError("ENCRYPTION_KEY is not configured")
  }
  // 64 hex chars = 32 bytes. Anything else is a config bug.
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new CryptoConfigError(
      "ENCRYPTION_KEY must be 64 hex characters (32 bytes) — generate with `openssl rand -hex 32`"
    )
  }
  const buf = Buffer.from(raw, "hex")
  if (buf.length !== KEY_BYTES) {
    throw new CryptoConfigError(
      `ENCRYPTION_KEY decoded to ${buf.length} bytes; expected ${KEY_BYTES}`
    )
  }
  return buf
}

/**
 * Encrypts a UTF-8 plaintext. Returns the base64-encoded blob that
 * should be stored as-is in the DB. Empty / null inputs return null
 * so callers can pass through "no token here" without special-casing.
 */
export function encryptSecret(plaintext: string | null | undefined): string | null {
  if (plaintext === null || plaintext === undefined) return null
  const trimmed = plaintext.trim()
  if (!trimmed) return null

  const key = loadKey()
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALG, key, iv)
  const enc = Buffer.concat([
    cipher.update(trimmed, "utf8"),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, enc]).toString("base64")
}

/**
 * Decrypts a blob from encryptSecret. Returns null for null/empty
 * inputs. Throws on tampering, wrong key, or malformed input — never
 * returns silently-corrupt plaintext.
 */
export function decryptSecret(blob: string | null | undefined): string | null {
  if (!blob) return null

  const key = loadKey()
  const combined = Buffer.from(blob, "base64")
  if (combined.length <= IV_BYTES + TAG_BYTES) {
    throw new Error("Encrypted blob is truncated")
  }
  const iv = combined.subarray(0, IV_BYTES)
  const tag = combined.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const ciphertext = combined.subarray(IV_BYTES + TAG_BYTES)

  const decipher = createDecipheriv(ALG, key, iv)
  decipher.setAuthTag(tag)
  const plain = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ])
  return plain.toString("utf8")
}

/**
 * Convenience for the common pattern: a shop row that may or may not
 * have a stored encrypted token. Returns null when nothing's stored
 * OR when decryption fails (caller treats the shop as not-connected).
 * The error path is logged so a misconfigured key surfaces in the
 * server logs without crashing user requests.
 */
export function tryDecryptSecret(blob: string | null | undefined): string | null {
  try {
    return decryptSecret(blob)
  } catch (err) {
    console.error("[crypto] decryptSecret failed:", err)
    return null
  }
}

/**
 * Constant-time string compare for non-cryptographic callers that
 * still want to avoid timing-channel leaks (e.g., header secret
 * comparisons that live next to this module).
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  try {
    return timingSafeEqual(ab, bb)
  } catch {
    return false
  }
}
