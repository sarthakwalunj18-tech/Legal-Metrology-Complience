/**
 * Shared domain types for the inspection pipeline.
 *
 * These describe what the Fastify API actually returns, so data pages stop
 * annotating payloads as `any`. Field names mirror `backend/src/db/schema.ts`
 * (camelCase) as serialised by the BFF.
 */

export type ComplianceStatus = "COMPLIANT" | "NON_COMPLIANT" | "REQUIRES_REVIEW" | null;
export type ScanStatus = "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
export type ReviewStatus =
  | "PENDING"
  | "ACCEPTED"
  | "REJECTED"
  | "OVERRIDDEN"
  | "REINSPECTION_REQUIRED";
export type Severity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/** Axis-aligned box in normalised 0..1 coordinates, as stored on violations. */
export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RAGCitation {
  ruleId?: string;
  ruleNumber?: string;
  text?: string;
  statutoryObligation?: string;
  sourceAct?: string;
  clause?: string;
  similarityScore?: number;
}

export interface Scan {
  id: string;
  productId: string | null;
  inspectorId: string | null;
  scanNumber: string;
  location: string | null;
  status: ScanStatus;
  complianceStatus: ComplianceStatus;
  complianceScore: string | null;
  reviewStatus: ReviewStatus;
  reviewerNotes: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Per-stage timings recorded by the pipeline, used for observability. */
  processingTimings?: { ocrMs?: number; extractionMs?: number; ragMs?: number; totalMs?: number } | null;
}

/** Row shape of the `scans` table as the list endpoints return it. */
export type ScanRow = Record<string, unknown> & { id: string; scanNumber: string };

export interface ScanImage {
  id: string;
  scanId: string;
  storagePath: string;
  contentType: string | null;
  imageType: string | null;
  /** Short-lived signed URL minted per request; never a raw storage path. */
  url: string;
  createdAt?: string;
}

export interface ExtractedField {
  id: string;
  scanId: string;
  fieldName: string;
  fieldValue: string | null;
  confidence: string | number | null;
  boundingBox: BoundingBox | string | null;
  pageNumber?: number | null;
}

export interface ComplianceCheck {
  id: string;
  scanId: string;
  ruleId: string;
  ruleNumber?: string | null;
  status: "PASS" | "FAIL" | "REVIEW" | string;
  confidence: string | number | null;
  explanation?: string | null;
}

export interface Violation {
  id: string;
  scanId: string;
  checkId: string | null;
  ruleId: string;
  violationType: string;
  severity: Severity | string;
  title: string;
  description: string;
  extractedEvidence: string | null;
  boundingBox: BoundingBox | string | null;
  suggestedAction: string | null;
  confidence: string | number | null;
  reviewStatus: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
  createdAt: string;
  /** Enforcement case state (OPEN / CONFIRMED / DISMISSED …). */
  status?: string | null;
  ruleNumber?: string | null;
  category?: string | null;
  /** Denormalised scan fields, present on list responses only. */
  scanNumber?: string | null;
  scanComplianceStatus?: string | null;
  location?: string | null;
  inspectorId?: string | null;
  inspectedAt?: string | null;
}

export interface Product {
  id: string;
  name: string;
  brand: string | null;
  category: string | null;
  commodityType: string | null;
  manufacturerName: string | null;
}

/** Deterministic analysis summary persisted on the scan. */
export interface ComplianceAnalysis {
  complianceStatus?: ComplianceStatus;
  complianceScore?: number;
  summary?: {
    totalChecks?: number;
    passed?: number;
    failed?: number;
    requiresReview?: number;
  };
  violations?: Violation[];
  legalContext?: RAGCitation[];
  [key: string]: unknown;
}

/** Payload of `GET /scans/:id`. */
export interface ScanDetailPayload {
  scan: Scan;
  images: ScanImage[];
  analysis: ComplianceAnalysis | null;
  extractedFields: ExtractedField[];
  complianceChecks: ComplianceCheck[];
  violations: Violation[];
}

export interface ReviewQueuePayload {
  reviews: ScanRow[];
  count: number;
  scope: "own" | "department" | "global";
}

export interface PendingReviewsPayload {
  reviews: ScanRow[];
  count: number;
  scope?: "own" | "department" | "global";
}

/** Payload of `GET /reports`. */
export interface ReportRow {
  id: string;
  reportNumber: string;
  inspectionId?: string | null;
  scanNumber?: string | null;
  productName?: string | null;
  status?: string | null;
  /** Expiring signed URL; the raw storage path is never returned. */
  downloadUrl: string;
  generatedAt?: string | null;
  createdAt?: string | null;
  [key: string]: unknown;
}

export interface ReportListPayload {
  reports: ReportRow[];
  total: number;
  page: number;
  pageSize: number;
  scope: "own" | "department" | "global";
}

export interface ViolationListPayload {
  violations: Violation[];
  total: number;
  page: number;
  pageSize: number;
  pageCount?: number;
}

export interface AuditLogRow {
  id: string;
  userId: string | null;
  userEmail: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  details: Record<string, unknown> | null;
  ipAddress?: string | null;
  createdAt: string;
}

/** `GET /dashboard/stats` — every aggregate already respects the caller's scope. */
export interface DashboardSummary {
  metrics: {
    totalInspections: number;
    compliant: number;
    nonCompliant: number;
    requiresReview: number;
    pendingReview: number;
    processing: number;
    failed: number;
    totalViolations: number;
    complianceRatePercentage: number;
    averageComplianceScore: number | null;
    averageConfidence: number | null;
    averageProcessingTimeSeconds: number | null;
  };
  severityBreakdown: Array<{ severity: string; count: number; percentage: number }>;
  violationTypeBreakdown: Array<{ name: string; count: number; percentage: number }>;
  statusBreakdown: Array<{ name: string; count: number; percentage: number }>;
  reviewStatusBreakdown: Array<{ name: string; count: number; percentage: number }>;
  confidenceDistribution: Array<{ bucket: string; count: number }>;
  complianceTrend: Array<{
    period: string;
    label: string;
    total: number;
    compliant: number;
    nonCompliant: number;
    requiresReview: number;
  }>;
  topCategories: Array<{ name: string; total: number; compliant: number; rate: number }>;
  recentInspections: ScanRow[];
  topLocations: Array<{ location: string; total: number; violations: number }>;
}

/** Parses the API's numeric-as-string columns without producing NaN. */
export function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Confidence is stored 0..1 in Postgres; render it as an integer percentage. */
export function toPercent(value: string | number | null | undefined): number | null {
  const parsed = toNumber(value);
  if (parsed === null) return null;
  // Tolerate values already expressed as 0..100.
  return Math.round(parsed <= 1 ? parsed * 100 : parsed);
}

/** Bounding boxes arrive as jsonb (object) or, from older rows, as text. */
export function parseBoundingBox(value: BoundingBox | string | null | undefined): BoundingBox | null {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value) as BoundingBox;
    return typeof parsed?.x === "number" ? parsed : null;
  } catch {
    return null;
  }
}