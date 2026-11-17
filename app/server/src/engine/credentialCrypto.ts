// Minimal AES-256-GCM encryption-at-rest for real administrator credentials temporarily stored on
// a HelpdeskTicket (Elevated Access) between grant and expiry — nothing else in this codebase
// needed field-level encryption before this, so there was no existing helper to reuse. Keyed off
// CREDENTIAL_ENCRYPTION_KEY (a 32-byte key, hex-encoded — App Service setting, never hardcoded).
// A credential encrypted here is opaque at rest in the database; it's only ever decrypted
// server-side, immediately before being served to the authorized, still-active session owner.
import crypto from "crypto";

function getKey(): Buffer {
  const hex = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) throw new Error("CREDENTIAL_ENCRYPTION_KEY is not configured (must be a 32-byte hex string) — cannot store or read elevated-access credentials securely.");
  return Buffer.from(hex, "hex");
}

/** Returns a single string ("iv:authTag:ciphertext", all hex) safe to store directly in a Json
 *  field — never the plaintext. */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

export function decryptSecret(stored: string): string {
  const [ivHex, tagHex, dataHex] = String(stored).split(":");
  if (!ivHex || !tagHex || !dataHex) throw new Error("Stored credential is not in the expected encrypted format.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
}
