import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { authenticate, requirePermission } from "../middleware/auth.js";
import { standardRateLimit } from "../middleware/rate-limit.js";
import { DBRepo } from "../db/repo.js";
import { z } from "zod";

const decisionPayloadSchema = z.object({
  decision: z.enum(["ACCEPTED", "REJECTED", "OVERRIDDEN", "REINSPECTION_REQUIRED"]),
  notes: z.string().min(2, "Reviewer notes must be at least 2 characters"),
  overriddenStatus: z.enum(["COMPLIANT", "NON_COMPLIANT", "REQUIRES_REVIEW"]).optional(),
});

export const reviewRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // List all inspections awaiting supervisor review
  fastify.get(
    "/reviews",
    { preHandler: [authenticate, requirePermission("INSPECTION_REVIEW"), standardRateLimit] },
    async (request, reply) => {
      const pending = await DBRepo.getPendingReviews();
      return reply.status(200).send({
        success: true,
        data: {
          reviews: pending,
          count: pending.length,
        },
      });
    }
  );

  // Submit supervisor determination & override
  fastify.post(
    "/reviews/:id/decision",
    { preHandler: [authenticate, requirePermission("INSPECTION_APPROVE"), standardRateLimit] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parseResult = decisionPayloadSchema.safeParse(request.body);

      if (!parseResult.success) {
        return reply.status(400).send({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid review decision payload",
            details: parseResult.error.format(),
          },
        });
      }

      const { decision, notes, overriddenStatus } = parseResult.data;

      const updatedScan = await DBRepo.updateScan(id, {
        reviewStatus: decision,
        reviewerNotes: notes,
        reviewedBy: request.user?.id && request.user.id.includes("-") ? request.user.id : undefined,
        reviewedAt: new Date(),
        ...(overriddenStatus ? { complianceStatus: overriddenStatus } : {}),
      });

      if (!updatedScan) {
        return reply.status(404).send({
          success: false,
          error: {
            code: "SCAN_NOT_FOUND",
            message: `Inspection scan '${id}' was not found.`,
          },
        });
      }

      // Record immutable audit log
      await DBRepo.insertAuditLog({
        userId: request.user?.id && request.user.id.includes("-") ? request.user.id : undefined,
        userEmail: request.user?.email || "supervisor@lm.gov.in",
        action: decision === "OVERRIDDEN" ? "INSPECTION_OVERRIDDEN" : "INSPECTION_SUPERVISOR_REVIEW",
        resourceType: "SCAN",
        resourceId: id,
        details: {
          decision,
          notes,
          overriddenStatus,
          reviewerRole: request.user?.role,
          previousStatus: updatedScan.complianceStatus,
        },
      });

      return reply.status(200).send({
        success: true,
        data: {
          scan: updatedScan,
          message: `Supervisor determination recorded: '${decision}'. Audit log created.`,
        },
      });
    }
  );
};
