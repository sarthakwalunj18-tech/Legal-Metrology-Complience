import { buildApp } from "./app.js";
import { corsOrigins, env, isDevAuthEnabled, publicApiUrl } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { RagLegalService } from "./services/rag/rag.service.js";

async function main() {
  const app = buildApp();

  const shutdown = async (signal: string) => {
    logger.info("Shutdown requested", { signal });
    try {
      await app.close();
      process.exit(0);
    } catch (error) {
      logger.error("Graceful shutdown failed", { error });
      process.exit(1);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    const address = await app.listen({ port: env.PORT, host: env.HOST });
    logger.info("Server listening", { address, publicApiUrl });
    logger.info("Health check", { url: `${address}/api/health` });
    logger.info("CORS allow-list", { origins: corsOrigins });
    if (isDevAuthEnabled) {
      logger.warn("Demo authentication is ENABLED. Never start this mode in production.");
    }

    // Warm up and initialize RAG knowledge base in background
    RagLegalService.ensureInitialized().catch((error: unknown) =>
      logger.warn("Background RAG initialisation failed", { error }),
    );
  } catch (error) {
    logger.error("Failed to start server", { error });
    process.exit(1);
  }
}

void main();
