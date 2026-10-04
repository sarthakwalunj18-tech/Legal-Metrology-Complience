import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { authenticate, requirePermission } from "../middleware/auth.js";
import { standardRateLimit } from "../middleware/rate-limit.js";
import { RulesService } from "../services/rules/rules.service.js";
import { NotFoundError } from "../lib/errors.js";

export const ruleRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // 1. Statutory rule library. Officers may read; only admins may edit.
  fastify.get(
    "/rules",
    { preHandler: [authenticate, requirePermission("RULE_VIEW"), standardRateLimit] },
    async (request, reply) => {
      const { category } = request.query as { category?: string };

      const rules = category
        ? await RulesService.getApplicableRules(category)
        : await RulesService.getAllActiveRules();

      return reply.status(200).send({ success: true, data: { total: rules.length, rules } });
    }
  );

  // 2. Single rule by id.
  fastify.get(
    "/rules/:id",
    { preHandler: [authenticate, requirePermission("RULE_VIEW"), standardRateLimit] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const rule = await RulesService.getRuleById(id);

      if (!rule) throw new NotFoundError("Rule", id);

      return reply.status(200).send({ success: true, data: { rule } });
    }
  );

  // NOTE: the rule library mirrors the Legal Metrology (Packaged Commodities)
  // Rules, 2011 and is deliberately read-only over the API. There is no
  // mutation endpoint: statutory text must be changed through a reviewed,
  // versioned migration rather than an ad-hoc request.
};
