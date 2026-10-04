import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { authenticate } from "../middleware/auth.js";
import { standardRateLimit } from "../middleware/rate-limit.js";
import { DBRepo } from "../db/repo.js";

export const searchRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.get(
    "/search",
    { preHandler: [authenticate, standardRateLimit] },
    async (request, reply) => {
      const { q } = request.query as { q?: string };
      if (!q || q.trim().length === 0) {
        return reply.status(200).send({
          success: true,
          data: { scans: [], products: [], rules: [], violations: [] },
        });
      }

      const results = await DBRepo.globalSearch(q);
      return reply.status(200).send({
        success: true,
        data: results,
      });
    }
  );
};
