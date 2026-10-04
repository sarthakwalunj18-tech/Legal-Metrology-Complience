import { FastifyInstance, FastifyPluginAsync } from "fastify";
import {
  assertScanAccess,
  assertScanWriteAccess,
  authenticate,
  requireAuthenticatedUser,
  requirePermission,
  resolveOwnerDepartment,
  type AuthUser,
} from "../middleware/auth.js";
import { expensiveAiRateLimit, standardRateLimit } from "../middleware/rate-limit.js";
import { InspectionPipelineService } from "../services/inspection/pipeline.service.js";
import { NotificationService } from "../services/notification.service.js";
import { ReportService } from "../services/reports/report.service.js";
import { StorageService } from "../services/storage.service.js";
import { DBRepo } from "../db/repo.js";
import { env } from "../config/env.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { z } from "zod";

const reviewPayloadSchema = z.object({
  decision: z.enum(["ACCEPTED", "REJECTED", "OVERRIDDEN"]),
  notes: z.string().trim().min(1).max(2000),
  overriddenStatus: z.enum(["COMPLIANT", "NON_COMPLIANT", "REQUIRES_REVIEW"]).optional(),
});

export const inspectionRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // 1. Run the full OCR -> extraction -> RAG -> deterministic rule pipeline.
  fastify.post(
    "/inspections/:id/analyze",
    { preHandler: [authenticate, requirePermission("INSPECTION_ANALYZE"), expensiveAiRateLimit] },
    async (request, reply) => {
      const user = requireAuthenticatedUser(request);
      const { id } = request.params as { id: string };

      const scan = await DBRepo.getScan(id);
      if (!scan) throw new NotFoundError("Inspection record", id);

      // Only the owning officer, their department, or an admin may analyse it.
      assertScanAccess(user, {
        id,
        inspectorId: scan.inspectorId as string | undefined,
        department: await resolveOwnerDepartment(scan.inspectorId as string | undefined),
      });

      await DBRepo.updateScan(id, {
        status: "PROCESSING",
        processingStage: "ANALYSIS_STARTED",
        analysisStartedAt: new Date(),
        analysisError: null,
      });

      // The pipeline is CPU/GPU bound; never let a hung worker pin the request open.
      const result = await withTimeout(
        InspectionPipelineService.processScan(id),
        env.ANALYSIS_TIMEOUT_MS,
      ).catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : "Unknown analysis failure";
        await DBRepo.updateScan(id, {
          status: "FAILED",
          processingStage: "FAILED",
          analysisError: message.slice(0, 500),
          analysisCompletedAt: new Date(),
        });
        logger.error("Inspection analysis failed", { requestId: request.id, scanId: id, error });
        throw error;
      });

      await DBRepo.updateScan(id, {
        analysisCompletedAt: new Date(),
        processingStage: "COMPLETED",
      });

      await DBRepo.insertAuditLog({
        userId: user.provisioned ? user.id : undefined,
        userEmail: user.email,
        action: "INSPECTION_ANALYZED",
        resourceType: "SCAN",
        resourceId: id,
        details: { complianceStatus: result.complianceStatus, score: result.complianceScore },
      });

      return reply.status(200).send({ success: true, data: result });
    }
  );

  // 2. Human review decision / override.
  fastify.post(
    "/inspections/:id/review",
    {
      preHandler: [
        authenticate,
        requirePermission("INSPECTION_REVIEW"),
        requirePermission("INSPECTION_APPROVE"),
        standardRateLimit,
      ],
    },
    async (request, reply) => {
      const user = requireAuthenticatedUser(request);
      const { id } = request.params as { id: string };

      const parseResult = reviewPayloadSchema.safeParse(request.body);
      if (!parseResult.success) {
        throw new ValidationError("Invalid review decision payload.", parseResult.error.flatten());
      }

      const { decision, notes, overriddenStatus } = parseResult.data;

      const scan = await DBRepo.getScan(id);
      if (!scan) throw new NotFoundError("Inspection record", id);

      assertScanAccess(user, {
        id,
        inspectorId: scan.inspectorId as string | undefined,
        department: await resolveOwnerDepartment(scan.inspectorId as string | undefined),
      });

      // Separation of duties: the officer who ran the analysis must not sign it off.
      if (scan.inspectorId && scan.inspectorId === user.id) {
        throw new ForbiddenError(
          "An officer may not review their own inspection. Route it to a supervisor.",
          "INSUFFICIENT_PERMISSIONS",
        );
      }

      if (decision === "OVERRIDDEN" && !overriddenStatus) {
        throw new ValidationError("An override must state the corrected compliance status.");
      }
      if (decision === "OVERRIDDEN" && !user.permissions.includes("INSPECTION_OVERRIDE")) {
        throw new ForbiddenError("You are not permitted to override a machine determination.");
      }

      const updatedScan = await DBRepo.updateScan(id, {
        reviewStatus: decision,
        reviewerNotes: notes,
        reviewedBy: user.id,
        reviewedAt: new Date(),
        ...(overriddenStatus ? { complianceStatus: overriddenStatus } : {}),
      });
      if (!updatedScan) throw new NotFoundError("Inspection record", id);

      await DBRepo.insertAuditLog({
        userId: user.provisioned ? user.id : undefined,
        userEmail: user.email,
        action: decision === "OVERRIDDEN" ? "INSPECTION_OVERRIDDEN" : "INSPECTION_REVIEWED",
        resourceType: "SCAN",
        resourceId: id,
        details: {
          decision,
          notes,
          overriddenStatus,
          previousComplianceStatus: scan.complianceStatus,
        },
      });

      return reply.status(200).send({
        success: true,
        data: {
          scan: updatedScan,
          message: `Inspection review recorded as '${decision}'. Audit log created.`,
        },
      });
    }
  );

  // 3. Generate the official statutory PDF. Idempotent per inspection.
  fastify.post(
    "/inspections/:id/report",
    { preHandler: [authenticate, requirePermission("REPORT_GENERATE"), expensiveAiRateLimit] },
    async (request, reply) => {
      const user = requireAuthenticatedUser(request);
      const { id } = request.params as { id: string };

      const scan = await DBRepo.getScan(id);
      if (!scan) throw new NotFoundError("Inspection record", id);

      // A report must never certify data the caller could not otherwise edit.
      assertScanWriteAccess(user, {
        id,
        inspectorId: scan.inspectorId as string | undefined,
        department: await resolveOwnerDepartment(scan.inspectorId as string | undefined),
      });

      const report = await ReportService.generateInspectionReport(id, user.id);

      await DBRepo.insertAuditLog({
        userId: user.provisioned ? user.id : undefined,
        userEmail: user.email,
        action: "REPORT_GENERATED",
        resourceType: "REPORT",
        resourceId: String((report as { reportId?: string }).reportId ?? id),
        details: { scanId: id, reportNumber: (report as { reportNumber?: string }).reportNumber },
      });

      // The author gets told their report is ready to download.
      void NotificationService.reportReady({
        id: String((report as { reportId?: string }).reportId ?? id),
        reportNumber: (report as { reportNumber?: string }).reportNumber,
        inspectorId: scan.inspectorId as string | null | undefined,
      });

      return reply.status(201).send({ success: true, data: report });
    }
  );

  // 4. Live enforcement dashboard. Every aggregate respects the caller's scope.
  fastify.get(
    "/dashboard/stats",
    { preHandler: [authenticate, requirePermission("SCAN_VIEW"), standardRateLimit] },
    async (request, reply) => {
      const user = requireAuthenticatedUser(request);

      const inspectorIds = await visibleInspectorIds(user);
      const summary = await DBRepo.getDashboardSummary(
        inspectorIds === undefined ? undefined : { inspectorIds },
      );

      return reply.status(200).send({
        success: true,
        data: {
          scope: inspectorIds === undefined ? "global" : user.role === "INSPECTOR" ? "own" : "department",
          ...summary,
        },
      });
    }
  );

  // 5. Longitudinal product inspection trail.
  fastify.get(
    "/products/:id/history",
    { preHandler: [authenticate, requirePermission("SCAN_VIEW"), standardRateLimit] },
    async (request, reply) => {
      const user = requireAuthenticatedUser(request);
      const { id } = request.params as { id: string };

      const product = await DBRepo.getProduct(id);
      if (!product) throw new NotFoundError("Commodity record", id);

      const inspectorIds = await visibleInspectorIds(user);
      const allScans = await DBRepo.getProductScans(id);
      const scopedScans =
        inspectorIds === undefined
          ? allScans
          : allScans.filter((scan) =>
              inspectorIds.includes(String(scan.inspectorId)),
            );

      if (user.role === "INSPECTOR" && scopedScans.length === 0) {
        throw new ForbiddenError(
          "You have no inspections recorded against this commodity.",
          "RESOURCE_FORBIDDEN",
        );
      }

      return reply.status(200).send({
        success: true,
        data: {
          product,
          totalInspections: scopedScans.length,
          history: scopedScans,
        },
      });
    }
  );

  // 6. Commodity registry.
  fastify.get(
    "/products",
    { preHandler: [authenticate, requirePermission("SCAN_VIEW"), standardRateLimit] },
    async (request, reply) => {
      const query = request.query as Record<string, string | undefined>;
      const page = await DBRepo.getProductsPage({
        page: toPositiveInt(query.page),
        pageSize: toPositiveInt(query.pageSize),
        search: query.search,
        category: query.category,
      });

      return reply.status(200).send({
        success: true,
        data: {
          products: page.items,
          total: page.total,
          page: page.page,
          pageSize: page.pageSize,
          pageCount: page.pageCount,
          hasNext: page.hasNext,
          hasPrevious: page.hasPrevious,
        },
      });
    }
  );

  // 7. Statutory audit trail. AUDIT_VIEW is supervisor/admin only.
  fastify.get(
    "/audit-logs",
    { preHandler: [authenticate, requirePermission("AUDIT_VIEW"), standardRateLimit] },
    async (request, reply) => {
      const query = request.query as Record<string, string | undefined>;

      const page = await DBRepo.getAuditLogsPage({
        page: toPositiveInt(query.page),
        pageSize: toPositiveInt(query.pageSize),
        search: query.search,
        action: query.action,
        resourceType: query.resourceType,
        resourceId: query.resourceId,
        userId: query.userId,
        fromDate: query.fromDate,
        toDate: query.toDate,
      });

      return reply.status(200).send({
        success: true,
        data: {
          logs: page.items,
          total: page.total,
          page: page.page,
          pageSize: page.pageSize,
          pageCount: page.pageCount,
          hasNext: page.hasNext,
          hasPrevious: page.hasPrevious,
        },
      });
    }
  );

  // 8. Generated statutory reports. Inspectors only ever see reports for the
  //    inspections they own, so the list cannot bypass the scan authorization.
  fastify.get(
    "/reports",
    { preHandler: [authenticate, requirePermission("REPORT_VIEW"), standardRateLimit] },
    async (request, reply) => {
      const user = requireAuthenticatedUser(request);
      const query = request.query as Record<string, string | undefined>;

      const page = await DBRepo.getReportsPage({
        page: toPositiveInt(query.page),
        pageSize: toPositiveInt(query.pageSize),
        search: query.search,
        format: query.format,
        inspectorIds: await visibleInspectorIds(user),
      });

      const reports = await Promise.all(
        page.items.map(async (item) => ({
          ...item,
          downloadUrl: await StorageService.signedUrlFor(String(item.storagePath ?? "")),
        })),
      );

      return reply.status(200).send({
        success: true,
        data: {
          reports,
          total: page.total,
          page: page.page,
          pageSize: page.pageSize,
          pageCount: page.pageCount,
          hasNext: page.hasNext,
          hasPrevious: page.hasPrevious,
          scope: user.role === "INSPECTOR" ? "own" : user.role === "SUPERVISOR" ? "department" : "global",
        },
      });
    }
  );
};

function toPositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Resolves the inspector IDs whose records the caller may see. `undefined` means
 * unrestricted (admin); an array means "only these officers", and an empty array
 * therefore means the caller may see nothing at all.
 *
 * The scope is pushed into the repository query so that paging, totals and
 * aggregates describe the authorised subset rather than the whole table.
 */
async function visibleInspectorIds(user: AuthUser): Promise<string[] | undefined> {
  if (user.role === "ADMIN") return undefined;
  if (user.role === "INSPECTOR") return [user.id];

  const departmentUsers = await DBRepo.getAllUsers();
  return departmentUsers
    .filter((member) => member.department === user.department)
    .map((member) => String(member.id));
}


function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        Object.assign(new Error(`Analysis exceeded the ${timeoutMs}ms budget and was aborted.`), {
          statusCode: 504,
          code: "TIMEOUT",
        }),
      );
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
