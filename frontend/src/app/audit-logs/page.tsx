"use client";

import React, { useEffect, useState } from "react";
import { Sidebar } from "@/components/layout/Sidebar";
import { TopBar } from "@/components/layout/TopBar";
import { Card, CardHeader, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { History, Shield, Filter, Search } from "lucide-react";
import { ApiRequestError, apiFetch } from "@/lib/session";

interface AuditListPayload {
  logs: any[];
  total: number;
  page: number;
  pageCount: number;
}

export default function AuditLogsPage() {
  const [logs, setLogs] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<AuditListPayload>("/audit-logs")
      .then((data) => {
        setLogs(data.logs ?? []);
        setTotal(data.total ?? 0);
        setError(null);
      })
      .catch((cause: unknown) => {
        setLogs([]);
        setError(
          cause instanceof ApiRequestError
            ? cause.status === 403
              ? "Your role does not have audit log access."
              : cause.message
            : "Unable to reach the enforcement API.",
        );
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex min-h-screen bg-[#F8FAFC]">
        <Sidebar />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-3">
            <div className="w-8 h-8 border-3 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-xs text-slate-500 font-medium">Loading audit trail...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-[#F8FAFC]">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar breadcrumbs={[{ label: "Statutory Audit Trail" }]} />

        <main className="p-8 max-w-7xl w-full mx-auto space-y-6 flex-1">
          <div className="pb-2 border-b border-slate-200">
            <h1 className="text-2xl font-bold text-[#12304A] tracking-tight">
              Statutory Inspection Audit Trail
            </h1>
            <p className="text-sm text-slate-500 mt-1">
              Immutable log of officer reviews, determinations, manual overrides, and report generation (Modules 13 & 18).
            </p>
          </div>

          {error && (
            <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-xs text-red-800">
              {error}
            </div>
          )}

          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 text-slate-500 font-semibold border-b border-slate-200">
                  <tr>
                    <th className="px-6 py-3">Timestamp</th>
                    <th className="px-6 py-3">Officer / User</th>
                    <th className="px-6 py-3">Action Event</th>
                    <th className="px-6 py-3">Target Resource</th>
                    <th className="px-6 py-3">Audit Details &amp; Rationale</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {logs.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-6 py-10 text-center text-slate-500">
                        {error
                          ? "The audit trail could not be loaded."
                          : "No audit events have been recorded yet."}
                      </td>
                    </tr>
                  ) : (
                    logs.map((log: any) => (
                      <tr key={log.id} className="hover:bg-slate-50 transition-colors">
                        <td className="px-6 py-3.5 text-slate-500 font-mono">
                          {new Date(log.timestamp ?? log.createdAt).toLocaleString("en-IN")}
                        </td>
                        <td className="px-6 py-3.5 font-medium text-slate-900">{log.userEmail ?? "—"}</td>
                        <td className="px-6 py-3.5">
                          <span
                            className={`font-mono font-bold px-2 py-0.5 rounded text-[11px] ${
                              log.action?.includes("OVERRIDDEN")
                                ? "bg-amber-50 text-amber-800 border border-amber-200"
                                : log.action?.includes("REPORT")
                                ? "bg-blue-50 text-blue-800 border border-blue-200"
                                : "bg-emerald-50 text-emerald-800 border border-emerald-200"
                            }`}
                          >
                            {log.action}
                          </span>
                        </td>
                        <td className="px-6 py-3.5 font-mono text-slate-600">
                          {log.resourceType}: {log.resourceId}
                        </td>
                        <td className="px-6 py-3.5 text-slate-600 max-w-md">
                          {log.details?.notes || (log.details ? JSON.stringify(log.details) : "—")}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="px-6 py-3 text-xs text-slate-500 border-t border-slate-100">
              {logs.length} of {total.toLocaleString()} audit events
            </div>
          </Card>
        </main>
      </div>
    </div>
  );
}
