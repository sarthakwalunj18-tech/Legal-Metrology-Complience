"use client";

/**
 * Generated statutory reports.
 *
 * Lists reports from `GET /api/reports` (requires REPORT_VIEW). Download links
 * are short-lived signed URLs issued by the API; the storage path is never
 * exposed to the browser.
 */
import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Sidebar } from "@/components/layout/Sidebar";
import { TopBar } from "@/components/layout/TopBar";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatusBadge, type StatusType } from "@/components/ui/Badge";
import { Download, ExternalLink, Loader2 } from "lucide-react";
import { ApiRequestError, apiFetch } from "@/lib/session";

interface ReportRow {
  id: string;
  reportNumber: string;
  format?: string | null;
  scanId: string;
  scanNumber?: string | null;
  productName?: string | null;
  complianceStatus?: string | null;
  location?: string | null;
  generatedAt: string;
  downloadUrl?: string | null;
}

interface ReportListPayload {
  reports: ReportRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  scope: "own" | "department" | "global";
}

const SCOPE_LABEL: Record<string, string> = {
  own: "Reports for your inspections",
  department: "Department reports",
  global: "All departments",
};

export default function ReportsPage() {
  const [data, setData] = useState<ReportListPayload | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await apiFetch<ReportListPayload>(`/reports?page=${page}&pageSize=20`));
      setError(null);
    } catch (cause) {
      setData(null);
      setError(
        cause instanceof ApiRequestError
          ? cause.status === 403
            ? "Your role does not have report access."
            : cause.message
          : "Unable to reach the enforcement API.",
      );
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex min-h-screen bg-[#F8FAFC]">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar breadcrumbs={[{ label: "Statutory Reports" }]} onRefresh={load} isRefreshing={loading} />

        <main className="p-8 max-w-7xl w-full mx-auto space-y-6 flex-1">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 pb-2 border-b border-slate-200">
            <div>
              <h1 className="text-2xl font-bold text-[#12304A] tracking-tight">
                Generated Statutory Inspection Reports
              </h1>
              <p className="text-sm text-slate-500 mt-1">
                Official PDF records generated under the Legal Metrology Act, 2009.{" "}
                {data ? SCOPE_LABEL[data.scope] : ""}
              </p>
            </div>
            {data && (
              <span className="text-xs text-slate-500">{data.total.toLocaleString()} report(s)</span>
            )}
          </div>

          {error && (
            <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-xs text-red-800">{error}</div>
          )}

          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 text-slate-500 font-semibold border-b border-slate-200">
                  <tr>
                    <th className="px-6 py-3">Report Number</th>
                    <th className="px-6 py-3">Commodity</th>
                    <th className="px-6 py-3">Date Generated</th>
                    <th className="px-6 py-3">Outcome</th>
                    <th className="px-6 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {loading && !data ? (
                    <tr>
                      <td colSpan={5} className="px-6 py-10 text-center text-slate-500">
                        <Loader2 className="w-4 h-4 mx-auto mb-2 animate-spin" />
                        Loading reports…
                      </td>
                    </tr>
                  ) : !data || data.reports.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-6 py-10 text-center text-slate-500">
                        {error
                          ? "Reports could not be loaded."
                          : "No statutory reports have been generated in this scope yet."}
                      </td>
                    </tr>
                  ) : (
                    data.reports.map((report) => (
                      <tr key={report.id} className="hover:bg-slate-50 transition-colors">
                        <td className="px-6 py-3.5 font-mono font-semibold text-slate-900">
                          {report.reportNumber}
                          <div className="text-[10px] font-sans text-slate-400">
                            {report.format ?? "PDF"} · {report.scanNumber ?? report.scanId.slice(0, 8)}
                          </div>
                        </td>
                        <td className="px-6 py-3.5 font-medium">
                          {report.productName ?? "Unnamed commodity"}
                          <div className="text-[11px] text-slate-500">{report.location ?? "—"}</div>
                        </td>
                        <td className="px-6 py-3.5 text-slate-500">
                          {new Date(report.generatedAt).toLocaleString("en-IN")}
                        </td>
                        <td className="px-6 py-3.5">
                          <StatusBadge
                            status={(report.complianceStatus as StatusType) ?? "NEUTRAL"}
                            label={report.complianceStatus ?? "Not determined"}
                            size="sm"
                          />
                        </td>
                        <td className="px-6 py-3.5 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <Link href={`/inspections/${report.scanId}`}>
                              <Button variant="secondary" size="sm" icon={<ExternalLink className="w-3.5 h-3.5" />}>
                                Inspection
                              </Button>
                            </Link>
                            {report.downloadUrl ? (
                              <a href={report.downloadUrl} target="_blank" rel="noopener noreferrer">
                                <Button variant="primary" size="sm" icon={<Download className="w-3.5 h-3.5" />}>
                                  PDF
                                </Button>
                              </a>
                            ) : (
                              <span className="text-[11px] text-slate-400">No stored file</span>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {data && data.pageCount > 1 && (
              <div className="flex items-center justify-between px-6 py-3 border-t border-slate-100">
                <span className="text-xs text-slate-500">
                  Page {data.page} of {data.pageCount}
                </span>
                <div className="flex items-center gap-2">
                  <Button variant="secondary" size="sm" disabled={data.page <= 1} onClick={() => setPage(data.page - 1)}>
                    Previous
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={data.page >= data.pageCount}
                    onClick={() => setPage(data.page + 1)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </Card>
        </main>
      </div>
    </div>
  );
}
