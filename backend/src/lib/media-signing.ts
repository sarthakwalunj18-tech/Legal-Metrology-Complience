import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import fs from "fs";
import path from "path";
import { env, isProduction } from "../config/env.js";

/**
 * HMAC key for evidence media URLs.
 *
 * In production this MUST come from `MEDIA_SIGNING_SECRET` (enforced at boot by
 * the env validator). Outside production we derive a stable, machine-local key
 * cached in `.media-signing-dev.key` (git-ignored) so that separate local
 * processes — the API server and the test runner — agree on signatures and dev
 * links survive a restart. The file is never read in production.
 */
const DEV_KEY_FILE = path.resolve(process.cwd(), ".media-signing-dev.key");

function resolveSigningKey(): string {
  if (env.MEDIA_SIGNING_SECRET) return env.MEDIA_SIGNING_SECRET;
  if (isProduction) {
    // Unreachable: the env validator refuses to boot without the secret.
    throw new Error("MEDIA_SIGNING_SECRET must be configured in production.");
  }

  try {
    const cached = fs.readFileSync(DEV_KEY_FILE, "utf8").trim();
    if (cached.length >= 32) return cached;
  } catch {
    // Fall through and mint a new key.
  }

  const generated = randomBytes(32).toString("hex");
  try {
    fs.writeFileSync(DEV_KEY_FILE, generated, { mode: 0o600 });
  } catch {
    // Read-only working directory: fall back to a per-process key.
  }
  return generated;
}

const RESOLVED_SIGNING_KEY = resolveSigningKey();

function signingKey(): string {
  return RESOLVED_SIGNING_KEY;
}

export interface MediaTokenPayload {
  /** Storage path being authorised. */
  path: string;
  /** Unix seconds after which the link stops working. */
  exp: number;
  /** Opaque nonce so two links for the same path are not identical. */
  nonce: string;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export function signMediaToken(path: string, ttlSeconds = env.MEDIA_URL_TTL_SECONDS): string {
  const payload: MediaTokenPayload = {
    path,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    nonce: randomBytes(6).toString("hex"),
  };

  const encoded = base64url(JSON.stringify(payload));
  const signature = createHmac("sha256", signingKey()).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

export function verifyMediaToken(token: string, now = Date.now()): MediaTokenPayload | null {
  if (typeof token !== "string" || !token.includes(".")) return null;

  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return null;

  const expected = createHmac("sha256", signingKey()).update(encoded).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }

  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as MediaTokenPayload;
    if (typeof payload.path !== "string" || typeof payload.exp !== "number") return null;
    if (payload.exp * 1000 < now) return null;
    return payload;
  } catch {
    return null;
  }
}

/** How long issued links remain valid. Surfaced in the UI as a hint. */
export const mediaUrlTtlSeconds = env.MEDIA_URL_TTL_SECONDS;

export const mediaSigningIsEphemeral = !env.MEDIA_SIGNING_SECRET && !isProduction;
