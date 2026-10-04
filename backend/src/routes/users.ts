import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { authenticate, requirePermission } from "../middleware/auth.js";
import { standardRateLimit } from "../middleware/rate-limit.js";
import { DBRepo } from "../db/repo.js";
import { z } from "zod";

const createUserSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  role: z.enum(["INSPECTOR", "SUPERVISOR", "ADMIN"]),
  department: z.string().optional(),
});

const updateUserSchema = z.object({
  name: z.string().min(2).optional(),
  role: z.enum(["INSPECTOR", "SUPERVISOR", "ADMIN"]).optional(),
  department: z.string().optional(),
});

export const userRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // 1. List users
  fastify.get(
    "/users",
    { preHandler: [authenticate, requirePermission("USER_VIEW"), standardRateLimit] },
    async (request, reply) => {
      const userList = await DBRepo.getAllUsers();
      return reply.status(200).send({
        success: true,
        data: {
          users: userList,
          count: userList.length,
        },
      });
    }
  );

  // 2. Create user
  fastify.post(
    "/users",
    { preHandler: [authenticate, requirePermission("USER_CREATE"), standardRateLimit] },
    async (request, reply) => {
      const parse = createUserSchema.safeParse(request.body);
      if (!parse.success) {
        return reply.status(400).send({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid user data",
            details: parse.error.format(),
          },
        });
      }

      const existing = await DBRepo.getUserByEmail(parse.data.email);
      if (existing) {
        return reply.status(409).send({
          success: false,
          error: {
            code: "USER_ALREADY_EXISTS",
            message: `User with email '${parse.data.email}' already exists.`,
          },
        });
      }

      const created = await DBRepo.createUser(parse.data);

      await DBRepo.insertAuditLog({
        userId: request.user?.id,
        userEmail: request.user?.email || "admin@lm.gov.in",
        action: "USER_CREATED",
        resourceType: "USER",
        resourceId: created.id,
        details: { email: created.email, role: created.role },
      });

      return reply.status(201).send({
        success: true,
        data: created,
      });
    }
  );

  // 3. Update user
  fastify.patch(
    "/users/:id",
    { preHandler: [authenticate, requirePermission("USER_UPDATE"), standardRateLimit] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parse = updateUserSchema.safeParse(request.body);
      if (!parse.success) {
        return reply.status(400).send({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid update payload",
          },
        });
      }

      const updated = await DBRepo.updateUser(id, parse.data);
      if (!updated) {
        return reply.status(404).send({
          success: false,
          error: {
            code: "USER_NOT_FOUND",
            message: `User '${id}' was not found.`,
          },
        });
      }

      await DBRepo.insertAuditLog({
        userId: request.user?.id,
        userEmail: request.user?.email || "admin@lm.gov.in",
        action: "USER_UPDATED",
        resourceType: "USER",
        resourceId: id,
        details: parse.data,
      });

      return reply.status(200).send({
        success: true,
        data: updated,
      });
    }
  );

  // 4. Delete user
  fastify.delete(
    "/users/:id",
    { preHandler: [authenticate, requirePermission("USER_SUSPEND"), standardRateLimit] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await DBRepo.deleteUser(id);

      await DBRepo.insertAuditLog({
        userId: request.user?.id,
        userEmail: request.user?.email || "admin@lm.gov.in",
        action: "USER_SUSPENDED",
        resourceType: "USER",
        resourceId: id,
      });

      return reply.status(200).send({
        success: true,
        message: `User '${id}' has been suspended/deactivated.`,
      });
    }
  );
};
