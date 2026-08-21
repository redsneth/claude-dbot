import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

const KEY_FILE = join(config.dataDir, "secret.key");

function loadKey(): Buffer {
  if (!existsSync(KEY_FILE)) {
    const key = randomBytes(32);
    writeFileSync(KEY_FILE, key, { mode: 0o600 });
    return key;
  }
  chmodSync(KEY_FILE, 0o600);
  return readFileSync(KEY_FILE);
}

const key = loadKey();

/** AES-256-GCM. Output format: base64(iv).base64(authTag).base64(ciphertext) */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString("base64")).join(".");
}

export function decrypt(payload: string): string {
  const [iv, tag, ct] = payload.split(".").map((p) => Buffer.from(p, "base64"));
  if (!iv || !tag || !ct) throw new Error("Malformed encrypted payload");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
