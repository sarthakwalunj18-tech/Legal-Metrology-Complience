import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { authenticate, requireAuthenticatedUser, type AuthUser } from "../middleware/auth.js";
import { standardRateLimit } from "../middleware/rate-limit.js";
import { DBRepo } from "../db/repo.js";

type SearchScope = "own" | "department" | "global";

function scopeLabel(user: AuthUser, globalScope: boolean): SearchScope {
  if (globalScope) return "global";
  return user.role === "INSPECTOR" ? "own" : "department";
}

/**
 * Officer ids a search may return records for, or `undefined` for global scope.
 *
 * Search is a read path, so it obeys exactly the same scope rules as the
 * registries: an inspector must never discover another officer's inspections,
 * products or violations by typing a fragment of a name into a search box.
 */
async function searchableInspectorIds(user: AuthUser): Promise<string[] | undefined> {
  if (user.role === "ADMIN") return undefined;
  if (user.role === "INSPECTOR") return [user.id];

  const departmentUsers = await DBRepo.getAllUsers();
  return departmentUsers
    .filter((member) => member.department === user.department)
    .map((member) => String(member.id));
}

export const searchRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.get(
    "/search",
    { preHandler: [authenticate, standardRateLimit] },
    async (request, reply) => {
      const user = requireAuthenticatedUser(request);
      const { q } = request.query as { q?: string };
      const inspectorIds = await searchableInspectorIds(user);
      const scope = scopeLabel(user, inspectorIds === undefined);

      if (!q || q.trim().length === 0) {
        // Same keys as a populated response, so clients never special-case empty.
        return reply.status(200).send({
          success: true,
          data: { inspections: [], products: [], rules: [], violations: [], scope },
        });
      }

      const results = await DBRepo.globalSearch(q, { inspectorIds });

      return reply.status(200).send({
        success: true,
        data: { ...results, scope },
      });
    }
  );
};