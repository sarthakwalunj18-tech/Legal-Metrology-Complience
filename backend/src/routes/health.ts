import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { checkSupabaseConnection } from "../db/supabase.js";
import { checkPostgresConnection } from "../db/index.js";
import { authenticate, requirePermission } from "../middleware/auth.js";
import { standardRateLimit } from "../middleware/rate-limit.js";
import { env, isProduction } from "../config/env.js";

/** Upper bound on how long a dependency probe may hold a health request open. */
const PROBE_TIMEOUT_MS = 3000;

export const healthRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // Liveness: no dependency calls, safe for container/orchestrator probes.
  fastify.get("/health/live", async (_request, reply) => {
    return reply.status(200).send({
      status: "alive",
      timestamp: new Date().toISOString(),
    });
  });

  // Readiness: unauthenticated, so it deliberately reveals nothing about the
  // deployment beyond up/down. Diagnostics live behind /system/status.
  fastify.get("/health", { preHandler: [standardRateLimit] }, async (_request, reply) => {
    const [supabase, postgres] = await Promise.all([
      checkSupabaseConnection(PROBE_TIMEOUT_MS),
      checkPostgresConnection(),
    ]);

    // Storage/Auth availability is what the platform genuinely needs; Postgres
    // may be intentionally absent in demo mode via the in-memory store.
    const isReady = supabase.connected && (postgres.connected || !env.DATABASE_URL);

    return reply.status(isReady ? 200 : 503).send({
      status: isReady ? "healthy" : "degraded",
      service: "legal-metrology-compliance-backend",
      version: "1.0.0",
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
    });
  });

  // Administrative diagnostics. Reports the real, non-secret runtime
  // configuration and dependency state; requires SYSTEM_CONFIGURE.
  fastify.get(
    "/system/status",
    { preHandler: [authenticate, requirePermission("SYSTEM_CONFIGURE"), standardRateLimit] },
    async (_request, reply) => {
      const [supabase, postgres] = await Promise.all([
        checkSupabaseConnection(PROBE_TIMEOUT_MS),
        checkPostgresConnection(),
      ]);

      const isReady = supabase.connected && (postgres.connected || !env.DATABASE_URL);

      return reply.status(200).send({
        status: isReady ? "healthy" : "degraded",
        service: "legal-metrology-compliance-backend",
        version: "1.0.0",
        environment: env.NODE_ENV,
        timestamp: new Date().toISOString(),
        uptimeSeconds: Math.floor(process.uptime()),
        system: {
          memoryMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
          nodeVersion: process.version,
        },
        features: {
          demoAuth: !isProduction,
          mediaSigningConfigured: Boolean(env.MEDIA_SIGNING_SECRET),
          geminiConfigured: Boolean(env.GEMINI_API_KEY),
        },
        pipeline: {
          geminiModel: env.GEMINI_MODEL,
          analysisTimeoutMs: env.ANALYSIS_TIMEOUT_MS,
          uploadMaxBytes: env.UPLOAD_MAX_BYTES,
          uploadMaxFiles: env.UPLOAD_MAX_FILES,
          mediaUrlTtlSeconds: env.MEDIA_URL_TTL_SECONDS,
          storageBucket: env.SUPABASE_STORAGE_BUCKET,
        },
        dependencies: {
          supabase: {
            status: supabase.connected ? "connected" : "error",
            latencyMs: supabase.latencyMs,
            ...(supabase.error ? { error: supabase.error } : {}),
          },
          postgres: {
            status: postgres.connected ? "connected" : "error",
            latencyMs: postgres.latencyMs,
            ...(postgres.error ? { error: postgres.error } : {}),
          },
        },
      });
    }
  );
};
