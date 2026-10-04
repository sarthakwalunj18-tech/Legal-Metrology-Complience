import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const PLACEHOLDER_SECRET_MARKERS = [
  "fake_",
  "changeme",
  "your-",
  "placeholder",
  "example",
  "xxx",
];

/**
 * Detects values that were only ever meant as local-development placeholders.
 * These are tolerated in development/test but are a hard failure in production.
 */
function isPlaceholderSecret(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized.length < 16) return true;
  return PLACEHOLDER_SECRET_MARKERS.some((marker) => normalized.includes(marker));
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).optional(),

  /**
   * Comma separated allow-list of browser origins permitted to call this API.
   */
  CORS_ORIGIN: z.string().default("http://localhost:3000"),

  /**
   * Absolute origin used to build media/report URLs handed to the browser.
   * Defaults to this API's own address. Behind the Next.js BFF the browser only
   * ever sees the frontend origin, so set it explicitly in that topology.
   */
  PUBLIC_API_URL: z.string().optional(),

  DATABASE_URL: z.string().default("postgresql://postgres:postgrespassword@127.0.0.1:5432/postgres"),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(5),

  SUPABASE_URL: z.string().url().default("http://127.0.0.1:54321"),
  SUPABASE_ANON_KEY: z.string().min(1).optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  SUPABASE_STORAGE_BUCKET: z.string().default("commodity-scans"),

  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),

  /**
   * Enables the role-based demo login and the `dev-*` bearer tokens.
   * Hard-disabled whenever NODE_ENV=production, regardless of this value.
   */
  ALLOW_DEV_AUTH: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),

  UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(20 * 1024 * 1024),
  UPLOAD_MAX_FILES: z.coerce.number().int().positive().max(12).default(6),
  BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(2 * 1024 * 1024),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_STANDARD: z.coerce.number().int().positive().default(240),
  RATE_LIMIT_AUTH: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_AI: z.coerce.number().int().positive().default(20),

  /**
   * HMAC secret protecting locally stored evidence media URLs.
   * Auto-derived (ephemeral) when not provided so dev always works.
   */
  MEDIA_SIGNING_SECRET: z.string().min(16).optional(),
  MEDIA_URL_TTL_SECONDS: z.coerce.number().int().positive().default(900),

  /**
   * Seconds an analysis job may run before it is aborted and marked FAILED.
   */
  ANALYSIS_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    // Never echo raw values; only the field names and reasons.
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n  - ");
    console.error(`[config] Invalid environment configuration:\n  - ${issues}`);
    process.exit(1);
  }

  const env = parsed.data;

  if (env.NODE_ENV !== "production") {
    // Local development keeps working without any credentials.
    env.SUPABASE_ANON_KEY ??= "local-development-anon-key";
    env.SUPABASE_SERVICE_ROLE_KEY ??= "local-development-service-role-key";
    env.GEMINI_API_KEY ??= "";
    if (process.env.ALLOW_DEV_AUTH === undefined) {
      env.ALLOW_DEV_AUTH = true;
    }
    return env;
  }

  // ---- Production guards -------------------------------------------------
  const productionProblems: string[] = [];

  if (env.ALLOW_DEV_AUTH) {
    productionProblems.push(
      "ALLOW_DEV_AUTH must be false/unset when NODE_ENV=production (demo tokens are forbidden).",
    );
  }

  const requiredProductionSecrets: Array<[string, string | undefined]> = [
    ["SUPABASE_ANON_KEY", env.SUPABASE_ANON_KEY],
    ["SUPABASE_SERVICE_ROLE_KEY", env.SUPABASE_SERVICE_ROLE_KEY],
    ["MEDIA_SIGNING_SECRET", env.MEDIA_SIGNING_SECRET],
  ];

  for (const [name, value] of requiredProductionSecrets) {
    if (!value) {
      productionProblems.push(`${name} is required when NODE_ENV=production.`);
    } else if (isPlaceholderSecret(value)) {
      productionProblems.push(`${name} still holds a development placeholder value.`);
    }
  }

  if (env.CORS_ORIGIN.includes("*")) {
    productionProblems.push("CORS_ORIGIN must not contain a wildcard in production.");
  }

  if (productionProblems.length > 0) {
    console.error(
      `[config] Refusing to start in production mode:\n  - ${productionProblems.join("\n  - ")}`,
    );
    process.exit(1);
  }

  return env;
}

export const env = loadEnv();

/** Resolved CORS allow-list. */
export const corsOrigins: string[] = env.CORS_ORIGIN.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

/** Base URL browsers use to reach this API (media + report links). */
export const publicApiUrl: string = (
  env.PUBLIC_API_URL ?? `http://localhost:${env.PORT}`
).replace(/\/+$/, "");

/** Demo authentication is only ever available outside production. */
export const isDevAuthEnabled: boolean = env.NODE_ENV !== "production" && env.ALLOW_DEV_AUTH;

export const isProduction: boolean = env.NODE_ENV === "production";

/**
 * `loadEnv` guarantees these are present (development defaults them, production
 * refuses to boot without them), so this narrows the optional schema types.
 */
function requireResolvedValue(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`[config] ${name} resolved to an empty value.`);
  }
  return value;
}

export const supabaseAnonKey: string = requireResolvedValue(
  "SUPABASE_ANON_KEY",
  env.SUPABASE_ANON_KEY,
);

export const supabaseServiceRoleKey: string = requireResolvedValue(
  "SUPABASE_SERVICE_ROLE_KEY",
  env.SUPABASE_SERVICE_ROLE_KEY,
);
