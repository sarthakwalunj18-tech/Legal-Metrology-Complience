import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { authenticate, requireAuthenticatedUser, requirePermission } from "../middleware/auth.js";
import { standardRateLimit } from "../middleware/rate-limit.js";
import { RagLegalService } from "../services/rag/rag.service.js";
import { AssistantService } from "../services/assistant/assistant.service.js";
import { ValidationError } from "../lib/errors.js";
import { DBRepo } from "../db/repo.js";
import { z } from "zod";

const ragQuerySchema = z.object({
  query: z.string().trim().min(2).max(500),
  category: z.string().optional().default("GENERAL"),
});

const askSchema = z.object({
  question: z.string().trim().min(3).max(500),
  category: z.string().optional().default("GENERAL"),
});

export const ragRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // 1. Semantic statutory retrieval used to ground determinations.
  fastify.post(
    "/rag/query",
    { preHandler: [authenticate, requirePermission("RULE_VIEW"), standardRateLimit] },
    async (request, reply) => {
      const parseResult = ragQuerySchema.safeParse(request.body);
      if (!parseResult.success) {
        throw new ValidationError("Invalid RAG query payload.", parseResult.error.flatten());
      }

      const { query, category } = parseResult.data;
      const retrievedContext = await RagLegalService.retrieveLegalContext(query, category);

      return reply.status(200).send({
        success: true,
        data: { query, category, totalRetrieved: retrievedContext.length, retrievedContext },
      });
    }
  );

  // 2. GET variant for quick officer lookup.
  fastify.get(
    "/rag/query",
    { preHandler: [authenticate, requirePermission("RULE_VIEW"), standardRateLimit] },
    async (request, reply) => {
      const { q, category } = request.query as { q?: string; category?: string };

      if (!q || q.trim().length < 2) {
        throw new ValidationError("Search query parameter 'q' is required.");
      }

      const retrievedContext = await RagLegalService.retrieveLegalContext(q, category || "GENERAL");

      return reply.status(200).send({
        success: true,
        data: { query: q, totalRetrieved: retrievedContext.length, retrievedContext },
      });
    }
  );

  // 3. Grounded officer-facing assistance: an answer that may only restate the
  //    statutory text retrieved for the question, with the citations it used.
  fastify.post(
    "/rag/ask",
    { preHandler: [authenticate, requirePermission("RULE_VIEW"), standardRateLimit] },
    async (request, reply) => {
      const user = requireAuthenticatedUser(request);
      const parseResult = askSchema.safeParse(request.body);

      if (!parseResult.success) {
        throw new ValidationError("Invalid assistant question payload.", parseResult.error.flatten());
      }

      const { question, category } = parseResult.data;
      const result = await AssistantService.answer(question, category);

      // Statutory lookups by officers are auditable: who asked what, when, and
      // whether the system had the authority to answer at all.
      await DBRepo.insertAuditLog({
        userId: user.id,
        userEmail: user.email,
        action: "RAG_ASSISTANCE_REQUESTED",
        resourceType: "RULE",
        resourceId: result.citations[0]?.ruleId ?? null,
        details: {
          question,
          category,
          grounded: result.grounded,
          generated: result.generated,
          refusal: result.refusal,
          citations: result.citations.map((citation) => citation.ruleNumber),
        },
      });

      return reply.status(200).send({ success: true, data: result });
    }
  );
};
