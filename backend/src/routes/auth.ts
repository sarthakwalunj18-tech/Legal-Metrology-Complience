import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { supabaseClient } from "../db/supabase.js";
import { DBRepo } from "../db/repo.js";
import {
  authenticate,
  resolveDemoUser,
  resolveProvisionedUser,
  requirePermission,
} from "../middleware/auth.js";
import { authRateLimit } from "../middleware/rate-limit.js";
import { isDevAuthEnabled } from "../config/env.js";
import { ForbiddenError, UnauthenticatedError, ValidationError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";

const loginSchema = z
  .object({
    email: z.string().email().optional(),
    password: z.string().min(8).optional(),
    /**
     * Demo-only: selects one of the seeded officer identities without a password.
     * Rejected outright whenever demo auth is disabled.
     */
    role: z.enum(["INSPECTOR", "SUPERVISOR", "ADMIN"]).optional(),
  })
  .refine((value) => Boolean(value.email && value.password) || Boolean(value.role), {
    message: "Provide either email+password or a demo role.",
  });

const refreshSchema = z.object({ refreshToken: z.string().min(10) });

export const authRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // 1. Login
  fastify.post("/auth/login", { preHandler: [authRateLimit] }, async (request, reply) => {
    const parseResult = loginSchema.safeParse(request.body);
    if (!parseResult.success) {
      throw new ValidationError("Invalid login payload.", parseResult.error.flatten());
    }

    const { email, password, role } = parseResult.data;

    // Demo login by role. Never reachable in production.
    if (role) {
      if (!isDevAuthEnabled) {
        logger.warn("Rejected demo login attempt", { requestId: request.id });
        throw new ForbiddenError("Demo login is disabled on this deployment.");
      }

      const user = await resolveDemoUser(role);
      if (!user) {
        throw new ForbiddenError("Unknown demo identity.");
      }

      return reply.status(200).send({
        success: true,
        data: { mode: "demo", token: `dev-${role.toLowerCase()}`, user },
      });
    }

    // Real Supabase password login.
    const { data, error } = await supabaseClient.auth.signInWithPassword({
      email: email!,
      password: password!,
    });

    if (error || !data.session) {
      logger.info("Supabase rejected a login attempt", {
        requestId: request.id,
        reason: error?.message,
      });
      // Deliberately vague so the endpoint cannot be used to enumerate accounts.
      throw new UnauthenticatedError("Invalid email or password.", "INVALID_TOKEN");
    }

    const sessionUser = data.user;
    const accountEmail = (sessionUser.email ?? "").trim().toLowerCase();

    // Authorization always comes from the `users` table, never from
    // client-controllable `user_metadata`.
    const user = await resolveProvisionedUser(accountEmail, sessionUser.id);
    if (!user) {
      throw new ForbiddenError(
        "This account is authenticated but has not been provisioned on the Legal Metrology platform. Contact an administrator.",
        "RESOURCE_FORBIDDEN",
      );
    }

    // Best-effort last-login bookkeeping; never blocks the login response.
    void DBRepo.touchUserLastLogin(user.id).catch((bookkeepingError: unknown) => {
      logger.debug("Failed to record last login", { userId: user.id, error: bookkeepingError });
    });

    return reply.status(200).send({
      success: true,
      data: {
        mode: "supabase",
        token: data.session.access_token,
        refreshToken: data.session.refresh_token,
        expiresAt: data.session.expires_at ?? null,
        user,
      },
    });
  });

  // 2. Refresh - lets the BFF rotate an expiring access token without ever
  //    exposing Supabase credentials to the browser.
  fastify.post("/auth/refresh", { preHandler: [authRateLimit] }, async (request, reply) => {
    const parseResult = refreshSchema.safeParse(request.body);
    if (!parseResult.success) {
      throw new ValidationError("A refreshToken is required.");
    }

    const { data, error } = await supabaseClient.auth.refreshSession({
      refresh_token: parseResult.data.refreshToken,
    });

    if (error || !data.session || !data.user) {
      throw new UnauthenticatedError("The session has expired. Please sign in again.", "INVALID_TOKEN");
    }

    const user = await resolveProvisionedUser(
      (data.user.email ?? "").trim().toLowerCase(),
      data.user.id,
    );
    if (!user) {
      throw new ForbiddenError("This account is no longer provisioned on the platform.");
    }

    return reply.status(200).send({
      success: true,
      data: {
        token: data.session.access_token,
        refreshToken: data.session.refresh_token,
        expiresAt: data.session.expires_at ?? null,
        user,
      },
    });
  });

  // 3. Current identity + effective permissions.
  fastify.get("/auth/me", { preHandler: [authenticate] }, async (request, reply) => {
    return reply.status(200).send({ success: true, data: { user: request.user } });
  });

  // 4. Logout is intentionally stateless: the BFF clears its httpOnly cookies.
  fastify.post("/auth/logout", async (_request, reply) => {
    return reply.status(200).send({ success: true, data: { signedOut: true } });
  });

  // 5. Role probe endpoints kept for the existing UI; now permission based.
  fastify.get(
    "/inspector/scans",
    { preHandler: [authenticate, requirePermission("SCAN_VIEW")] },
    async (request, reply) => {
      return reply.status(200).send({
        success: true,
        message: "Inspector scans accessed successfully",
        userRole: request.user?.role,
      });
    }
  );

  fastify.get(
    "/supervisor/reviews",
    { preHandler: [authenticate, requirePermission("INSPECTION_REVIEW")] },
    async (request, reply) => {
      return reply.status(200).send({
        success: true,
        message: "Supervisor inspection reviews accessed successfully",
        userRole: request.user?.role,
      });
    }
  );

  fastify.get(
    "/admin/users",
    { preHandler: [authenticate, requirePermission("USER_VIEW")] },
    async (request, reply) => {
      return reply.status(200).send({
        success: true,
        message: "Admin user management accessed successfully",
        userRole: request.user?.role,
      });
    }
  );
};
