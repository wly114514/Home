import { createHash, pbkdf2, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import bcrypt from "bcryptjs";
export { validateProductionConfig } from "./production-config.mjs";

const derive = promisify(pbkdf2);
const adaptedEncode = value => value.toString("base64").replaceAll("+", ".").replace(/=+$/, "");
const adaptedDecode = value => Buffer.from(value.replaceAll(".", "+"), "base64");
export function secureEqual(a, b) {
  const left = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
  const right = Buffer.isBuffer(b) ? b : Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}
export async function passwordHash(password) {
  const salt = randomBytes(16), rounds = 600000;
  const digest = await derive(String(password), salt, rounds, 32, "sha256");
  return `$pbkdf2-sha256$${rounds}$${adaptedEncode(salt)}$${adaptedEncode(digest)}`;
}
export async function verifyPassword(password, stored) {
  try {
    const value = String(stored || "");
    if (/^\$2[aby]\$/.test(value)) return await bcrypt.compare(String(password), value);
    const parts = value.split("$");
    if (parts.length === 5 && ["pbkdf2-sha256", "node-pbkdf2-sha256"].includes(parts[1])) {
      const rounds = Number(parts[2]);
      if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 2_000_000) return false;
      const legacy = parts[1].startsWith("node-");
      const salt = legacy ? parts[3] : adaptedDecode(parts[3]);
      const expected = legacy ? Buffer.from(parts[4], "base64url") : adaptedDecode(parts[4]);
      const result = await derive(String(password), salt, rounds, 32, "sha256");
      return secureEqual(result, expected);
    }
    if (/^[a-f\d]{64}$/i.test(value)) return secureEqual(createHash("sha256").update(String(password)).digest("hex"), value);
    return false;
  } catch { return false; }
}
