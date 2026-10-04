"use client";

/**
 * Runtime diagnostics.
 *
 * Read-only by design: the inspection pipeline is configured through backend
 * environment variables, not through the browser. This page reports the actual
 * effective configuration from `GET /api/system/status` (SYSTEM_CONFIGURE only)
 * so an operator can verify what the running service is really using.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Sidebar } from "@/components/layout/Sidebar";
import { TopBar } from "@/components/layout/TopBar";
import { Card, CardHeader, CardBody } from "@/components/ui/Card";
import { CheckCircle2, AlertTriangle, Loader2, Server } from "lucide-react";
import { ApiRequestError, apiFetch } from "@/lib/session";

interface SystemStatus {
  status: "healthy" | "degraded";
  service: string;
  version: string;
  environment: string;
  timestamp: string;
  uptimeSeconds: number;
  system: { memoryMb: number; nodeVersion: string };
  features: { demoAuth: boolean; mediaSigningConfigured: boolean; geminiConfigured: boolean };
  pipeline: {
    geminiModel: string;
    analysisTimeoutMs: number;
    uploadMaxBytes: number;
    uploadMaxFiles: number;
    mediaUrlTtlSeconds: number;
    storageBucket: string;
  };
  dependencies: Record<
    string,
    { status: "connected" | "error"; latencyMs: number; error?: string }
  >;
}

function Badge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase border ${
        ok
          ? "bg-emerald-50 text-emerald-700 border-emerald-200"
          : "bg-red-50 text-red-700 border-red-200"
      }`}
    >
      {ok ? <CheckCircle2 className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />}
      {label}
    </span>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-slate-100 last:border-0 text-xs">
      <span className="text-slate-500">{label}</span>
      <span className="font-mono text-slate-800 text-right">{value}</span>
    </div>
  );
}

const formatMb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

export default function SettingsPage() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await apiFetch<SystemStatus>("/system/status"));
      setError(null);
    } catch (cause) {
      setStatus(null);
      setError(
        cause instanceof ApiRequestError
          ? cause.status === 403
            ? "Your role does not have system configuration access."
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

  return (
    <div className="flex min-h-screen bg-[#F8FAFC]">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar breadcrumbs={[{ label: "System Status" }]} onRefresh={load} isRefreshing={loading} />

        <main className="p-8 max-w-4xl w-full mx-auto space-y-6 flex-1">
          <div className="pb-2 border-b border-slate-200">
            <h1 className="text-2xl font-bold text-[#12304A] tracking-tight">
              Inspection Engine Runtime Status
            </h1>
            <p className="text-sm text-slate-500 mt-1">
              Effective configuration of the running backend. Values are supplied by environment
              configuration and cannot be edited from the browser, so no control is offered here.
            </p>
          </div>

          {error && (
            <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-xs text-red-800">{error}</div>
          )}

          {loading && !status ? (
            <div className="flex items-center justify-center py-16 gap-2 text-xs text-slate-500">
              <Loader2 className="w-4 h-4 animate-spin" /> Querying runtime status…
            </div>
          ) : status ? (
            <>
              <Card>
                <CardHeader
                  title="Service"
                  description={status.service}
                  action={<Badge ok={status.status === "healthy"} label={status.status} />}
                />
                <CardBody>
                  <Row label="Version" value={status.version} />
                  <Row label="Environment" value={status.environment} />
                  <Row label="Runtime" value={`${status.system.nodeVersion} · ${status.system.memoryMb} MB heap`} />
                  <Row label="Uptime" value={`${Math.floor(status.uptimeSeconds / 60)}m ${status.uptimeSeconds % 60}s`} />
                  <Row label="Checked at" value={new Date(status.timestamp).toLocaleString("en-IN")} />
                </CardBody>
              </Card>

              <Card>
                <CardHeader title="Dependencies" description="Live connectivity probes" />
                <CardBody className="space-y-3">
                  {Object.entries(status.dependencies).map(([name, dependency]) => (
                    <div
                      key={name}
                      className="flex items-center justify-between p-3 bg-slate-50 border border-slate-200 rounded-lg"
                    >
                      <div>
                        <div className="text-xs font-semibold text-slate-800 capitalize">{name}</div>
                        {dependency.error && (
                          <div className="text-[10.5px] text-red-700 mt-0.5 font-mono break-all">
                            {dependency.error}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-slate-500">{dependency.latencyMs}ms</span>
                        <Badge ok={dependency.status === "connected"} label={dependency.status} />
                      </div>
                    </div>
                  ))}
                  {status.dependencies.postgres?.status !== "connected" && (
                    <p className="text-[11px] text-amber-700 flex items-start gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      PostgreSQL is unreachable, so the platform is serving from its in-memory store.
                      Records will not persist across restarts.
                    </p>
                  )}
                </CardBody>
              </Card>

              <Card>
                <CardHeader
                  title="Security Features"
                  description="Hardening state reported by the service"
                />
                <CardBody className="space-y-2 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-600">Role-based demo authentication</span>
                    <Badge ok={!status.features.demoAuth} label={status.features.demoAuth ? "ENABLED" : "DISABLED"} />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-600">Signed media URL secret</span>
                    <Badge
                      ok={status.features.mediaSigningConfigured}
                      label={status.features.mediaSigningConfigured ? "CONFIGURED" : "MISSING"}
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-600">Gemini extraction credential</span>
                    <Badge
                      ok={status.features.geminiConfigured}
                      label={status.features.geminiConfigured ? "CONFIGURED" : "MISSING"}
                    />
                  </div>
                  {status.features.demoAuth && (
                    <p className="text-[11px] text-amber-700 pt-1">
                      Demo identities are active because this deployment is not running in production mode.
                    </p>
                  )}
                </CardBody>
              </Card>

              <Card>
                <CardHeader
                  title="Pipeline Limits"
                  description="Server-side enforcement values applied to every request"
                />
                <CardBody>
                  <Row label="Gemini model" value={status.pipeline.geminiModel} />
                  <Row label="Analysis timeout" value={`${status.pipeline.analysisTimeoutMs} ms`} />
                  <Row label="Maximum upload size" value={formatMb(status.pipeline.uploadMaxBytes)} />
                  <Row label="Maximum images per scan" value={String(status.pipeline.uploadMaxFiles)} />
                  <Row label="Media URL lifetime" value={`${status.pipeline.mediaUrlTtlSeconds}s`} />
                  <Row label="Storage bucket" value={status.pipeline.storageBucket} />
                </CardBody>
              </Card>
            </>
          ) : (
            <div className="p-6 bg-white border border-slate-200 rounded-xl text-center text-xs text-slate-500 flex items-center justify-center gap-2">
              <Server className="w-4 h-4" /> Runtime status unavailable.
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
