"use client";

/**
 * Compliance analytics.
 *
 * Served by `GET /api/analytics` (requires ANALYTICS_VIEW). Every metric is
 * derived from recorded inspections; an empty dataset renders zeros, never
 * illustrative figures.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Sidebar } from "@/components/layout/Sidebar";
import { TopBar } from "@/components/layout/TopBar";
import { Card, CardHeader, CardBody } from "@/components/ui/Card";
import { AlertTriangle, Loader2 } from "lucide-react";
import { ApiRequestError, apiFetch } from "@/lib/session";

interface AnalyticsPayload {
  kpi: {
    totalInspections: number;
    compliant: number;
    nonCompliant: number;
    requiresReview: number;
    complianceRatePercentage: number;
    violationRatePercentage: number;
    totalViolations: number;
    violationsPerInspection: number;
    pendingReviews: number;
    averageConfidence: number | null;
    averageProcessingTimeSeconds: number | null;
  };
  agreement: {
    totalReviewed: number;
    aiAccepted: number;
    aiOverridden: number;
    rejectedForReinspection: number;
    agreementRatePercentage: number | null;
    overrideRatePercentage: number | null;
  };
  severity: Record<string, number>;
  topViolationTypes: { name: string; count: number }[];
  categories: { name: string; total: number; compliant: number; rate: number }[];
}

const SEVERITY_TONE: Record<string, string> = {
  CRITICAL: "text-red-700",
  HIGH: "text-orange-700",
  MEDIUM: "text-amber-700",
  LOW: "text-blue-700",
};

export default function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await apiFetch<AnalyticsPayload>("/analytics"));
      setError(null);
    } catch (cause) {
      setData(null);
      setError(
        cause instanceof ApiRequestError
          ? cause.status === 403
            ? "Your role does not have analytics access."
            : cause.message
          : "Unable to reach the enforcement API.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const kpi = data?.kpi;
  const agreement = data?.agreement;
  const topViolation = data?.topViolationTypes?.[0];

  return (
    <div className="flex min-h-screen bg-[#F8FAFC]">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar breadcrumbs={[{ label: "Compliance Analytics" }]} onRefresh={load} isRefreshing={loading} />

        <main className="p-8 max-w-7xl w-full mx-auto space-y-6 flex-1">
          <div className="pb-2 border-b border-slate-200">
            <h1 className="text-2xl font-bold text-[#12304A] tracking-tight">
              Compliance Intelligence &amp; Enforcement Analytics
            </h1>
            <p className="text-sm text-slate-500 mt-1">
              Cross-category compliance metrics, violation frequency distributions, and AI-versus-human agreement.
            </p>
          </div>

          {error && (
            <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-xs text-red-800">{error}</div>
          )}

          {loading && !data ? (
            <div className="flex items-center justify-center py-16 gap-2 text-xs text-slate-500">
              <Loader2 className="w-4 h-4 animate-spin" /> Computing analytics…
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <Card>
                  <CardBody className="p-6 text-center space-y-2">
                    <span className="text-xs text-slate-500 font-semibold uppercase">Overall Screening Pass Rate</span>
                    <div className="text-4xl font-extrabold text-emerald-700">
                      {kpi?.complianceRatePercentage ?? 0}%
                    </div>
                    <p className="text-xs text-slate-400">
                      Based on {(kpi?.totalInspections ?? 0).toLocaleString()} recorded inspections
                    </p>
                  </CardBody>
                </Card>

                <Card>
                  <CardBody className="p-6 text-center space-y-2">
                    <span className="text-xs text-slate-500 font-semibold uppercase">Most Frequent Infraction</span>
                    <div className="text-xl font-bold text-red-700">
                      {topViolation ? topViolation.name : "No violations recorded"}
                    </div>
                    <p className="text-xs text-slate-400">
                      {topViolation ? `${topViolation.count} occurrence(s)` : "Awaiting first inspection result"}
                    </p>
                  </CardBody>
                </Card>

                <Card>
                  <CardBody className="p-6 text-center space-y-2">
                    <span className="text-xs text-slate-500 font-semibold uppercase">Human Override Rate</span>
                    <div className="text-4xl font-extrabold text-[#12304A]">
                      {agreement?.overrideRatePercentage ?? "—"}
                      {agreement?.overrideRatePercentage != null ? "%" : ""}
                    </div>
                    <p className="text-xs text-slate-400">
                      {(agreement?.totalReviewed ?? 0).toLocaleString()} officer determination(s) logged
                    </p>
                  </CardBody>
                </Card>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <Card>
                  <CardHeader
                    title="Commodity Category Compliance Rates"
                    description="Pass versus fail rates by product sector"
                  />
                  <CardBody className="space-y-5">
                    {data?.categories?.length ? (
                      data.categories.map((item) => (
                        <div key={item.name} className="space-y-2 text-xs">
                          <div className="flex items-center justify-between">
                            <span className="font-semibold text-slate-800">{item.name}</span>
                            <span className="text-slate-500 font-medium">
                              {item.compliant} pass / {item.total - item.compliant} fail ({item.rate}%)
                            </span>
                          </div>
                          <div className="h-3 w-full bg-slate-100 rounded-full overflow-hidden flex">
                            <div className="h-full bg-emerald-600" style={{ width: `${item.rate}%` }} />
                            <div className="h-full bg-red-500" style={{ width: `${100 - item.rate}%` }} />
                          </div>
                        </div>
                      ))
                    ) : (
                      <p className="text-xs text-slate-500 py-6 text-center">
                        No inspections have been categorised yet.
                      </p>
                    )}
                  </CardBody>
                </Card>

                <Card>
                  <CardHeader
                    title="Violation Severity &amp; AI Reliability"
                    description="Severity distribution and extraction confidence"
                  />
                  <CardBody className="space-y-4">
                    <div className="grid grid-cols-2 gap-3">
                      {Object.entries(data?.severity ?? {}).map(([severity, count]) => (
                        <div key={severity} className="p-3 border border-slate-200 rounded-lg">
                          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                            {severity}
                          </div>
                          <div className={`text-xl font-bold ${SEVERITY_TONE[severity] ?? "text-slate-700"}`}>
                            {count}
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="pt-3 border-t border-slate-100 space-y-2 text-xs text-slate-600">
                      <div className="flex items-center justify-between">
                        <span>AI determinations accepted</span>
                        <strong className="text-slate-800">{agreement?.aiAccepted ?? 0}</strong>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>Manually overridden</span>
                        <strong className="text-slate-800">{agreement?.aiOverridden ?? 0}</strong>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>Returned for re-inspection</span>
                        <strong className="text-slate-800">{agreement?.rejectedForReinspection ?? 0}</strong>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>Human/AI agreement</span>
                        <strong className="text-slate-800">
                          {agreement?.agreementRatePercentage != null
                            ? `${agreement.agreementRatePercentage}%`
                            : "Not enough reviewed data"}
                        </strong>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>Average extraction confidence</span>
                        <strong className="text-slate-800">
                          {kpi?.averageConfidence != null ? kpi.averageConfidence : "n/a"}
                        </strong>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>Average pipeline duration</span>
                        <strong className="text-slate-800">
                          {kpi?.averageProcessingTimeSeconds != null
                            ? `${kpi.averageProcessingTimeSeconds}s`
                            : "n/a"}
                        </strong>
                      </div>
                    </div>
                  </CardBody>
                </Card>
              </div>

              <Card>
                <CardHeader title="Top Violation Types" description="Most frequently detected non-compliance classes" />
                <CardBody>
                  {data?.topViolationTypes?.length ? (
                    <ul className="space-y-2 text-xs">
                      {data.topViolationTypes.map((item, index) => (
                        <li
                          key={item.name}
                          className="flex items-center justify-between py-1.5 border-b border-slate-100 last:border-0"
                        >
                          <span className="text-slate-700">
                            <span className="font-mono text-slate-400 mr-2">{index + 1}</span>
                            {item.name}
                          </span>
                          <span className="font-semibold text-slate-800">{item.count}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-slate-500 py-6 text-center flex items-center justify-center gap-2">
                      <AlertTriangle className="w-3.5 h-3.5" /> No violations have been detected yet.
                    </p>
                  )}
                </CardBody>
              </Card>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
