import { DBRepo } from "../db/repo.js";
import { logger } from "../lib/logger.js";

/**
 * Who to notify about what.
 *
 * Notifications are derived from workflow events rather than a background poller, so
 * a missed notification means a missed event — which is visible — instead of silently
 * drifting. Every helper is fire-and-forget: the caller must not fail because an
 * inbox write failed.
 */

export type NotificationType =
  | "REVIEW_REQUESTED"
  | "REVIEW_DECIDED"
  | "VIOLATION_RAISED"
  | "REPORT_READY";

/** Officers who may review, i.e. who need to know a case is waiting. */
async function reviewerIds(): Promise<string[]> {
  const users = await DBRepo.getAllUsers();
  return users
    .filter((user) => user.role === "SUPERVISOR" || user.role === "ADMIN")
    .map((user) => String(user.id));
}

async function notify(input: {
  userId: string;
  type: NotificationType;
  title: string;
  body?: string;
  resourceType?: string;
  resourceId?: string;
  href?: string;
}): Promise<void> {
  if (!input.userId) return;

  try {
    await DBRepo.insertNotification({
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      href: input.href ?? null,
    });
  } catch (error) {
    // Deliberately swallowed: the workflow that triggered this already succeeded.
    logger.warn("Could not file notification", {
      type: input.type,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export const NotificationService = {
  /** A case finished analysis and needs a supervisory determination. */
  async reviewRequested(scan: {
    id: string;
    scanNumber?: string;
    inspectorId?: string | null;
    complianceStatus?: string | null;
  }): Promise<void> {
    const reviewers = await reviewerIds();
    // Never ask the officer who performed the inspection to review their own work.
    const recipients = reviewers.filter((id) => id !== String(scan.inspectorId ?? ""));

    await Promise.all(
      recipients.map((userId) =>
        notify({
          userId,
          type: "REVIEW_REQUESTED",
          title: `Review required: ${scan.scanNumber ?? "inspection"}`,
          body:
            scan.complianceStatus === "REQUIRES_REVIEW"
              ? "The rules engine flagged this inspection for a human determination."
              : "This inspection is awaiting supervisory sign-off.",
          resourceType: "SCAN",
          resourceId: String(scan.id),
          href: "/reviews",
        }),
      ),
    );
  },

  /** A supervisory decision was recorded; the author is told the outcome. */
  async reviewDecided(
    scan: { id: string; scanNumber?: string; inspectorId?: string | null },
    decision: string,
    decidedByName: string,
  ): Promise<void> {
    if (!scan.inspectorId) return;

    await notify({
      userId: String(scan.inspectorId),
      type: "REVIEW_DECIDED",
      title: `${decision.replace(/_/g, " ").toLowerCase()}: ${scan.scanNumber ?? "inspection"}`,
      body: `Signed off by ${decidedByName}.`,
      resourceType: "SCAN",
      resourceId: String(scan.id),
      href: `/inspections/${scan.id}`,
    });
  },

  /** A non-compliance was recorded against a commodity. */
  async violationRaised(violation: {
    id: string;
    title?: string;
    severity?: string | null;
    scanId?: string | null;
  }): Promise<void> {
    const reviewers = await reviewerIds();

    await Promise.all(
      reviewers.map((userId) =>
        notify({
          userId,
          type: "VIOLATION_RAISED",
          title: `${violation.severity ?? "Violation"}: ${violation.title ?? "non-compliance"}`,
          body: "A non-compliance was recorded against an inspected commodity.",
          resourceType: "VIOLATION",
          resourceId: String(violation.id),
          href: "/violations",
        }),
      ),
    );
  },

  /** An enforcement report finished generating. */
  async reportReady(report: {
    id: string;
    reportNumber?: string;
    inspectorId?: string | null;
  }): Promise<void> {
    if (!report.inspectorId) return;

    await notify({
      userId: String(report.inspectorId),
      type: "REPORT_READY",
      title: `Report ready: ${report.reportNumber ?? "inspection report"}`,
      body: "The signed report is available to download.",
      resourceType: "REPORT",
      resourceId: String(report.id),
      href: "/reports",
    });
  },
};