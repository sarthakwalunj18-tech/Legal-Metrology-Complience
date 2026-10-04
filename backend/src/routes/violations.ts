import { FastifyInstance, FastifyPluginAsync } from "fastify";
import {
  assertScanAccess,
  authenticate,
  requireAnyPermission,
  requireAuthenticatedUser,
  type AuthUser,
} from "../middleware/auth.js";
import { standardRateLimit } from "../middleware/rate-limit.js";
import { DBRepo } from "../db/repo.js";
import { StorageService } from "../services/storage.service.js";
import { NotFoundError, ValidationError } from "../lib/errors.js";

/** Coerces `?limit=` / `?offset=` into the repository's page/pageSize shape. */
function readPaging(query: { limit?: string; offset?: string; page?: string; pageSize?: string }) {
  const pageSize = Number.parseInt(query.pageSize ?? query.limit ?? "50", 10);
  if (query.page) {
    const page = Number.parseInt(query.page, 10);
    if (Number.isFinite(page) && page > 0) return { page, pageSize: Number.isFinite(pageSize) ? pageSize : 50 };
  }
  const offset = Number.parseInt(query.offset ?? "0", 10);
  const size = Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 50;
  const safeOffset = Number.isFinite(offset) && offset > 0 ? offset : 0;
  return { page: Math.floor(safeOffset / size) + 1, pageSize: size };
}

/**
 * Supervisors are scoped to a department, which lives on the officer record
 * rather than the inspection, so it has to be resolved before the access check.
 */
async function resolveOwnerDepartment(
  user: AuthUser,
  inspectorId?: string,
): Promise<string | undefined> {
  if (user.role !== "SUPERVISOR" || !inspectorId) return undefined;
  const owner = await DBRepo.getUserById(inspectorId);
  return owner?.department ?? undefined;
}

export const violationRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // Paginated violation feed with the same filter set the registry UI exposes.
  fastify.get(
    "/violations",
    { preHandler: [authenticate, requireAnyPermission("VIOLATION_VIEW", "VIOLATION_REVIEW"), standardRateLimit] },
    async (request, reply) => {
      const user = requireAuthenticatedUser(request);
      const query = request.query as {
        search?: string;
        severity?: string;
        ruleId?: string;
        category?: string;
        reviewStatus?: string;
        complianceStatus?: string;
        location?: string;
        scanId?: string;
        fromDate?: string;
        toDate?: string;
        limit?: string;
        offset?: string;
        page?: string;
        pageSize?: string;
      };

      const { page, pageSize } = readPaging(query);

      const result = await DBRepo.getViolationsPage({
        page,
        pageSize,
        search: query.search,
        severity: query.severity,
        ruleId: query.ruleId,
        category: query.category,
        reviewStatus: query.reviewStatus,
        complianceStatus: query.complianceStatus,
        location: query.location,
        scanId: query.scanId,
        fromDate: query.fromDate,
        toDate: query.toDate,
        // Inspectors only ever see violations raised on their own inspections.
        inspectorId: user.role === "INSPECTOR" ? user.id : undefined,
      });

      return reply.status(200).send({
        success: true,
        data: {
          violations: result.items,
          total: result.total,
          page: result.page,
          pageSize: result.pageSize,
          pageCount: result.pageCount,
          hasNext: result.hasNext,
          hasPrevious: result.hasPrevious,
        },
      });
    }
  );

  // Single violation with its parent inspection and evidence image URLs.
  fastify.get(
    "/violations/:id",
    { preHandler: [authenticate, requireAnyPermission("VIOLATION_VIEW", "VIOLATION_REVIEW"), standardRateLimit] },
    async (request, reply) => {
      const user = requireAuthenticatedUser(request);
      const { id } = request.params as { id: string };

      const violation = await DBRepo.getViolationById(id);
      if (!violation) {
        return reply.status(404).send({
          success: false,
          error: { code: "VIOLATION_NOT_FOUND", message: `Violation with ID '${id}' was not found.` },
        });
      }

      const scanId = String(violation.scanId ?? "");
      if (!scanId) {
        throw new ValidationError("This violation is not linked to an inspection record.", "VALIDATION_ERROR");
      }

      const scan = await DBRepo.getScan(scanId);
      assertScanAccess(user, {
        id: scanId,
        inspectorId: scan?.inspectorId as string | undefined,
        department: await resolveOwnerDepartment(user, scan?.inspectorId as string | undefined),
      });
      if (!scan) throw new NotFoundError("Inspection record", scanId);

      const scanImages = await DBRepo.getScanImages(scanId);
      const imagesWithUrls = await Promise.all(
        scanImages.map(async (image) => ({
          ...image,
          url: await StorageService.getSignedUrl(
            String(image.storagePath),
            (image.contentType as string) ?? "image/jpeg",
          ),
        }))
      );

      return reply.status(200).send({
        success: true,
        data: { violation, scan, images: imagesWithUrls },
      });
    }
  );
};
