import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { authenticate, requireAuthenticatedUser } from "../middleware/auth.js";
import { standardRateLimit } from "../middleware/rate-limit.js";
import { DBRepo } from "../db/repo.js";
import { NotFoundError } from "../lib/errors.js";

export const notificationRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // The signed-in officer's own inbox. There is deliberately no way to ask for
  // another officer's notifications.
  fastify.get(
    "/notifications",
    { preHandler: [authenticate, standardRateLimit] },
    async (request, reply) => {
      const user = requireAuthenticatedUser(request);
      const { limit } = request.query as { limit?: string };

      const rows = await DBRepo.getNotifications(user.id, limit ? Number(limit) : 20);

      return reply.status(200).send({
        success: true,
        data: {
          notifications: rows,
          unread: rows.filter((row) => !row.readAt).length,
          count: rows.length,
        },
      });
    },
  );

  // Mark read. Ownership is enforced in the repository, so another officer's id
  // returns 404 rather than confirming that the notification exists.
  fastify.patch(
    "/notifications/:id/read",
    { preHandler: [authenticate, standardRateLimit] },
    async (request, reply) => {
      const user = requireAuthenticatedUser(request);
      const { id } = request.params as { id: string };

      const updated = await DBRepo.markNotificationRead(id, user.id);
      if (!updated) throw new NotFoundError("Notification", id);

      return reply.status(200).send({ success: true, data: { notification: updated } });
    },
  );

  // Unread count only, for the bell badge.
  fastify.get(
    "/notifications/unread-count",
    { preHandler: [authenticate, standardRateLimit] },
    async (request, reply) => {
      const user = requireAuthenticatedUser(request);

      return reply.status(200).send({
        success: true,
        data: { unread: await DBRepo.countUnreadNotifications(user.id) },
      });
    },
  );
};