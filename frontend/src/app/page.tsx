"use client";

/**
 * Enforcement dashboard.
 *
 * Every figure is read from the live backend through the BFF. Nothing is
 * hardcoded or defaulted: an empty dataset renders as zeros and an explicit
 * empty state, and backend failures are surfaced instead of being masked.
 */
import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Sidebar } from "@/components/layout/Sidebar";
import { TopBar } from "@/components/layout/TopBar";
import { Card, CardHeader, CardBody, CardFooter } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatusBadge, StatusType } from "@/components/ui/Badge";
import { ApiRequestError, apiFetch, useSession } from "@/lib/session";
import {
  ShieldCheck,
  AlertOctagon,
  Clock3,
  FileCheck2,
  ScanSearch,
  Eye,
  Building2,
  Server,
  CheckCircle2,
  AlertTriangle,
  ChevronRight,
  Loader2,
} from "lucide-react";

interface ScanRow {
  id: string;
  scanNumber?: string;
  status?: string;
  complianceStatus?: string;
  complianceScore?: number | null;
  reviewStatus?: string;
  createdAt?: string;
  location?: string | null;
  productName?: string | null;
  brand?: string | null;
  category?: string | null;
  inspectorName?: string | null;
}

interface DashboardMetrics {
  totalInspections: number;
  compliant?: number;
  nonCompliant?: number;
  requiresReview?: number;
  complianceRatePercentage?: number;
  pendingReview?: number;
  processing?: number;
  totalViolations?: number;
  pendingReviewViolations?: number;
}

interface DashboardPayload {
  metrics: DashboardMetrics;
  recentInspections: ScanRow[];
  scope?: "own" | "department" | "global";
  severityBreakdown?: { severity: string; count: number; percentage: number }[];
  violationTypeBreakdown?: { name: string; count: number; percentage: number }[];
  statusBreakdown?: { name: string; count: number; percentage: number }[];
}

const SEVERITY_STYLES: Record<string, string> = {
  CRITICAL: "bg-red-600",
  HIGH: "bg-orange-500",
  MEDIUM: "bg-amber-500",
  WARNING: "bg-amber-500",
  LOW: "bg-blue-500",
  INFO: "bg-slate-400",
};

/** Backend scan statuses mapped onto the design-system badge vocabulary. */
function toStatusBadge(value: string | undefined): { badge: StatusType; label: string } {
  switch (value) {
    case "COMPLIANT":
      return { badge: "COMPLIANT", label: "COMPLIANT" };
    case "NON_COMPLIANT":
      return { badge: "NON_COMPLIANT", label: "NON-COMPLIANT" };
    case "REQUIRES_REVIEW":
      return { badge: "REQUIRES_REVIEW", label: "REQUIRES REVIEW" };
    case "FAILED":
      return { badge: "NON_COMPLIANT", label: "PROCESSING FAILED" };
    case "PROCESSING":
    case "PENDING":
    case "UPLOADED":
      return { badge: "INFO", label: value };
    default:
      return { badge: "NEUTRAL", label: value ?? "UNKNOWN" };
  }
}

interface LivenessPayload {
  status: string;
  service: string;
  version: string;
  uptimeSeconds: number;
  system: { memoryMb: number; nodeVersion: string };
}

const SCOPE_LABEL: Record<string, string> = {
  own: "Your inspections",
  department: "Department scope",
  global: "All departments",
};

export default function DashboardPage() {
  const { user, loading: sessionLoading } = useSession();
  const [health, setHealth] = useState<LivenessPayload | null>(null);
  const [stats, setStats] = useState<DashboardPayload | null>(null);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const loadDashboardData = useCallback(async () => {
    setIsRefreshing(true);
    setError(null);
    try {
      // Liveness is reachable without a session; stats requires SCAN_VIEW.
      const healthPromise = fetch("/api/backend/health/live", { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) return null;
          const body = await response.json();
          return (body?.data ?? body) as LivenessPayload;
        })
        .catch(() => null);

      const statsPromise = apiFetch<DashboardPayload>("/dashboard/stats").catch((cause: unknown) => {
        if (cause instanceof ApiRequestError && cause.status === 403) {
          throw new Error("Your role does not have dashboard access.");
        }
        throw cause;
      });

      const [healthData, statsData] = await Promise.all([healthPromise, statsPromise]);
      setHealth(healthData);
      setStats(statsData);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Failed to load dashboard data from the enforcement API.",
      );
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!sessionLoading) void loadDashboardData();
  }, [loadDashboardData, sessionLoading]);

  const metrics = stats?.metrics;
  const recentList = stats?.recentInspections ?? [];
  const isOfficerScope = stats?.scope === "own";
  const canCreate = user?.permissions?.includes("SCAN_CREATE");

  return (
    <div className="flex min-h-screen bg-[#F8FAFC]">
      <Sidebar />

      <div className="flex-1 flex flex-col min-w-0">
        <TopBar
          breadcrumbs={[{ label: "Enforcement Dashboard" }]}
          onRefresh={loadDashboardData}
          isRefreshing={isRefreshing}
        />

        <main className="p-8 max-w-7xl w-full mx-auto space-y-8 flex-1">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 pb-2 border-b border-slate-200">
            <div>
              <h1 className="text-2xl font-bold text-[#12304A] tracking-tight">
                Enforcement &amp; Compliance Overview
              </h1>
              <p className="text-sm text-slate-500 mt-1">
                Legal Metrology (Packaged Commodities) Rules, 2011 Automated Inspection System
                {stats?.scope ? ` · ${SCOPE_LABEL[stats.scope]}` : ""}
              </p>
            </div>
            {canCreate && (
              <Link href="/inspections/new">
                <Button variant="primary" icon={<ScanSearch className="w-4 h-4" />}>
                  New Inspection
                </Button>
              </Link>
            )}
          </div>

          {error && (
            <div className="flex items-start gap-2 p-4 bg-red-50 border border-red-200 rounded-xl text-xs text-red-800">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold">Dashboard data unavailable</div>
                <div className="mt-0.5">{error}</div>
              </div>
            </div>
          )}

          {/* Subsystem health - real probe, not an assumed "live" badge */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-slate-100 rounded-lg text-[#12304A]">
                <Server className="w-4 h-4" />
              </div>
              <div>
                <div className="text-xs font-semibold text-slate-800">Subsystem Infrastructure Status</div>
                <div className="text-xs text-slate-500">
                  {health
                    ? `Fastify ${health.service} v${health.version} · up ${Math.round(health.uptimeSeconds)}s · ${health.system.memoryMb} MB RSS`
                    : "Backend not reachable"}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3 text-xs">
              {isRefreshing ? (
                <span className="inline-flex items-center gap-1 text-slate-500">
                  <Loader2 className="w-3 h-3 animate-spin" /> Probing…
                </span>
              ) : health ? (
                <span className="inline-flex items-center gap-1 text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full font-medium border border-emerald-200">
                  <CheckCircle2 className="w-3 h-3" /> API responding
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-red-700 bg-red-50 px-2 py-0.5 rounded-full font-medium border border-red-200">
                  <AlertTriangle className="w-3 h-3" /> Disconnected
                </span>
              )}
            </div>
          </div>

          {/* KPI metrics - always sourced from the API response */}
          <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
            <Card>
              <CardBody className="p-5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                    Total Inspections
                  </span>
                  <div className="p-2 bg-blue-50 text-blue-700 rounded-lg">
                    <FileCheck2 className="w-4 h-4" />
                  </div>
                </div>
                <div className="mt-3 flex items-baseline gap-2">
                  <span className="text-2xl font-bold text-[#12304A]">
                    {(metrics?.totalInspections ?? 0).toLocaleString()}
                  </span>
                </div>
                <div className="mt-2 text-xs text-slate-500">
                  {isOfficerScope ? "Logged by you" : "Across all enforcement records"}
                </div>
              </CardBody>
            </Card>

            <Card>
              <CardBody className="p-5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-emerald-700 uppercase tracking-wider">
                    Compliant
                  </span>
                  <div className="p-2 bg-emerald-50 text-emerald-700 rounded-lg">
                    <ShieldCheck className="w-4 h-4" />
                  </div>
                </div>
                <div className="mt-3 flex items-baseline gap-2">
                  <span className="text-2xl font-bold text-emerald-700">
                    {(metrics?.compliant ?? 0).toLocaleString()}
                  </span>
                  {metrics?.complianceRatePercentage !== undefined && (
                    <span className="text-xs font-medium text-slate-500">
                      ({metrics.complianceRatePercentage}% pass rate)
                    </span>
                  )}
                </div>
                <div className="mt-2 text-xs text-slate-500">
                  {isOfficerScope
                    ? "Aggregate rates are limited to supervisor and administrator scope"
                    : "Passed all applicable rule checks"}
                </div>
              </CardBody>
            </Card>

            <Card>
              <CardBody className="p-5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-red-700 uppercase tracking-wider">
                    Non-Compliant
                  </span>
                  <div className="p-2 bg-red-50 text-red-700 rounded-lg">
                    <AlertOctagon className="w-4 h-4" />
                  </div>
                </div>
                <div className="mt-3 flex items-baseline gap-2">
                  <span className="text-2xl font-bold text-red-700">
                    {(metrics?.nonCompliant ?? 0).toLocaleString()}
                  </span>
                </div>
                <div className="mt-2 text-xs text-slate-500">
                  {(metrics?.totalViolations ?? 0).toLocaleString()} statutory violations recorded
                </div>
              </CardBody>
            </Card>

            <Card>
              <CardBody className="p-5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-amber-700 uppercase tracking-wider">
                    Requires Review
                  </span>
                  <div className="p-2 bg-amber-50 text-amber-700 rounded-lg">
                    <Clock3 className="w-4 h-4" />
                  </div>
                </div>
                <div className="mt-3 flex items-baseline gap-2">
                  <span className="text-2xl font-bold text-amber-700">
                    {(metrics?.requiresReview ?? metrics?.pendingReview ?? 0).toLocaleString()}
                  </span>
                </div>
                <div className="mt-2 text-xs text-slate-500">
                  {(metrics?.processing ?? 0).toLocaleString()} currently processing
                </div>
              </CardBody>
            </Card>
          </section>

          <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Violation distribution - real aggregation only */}
            <Card className="lg:col-span-2">
              <CardHeader
                title="Statutory Violation Distribution"
                description="Detected non-compliance grouped by statutory clause"
              />
              <CardBody className="space-y-4">
                {isOfficerScope ? (
                  <div className="py-8 text-center text-xs text-slate-500">
                    <ShieldCheck className="w-6 h-6 mx-auto text-slate-300 mb-2" />
                    Aggregated violation distribution is available to supervisors and administrators.
                  </div>
                ) : stats?.severityBreakdown && stats.severityBreakdown.length > 0 ? (
                  <>
                    {stats.severityBreakdown.map((item) => (
                      <div key={item.severity} className="space-y-1.5">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-medium text-slate-700">{item.severity}</span>
                          <span className="text-slate-500">
                            {item.count} cases ({item.percentage}%)
                          </span>
                        </div>
                        <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full ${SEVERITY_STYLES[item.severity] ?? "bg-slate-400"}`}
                            style={{ width: `${item.percentage}%` }}
                          />
                        </div>
                      </div>
                    ))}
                    {stats.violationTypeBreakdown && stats.violationTypeBreakdown.length > 0 && (
                      <div className="pt-3 border-t border-slate-100">
                        <div className="text-[11px] font-semibold text-slate-700 mb-2">
                          Most frequent violation types
                        </div>
                        <ul className="space-y-1">
                          {stats.violationTypeBreakdown.slice(0, 5).map((item) => (
                            <li key={item.name} className="flex items-center justify-between text-[11px] text-slate-600">
                              <span className="truncate pr-3">{item.name}</span>
                              <span className="font-semibold text-slate-700">{item.count}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="py-8 text-center text-xs text-slate-500">
                    <ShieldCheck className="w-6 h-6 mx-auto text-slate-300 mb-2" />
                    No statutory violations have been recorded for this scope yet.
                  </div>
                )}
              </CardBody>
              {stats && !isOfficerScope && (
                <CardFooter>
                  <Link
                    href="/analytics"
                    className="text-xs font-medium text-blue-600 hover:text-blue-800 flex items-center gap-1"
                  >
                    Full Analytics <ChevronRight className="w-3.5 h-3.5" />
                  </Link>
                </CardFooter>
              )}
            </Card>

            <Card className="flex flex-col justify-between">
              <CardHeader title="Initiate Fast Inspection" description="Upload commodity packaging for OCR and rule check" />
              <CardBody className="space-y-4">
                {canCreate ? (
                  <div className="border-2 border-dashed border-slate-200 hover:border-slate-300 rounded-xl p-6 text-center transition-colors bg-slate-50/50">
                    <div className="mx-auto w-10 h-10 rounded-full bg-blue-50 text-[#2563EB] flex items-center justify-center mb-3">
                      <ScanSearch className="w-5 h-5" />
                    </div>
                    <h4 className="text-xs font-semibold text-slate-800">Upload Package Image</h4>
                    <p className="text-[11px] text-slate-500 mt-1 max-w-xs mx-auto">
                      Server-side validation enforces JPEG/PNG only, 20MB maximum, before any OCR work begins.
                    </p>
                    <Link href="/inspections/new" className="inline-block mt-4">
                      <Button variant="primary" size="sm">
                        Start Scanning
                      </Button>
                    </Link>
                  </div>
                ) : (
                  <div className="p-6 text-center text-xs text-slate-500 border border-slate-200 rounded-xl">
                    Your role cannot register new scans.
                  </div>
                )}

                <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-600 space-y-1">
                  <div className="font-semibold text-slate-800 flex items-center gap-1.5">
                    <Building2 className="w-3.5 h-3.5 text-slate-500" /> Applicable Regulations
                  </div>
                  <p className="text-[11px] text-slate-500 leading-relaxed">
                    Rule 6 (Declarations), Rule 7 (Principal Display Panel), Rule 8 (Letter &amp; Font Size),
                    Rule 9 (Manner of Declaration).
                  </p>
                </div>
              </CardBody>
            </Card>
          </section>

          <Card>
            <CardHeader
              title="Recent Package Inspections"
              description="Chronological log of commodities screened with automated legal assessment"
              action={
                <Link href="/inspections">
                  <Button variant="secondary" size="sm">
                    View All
                  </Button>
                </Link>
              }
            />
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 text-slate-500 font-semibold border-b border-slate-200">
                  <tr>
                    <th className="px-6 py-3">Inspection ID</th>
                    <th className="px-6 py-3">Commodity &amp; Brand</th>
                    <th className="px-6 py-3">Date &amp; Officer</th>
                    <th className="px-6 py-3">Compliance Status</th>
                    <th className="px-6 py-3 text-center">Score</th>
                    <th className="px-6 py-3 text-center">Review</th>
                    <th className="px-6 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {recentList.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-6 py-10 text-center text-slate-500">
                        {isRefreshing
                          ? "Loading inspections…"
                          : "No inspections recorded for this scope yet. Register one to populate the log."}
                      </td>
                    </tr>
                  ) : (
                    recentList.map((item) => {
                      const score = item.complianceScore ?? null;
                      const { badge, label } = toStatusBadge(item.complianceStatus ?? item.status);

                      return (
                        <tr key={item.id} className="hover:bg-slate-50/80 transition-colors">
                          <td className="px-6 py-3.5 font-mono text-slate-600 font-medium">
                            {item.scanNumber ?? item.id.slice(0, 8)}
                          </td>
                          <td className="px-6 py-3.5">
                            <div className="font-semibold text-slate-900">
                              {item.productName ?? item.location ?? "Unlabelled commodity"}
                            </div>
                            <div className="text-[11px] text-slate-500">
                              {[item.brand, item.category].filter(Boolean).join(" · ") || "No catalogue match"}
                            </div>
                          </td>
                          <td className="px-6 py-3.5">
                            <div className="text-slate-800 font-medium">
                              {item.createdAt
                                ? new Date(item.createdAt).toLocaleString()
                                : "Unknown"}
                            </div>
                            <div className="text-[11px] text-slate-500">{item.inspectorName ?? "—"}</div>
                          </td>
                          <td className="px-6 py-3.5">
                            <StatusBadge status={badge} label={label} size="sm" />
                          </td>
                          <td className="px-6 py-3.5 text-center">
                            <span
                              className={`font-bold px-2 py-0.5 rounded text-xs ${
                                score === null
                                  ? "bg-slate-50 text-slate-400 border border-slate-200"
                                  : score >= 90
                                    ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                                    : score >= 70
                                      ? "bg-amber-50 text-amber-700 border border-amber-200"
                                      : "bg-red-50 text-red-700 border border-red-200"
                              }`}
                            >
                              {score === null ? "n/a" : `${Math.round(score)}%`}
                            </span>
                          </td>
                          <td className="px-6 py-3.5 text-center">
                            <span className="text-[10px] font-semibold tracking-wide text-slate-500">
                              {item.reviewStatus ?? "NOT_SUBMITTED"}
                            </span>
                          </td>
                          <td className="px-6 py-3.5 text-right">
                            <Link
                              href={`/inspections/${item.id}`}
                              className="p-1 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded transition-colors inline-block"
                              title="View Inspection Details & Evidence"
                            >
                              <Eye className="w-4 h-4" />
                            </Link>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
            <CardFooter>
              <span className="text-xs text-slate-500">
                Showing {recentList.length} of {(metrics?.totalInspections ?? 0).toLocaleString()} inspections in
                scope
              </span>
            </CardFooter>
          </Card>

          <footer className="pt-4 border-t border-slate-200 text-center text-xs text-slate-500 space-y-1">
            <p className="font-medium text-slate-600">
              Government of India • Ministry of Consumer Affairs, Food &amp; Public Distribution • Department of
              Consumer Affairs
            </p>
            <p className="text-[11px] text-slate-400 max-w-2xl mx-auto">
              Automated screening assists enforcement officers by extracting declarations and identifying potential
              compliance issues under Legal Metrology (Packaged Commodities) Rules, 2011. Final regulatory
              determination remains subject to authorized officer review.
            </p>
          </footer>
        </main>
      </div>
    </div>
  );
}
