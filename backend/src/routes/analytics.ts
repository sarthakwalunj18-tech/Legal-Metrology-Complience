import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { authenticate, requirePermission } from "../middleware/auth.js";
import { standardRateLimit } from "../middleware/rate-limit.js";
import { DBRepo } from "../db/repo.js";

export const analyticsRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.get(
    "/analytics",
    { preHandler: [authenticate, requirePermission("ANALYTICS_VIEW"), standardRateLimit] },
    async (request, reply) => {
      const analytics = await DBRepo.getAnalyticsData();
      return reply.status(200).send({
        success: true,
        data: analytics,
      });
    }
  );
};
