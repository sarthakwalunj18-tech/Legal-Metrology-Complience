import { FastifyInstance, FastifyPluginAsync } from "fastify";
import {
  assertScanAccess,
  authenticate,
  ownedScanResource,
  requireAuthenticatedUser,
  requirePermission,
  type AuthUser,
} from "../middleware/auth.js";
import { standardRateLimit } from "../middleware/rate-limit.js";
import { DBRepo } from "../db/repo.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { NotificationService } from "../services/notification.service.js";
import { z } from "zod";

const decisionPayloadSchema = z.object({
  decision: z.enum(["ACCEPTED", "REJECTED", "OVERRIDDEN", "REINSPECTION_REQUIRED"]),
  notes: z.string().min(2, "Reviewer notes must be at least 2 characters"),
  overriddenStatus: z.enum(["COMPLIANT", "NON_COMPLIANT", "REQUIRES_REVIEW"]).optional(),
});

/**
 * Officer ids a reviewer may sign off, or `undefined` for global scope.
 *
 * An override is a legal determination, so it must be scoped exactly like a
 * read: an inspector sees only their own case, a supervisor only their
 * department, an administrator everything.
 */
async function reviewableInspectorIds(user: AuthUser): Promise<string[] | undefined> {
  if (user.role === "ADMIN") return undefined;
  if (user.role === "INSPECTOR") return [user.id];

  const departmentUsers = await DBRepo.getAllUsers();
  return departmentUsers
    .filter((member) => member.department === user.department)
    .map((member) => String(member.id));
}

/**
 * Separation of duties: the officer who ran the analysis must not be the person
 * who signs it off. Enforced for every reviewer role, including administrators,
 * because the control is worthless if the most privileged account can bypass it.
 */
function assertReviewerIsNotAuthor(
  reviewer: AuthUser,
  scan: { id?: string; inspectorId?: string | null } | null,
): void {
  const authorId = scan?.inspectorId ? String(scan.inspectorId) : null;
  if (!authorId) return;

  const reviewerIds = new Set<string>([reviewer.id]);
  if (reviewer.supabaseUserId) reviewerIds.add(reviewer.supabaseUserId);

  if (reviewerIds.has(authorId)) {
    throw new ForbiddenError(
      "Separation of duties: the officer who performed this inspection cannot sign it off. Route it to another reviewing officer.",
      "INSUFFICIENT_PERMISSIONS",
    );
  }
}

/**
 * Read guard for a single review target, with the owner's department attached so
 * supervisor scoping cannot degrade to global access.
 */
async function assertReviewScope(
  user: AuthUser,
  scan: { id: string; inspectorId?: string | null } | null,
): Promise<void> {
  // Preserve not-found semantics for an unknown id before any scope reasoning,
  // so probing cannot distinguish "missing" from "forbidden".
  if (!scan) throw new NotFoundError("Inspection record");

  assertScanAccess(user, await ownedScanResource(scan));
}

export const reviewRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // Inspections awaiting a supervisory determination, within the caller's scope.
  fastify.get(
    "/reviews",
    { preHandler: [authenticate, requirePermission("INSPECTION_REVIEW"), standardRateLimit] },
    async (request, reply) => {
      const user = requireAuthenticatedUser(request);

      const pending = await DBRepo.getPendingReviews();
      const scope = await reviewableInspectorIds(user);
      const visible =
        scope === undefined
          ? pending
          : pending.filter((scan) => scope.includes(String(scan.inspectorId)));

      return reply.status(200).send({
        success: true,
        data: {
          reviews: visible,
          count: visible.length,
          scope: scope === undefined ? "global" : user.role === "INSPECTOR" ? "own" : "department",
        },
      });
    },
  );

  // Submit supervisor determination & override
  fastify.post(
    "/reviews/:id/decision",
    { preHandler: [authenticate, requirePermission("INSPECTION_APPROVE"), standardRateLimit] },
    async (request, reply) => {
      const user = requireAuthenticatedUser(request);
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

      // Load first: authorization is decided against the real record, never
      // against whatever id the caller happened to send.
      const existing = await DBRepo.getScan(id);
      await assertReviewScope(user, existing);
      assertReviewerIsNotAuthor(user, existing);

      if (decision === "ACCEPTED" && overriddenStatus) {
        throw new ValidationError(
          "Accepting the AI decision must not also restate an outcome. Use OVERRIDDEN to change the compliance status.",
        );
      }

      if (decision === "OVERRIDDEN" && !overriddenStatus) {
        throw new ValidationError("An override must state the corrected compliance status.");
      }

      // Capture the AI determination before it is overwritten, so the audit
      // trail records what the system said as well as what the human decided.
      const previousComplianceStatus = existing?.complianceStatus ?? null;
      const previousReviewStatus = existing?.reviewStatus ?? null;

      const updatedScan = await DBRepo.updateScan(id, {
        reviewStatus: decision,
        reviewerNotes: notes,
        reviewedBy: user.id,
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

      // Append-only audit log: original AI decision and final decision both kept.
      await DBRepo.insertAuditLog({
        userId: user.id,
        userEmail: user.email,
        action: decision === "OVERRIDDEN" ? "INSPECTION_OVERRIDDEN" : "INSPECTION_SUPERVISOR_REVIEW",
        resourceType: "SCAN",
        resourceId: id,
        details: {
          decision,
          notes,
          overriddenStatus: overriddenStatus ?? null,
          reviewerRole: user.role,
          aiDecision: previousComplianceStatus,
          previousComplianceStatus,
          previousReviewStatus,
          finalComplianceStatus: updatedScan.complianceStatus,
          agreement:
            decision === "OVERRIDDEN" && previousComplianceStatus
              ? previousComplianceStatus === overriddenStatus
                ? "AGREED"
                : "DISAGREED"
              : "AGREED",
        },
      });

      // The officer who ran the inspection is told the outcome. Fire-and-forget:
      // the determination is already recorded and audited at this point.
void NotificationService.reviewDecided(
          {
            id,
            scanNumber: updatedScan.scanNumber as string | undefined,
            inspectorId: existing?.inspectorId as string | null | undefined,
          },
          decision,
          user.name,
        );

      return reply.status(200).send({
        success: true,
        data: {
          scan: updatedScan,
          message: `Supervisor determination recorded: '${decision}'. Audit log created.`,
        },
      });
    },
  );
};
