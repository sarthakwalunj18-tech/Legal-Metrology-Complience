import { FastifyInstance, FastifyPluginAsync } from "fastify";
import {
  assertScanAccess,
  authenticate,
  requirePermission,
  requireAuthenticatedUser,
  resolveOwnerDepartment,
} from "../middleware/auth.js";
import { expensiveAiRateLimit, standardRateLimit } from "../middleware/rate-limit.js";
import { StorageService } from "../services/storage.service.js";
import { PreprocessService } from "../services/preprocess.service.js";
import { DBRepo } from "../db/repo.js";
import { OcrService } from "../services/ocr/ocr.service.js";
import { validateImageUpload } from "../services/upload.validation.js";
import { env } from "../config/env.js";
import { ValidationError, NotFoundError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";

interface UploadedPart {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  format: string;
}

/** Trimmed text fields posted alongside the multipart files. */
interface UploadFields {
  productName: string;
  category: string;
  brand: string;
  location: string;
}

export const scanRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // 1. Upload package photographs and register the inspection.
  fastify.post(
    "/scans/upload",
    { preHandler: [authenticate, requirePermission("SCAN_CREATE"), expensiveAiRateLimit] },
    async (request, reply) => {
      const user = requireAuthenticatedUser(request);

      const uploaded: UploadedPart[] = [];
      const fields: UploadFields = {
        productName: "",
        category: "",
        brand: "",
        location: "",
      };

      const parts = request.parts({
        limits: {
          fileSize: env.UPLOAD_MAX_BYTES,
          files: env.UPLOAD_MAX_FILES,
        },
      });

      for await (const part of parts) {
        if (part.type === "file") {
          const buffer = await part.toBuffer();

          // Trust the bytes, never the browser supplied Content-Type.
          const validated = await validateImageUpload(buffer, {
            declaredMimeType: part.mimetype,
            declaredFileName: part.filename,
            maxBytes: env.UPLOAD_MAX_BYTES,
          });

          uploaded.push({
            buffer: validated.buffer,
            fileName: validated.fileName,
            mimeType: validated.mimeType,
            format: validated.format,
          });
          continue;
        }

        const value = String(part.value ?? "").trim().slice(0, 200);
        if (part.fieldname === "productName") fields.productName = value;
        if (part.fieldname === "category") fields.category = value;
        if (part.fieldname === "brand") fields.brand = value;
        if (part.fieldname === "location") fields.location = value;
      }

      if (uploaded.length === 0) {
        throw new ValidationError("At least one package photograph is required.");
      }

      if (!fields.productName) {
        throw new ValidationError("A product name is required to register the inspection.");
      }

      const createdProduct = await DBRepo.insertProduct({
        name: fields.productName,
        brand: fields.brand,
        category: fields.category || "Packaged Commodity",
        commodityType: "Solid/Liquid",
      });

      // Sequential, collision-checked registration number (never random).
      const scanNumber = await DBRepo.getNextScanNumber();

      const createdScan = await DBRepo.insertScan({
        productId: createdProduct.id,
        inspectorId: user.provisioned ? user.id : undefined,
        scanNumber,
        location: fields.location,
        status: "PROCESSING",
        complianceStatus: "REQUIRES_REVIEW",
        complianceScore: "0.00",
      });

      const scanId = String(createdScan.id);

      const storedImagePairs = await Promise.all(
        uploaded.map(async (file, idx) => {
          const original = await StorageService.uploadFile(
            file.buffer,
            `orig_${idx + 1}_${file.fileName}`,
            file.mimeType,
            "scans/original",
          );

          const originalRecord = await DBRepo.insertImage({
            scanId,
            imageType: "ORIGINAL",
            storagePath: original.storagePath,
            fileName: file.fileName,
            contentType: file.mimeType,
            fileSizeBytes: file.buffer.length,
          });

          // Preprocessed derivative keeps OCR accuracy high on poor lighting.
          const preprocessed = await PreprocessService.preprocess(file.buffer);
          const preprocessedUpload = await StorageService.uploadFile(
            preprocessed.processedBuffer,
            `prep_${idx + 1}_${file.fileName}.jpg`,
            "image/jpeg",
            "scans/preprocessed",
          );

          const preprocessedRecord = await DBRepo.insertImage({
            scanId,
            imageType: "PREPROCESSED",
            storagePath: preprocessedUpload.storagePath,
            fileName: `preprocessed_${file.fileName}`,
            contentType: "image/jpeg",
            fileSizeBytes: preprocessed.processedBuffer.length,
            width: preprocessed.width,
            height: preprocessed.height,
          });

          return [originalRecord, preprocessedRecord];
        }),
      );

      const storedImages = storedImagePairs.flat();

      await DBRepo.insertAuditLog({
        userId: user.provisioned ? user.id : undefined,
        userEmail: user.email,
        action: "SCAN_UPLOADED",
        resourceType: "SCAN",
        resourceId: scanId,
        details: {
          scanNumber,
          imageCount: uploaded.length,
          formats: uploaded.map((file) => file.format),
        },
      });

      logger.info("Inspection registered", {
        requestId: request.id,
        scanId,
        scanNumber,
        imageCount: uploaded.length,
        userId: user.id,
      });

      return reply.status(201).send({
        success: true,
        data: {
          scanId,
          scanNumber,
          productId: createdProduct.id,
          images: storedImages,
        },
      });
    }
  );

  // 2. Single inspection with evidence, extraction, checks and violations.
  fastify.get(
    "/scans/:id",
    { preHandler: [authenticate, requirePermission("SCAN_VIEW"), standardRateLimit] },
    async (request, reply) => {
      const user = requireAuthenticatedUser(request);
      const { id } = request.params as { id: string };

      const scan = await DBRepo.getScan(id);
      assertScanAccess(user, {
        id,
        inspectorId: scan?.inspectorId as string | undefined,
        department: await resolveOwnerDepartment(scan?.inspectorId as string | undefined),
      });
      if (!scan) throw new NotFoundError("Inspection record", id);

      const scanId = String(scan.id);
      const [scanImages, extractedFields, complianceChecks, violations] = await Promise.all([
        DBRepo.getScanImages(scanId),
        DBRepo.getScanExtractedFields(scanId),
        DBRepo.getScanComplianceChecks(scanId),
        DBRepo.getScanViolations(scanId),
      ]);

      const imagesWithUrls = await Promise.all(
        scanImages.map(async (image) => ({
          ...image,
          url: await StorageService.getSignedUrl(
            String(image.storagePath),
            (image.contentType as string) ?? "image/jpeg",
          ),
        })),
      );

      return reply.status(200).send({
        success: true,
        data: {
          scan,
          images: imagesWithUrls,
          analysis: (scan.analysis as unknown) ?? null,
          extractedFields,
          complianceChecks,
          violations,
        },
      });
    }
  );

  // 3. Paginated inspection registry. Inspectors are scoped to their own records.
  fastify.get(
    "/scans",
    { preHandler: [authenticate, requirePermission("SCAN_VIEW"), standardRateLimit] },
    async (request, reply) => {
      const user = requireAuthenticatedUser(request);
      const query = request.query as Record<string, string | undefined>;

      const page = await DBRepo.getScansPage({
        page: toPositiveInt(query.page),
        pageSize: toPositiveInt(query.pageSize),
        search: query.search,
        complianceStatus: query.complianceStatus,
        reviewStatus: query.reviewStatus,
        status: query.status,
        severity: query.severity,
        productId: query.productId,
        location: query.location,
        fromDate: query.fromDate,
        toDate: query.toDate,
        sort: query.sort as "newest" | "oldest" | "score_asc" | "score_desc" | undefined,
        inspectorId: user.role === "INSPECTOR" ? user.id : query.inspectorId,
      });

      return reply.status(200).send({
        success: true,
        data: {
          scans: page.items,
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

  // 4. Re-run OCR for a single inspection (diagnostic / re-processing aid).
  fastify.post(
    "/scans/:id/ocr",
    { preHandler: [authenticate, requirePermission("INSPECTION_ANALYZE"), expensiveAiRateLimit] },
    async (request, reply) => {
      const user = requireAuthenticatedUser(request);
      const { id } = request.params as { id: string };

      const scan = await DBRepo.getScan(id);
      assertScanAccess(user, {
        id,
        inspectorId: scan?.inspectorId as string | undefined,
        department: await resolveOwnerDepartment(scan?.inspectorId as string | undefined),
      });
      if (!scan) throw new NotFoundError("Inspection record", id);

      const scanId = String(scan.id);
      const scanImages = await DBRepo.getScanImages(scanId);
      const preprocessed = scanImages.filter((image) => image.imageType === "PREPROCESSED");
      const targetImages = preprocessed.length > 0 ? preprocessed : scanImages.filter((image) => image.imageType === "ORIGINAL");

      if (targetImages.length === 0) {
        throw new ValidationError("No package images found for this inspection.");
      }

      const ocrResults = await Promise.all(
        targetImages.map(async (image) => {
          const imageBuffer = await StorageService.downloadFile(String(image.storagePath));
          return OcrService.extract(imageBuffer);
        }),
      );

      const combinedText = ocrResults
        .map((result, index) => `--- PACKAGE IMAGE ${index + 1} ---\n${result.rawText}`)
        .join("\n\n");

      return reply.status(200).send({
        success: true,
        data: {
          scanId,
          ocr: { rawText: combinedText, results: ocrResults },
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
 * Supervisors are scoped by department, which lives on the officer record rather
 * than on the inspection, so it has to be resolved before the access check.
 * Shared with the review workflow via `middleware/auth.ts`.
 */
