"use client";

/**
 * Supervisor review workspace (Module 13).
 *
 * The human-in-the-loop half of the pipeline. Shows the AI determination, the
 * evidence behind it and the statutory rule it was measured against, then
 * records one of four outcomes: accept, reject, override, or send back for
 * re-inspection. Every outcome is written to the audit trail server-side, so
 * nothing is decided only in the browser.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Sidebar } from "@/components/layout/Sidebar";
import { TopBar } from "@/components/layout/TopBar";
import { Button } from "@/components/ui/Button";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ClipboardCheck,
  Gavel,
  Loader2,
  RotateCcw,
  Scale,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { ApiRequestError, apiFetch, useSession } from "@/lib/session";
import {
  parseBoundingBox,
  toPercent,
  type RAGCitation,
  type ScanDetailPayload,
  type ScanRow,
  type Violation,
} from "@/lib/domain";

type Decision = "ACCEPTED" | "REJECTED" | "OVERRIDDEN" | "REINSPECTION_REQUIRED";

interface DecisionResult {
  decision: Decision;
  notes: string;
  overriddenStatus?: "COMPLIANT" | "NON_COMPLIANT" | "REQUIRES_REVIEW";
}

const STATUS_TONE: Record<string, string> = {
  COMPLIANT: "bg-emerald-50 text-emerald-700 border-emerald-200",
  NON_COMPLIANT: "bg-red-50 text-red-700 border-red-200",
  REQUIRES_REVIEW: "bg-amber-50 text-amber-800 border-amber-200",
};

const SEVERITY_TONE: Record<string, string> = {
  CRITICAL: "bg-red-600 text-white",
  HIGH: "bg-red-50 text-red-700 border border-red-200",
  MEDIUM: "bg-amber-50 text-amber-800 border border-amber-200",
  LOW: "bg-slate-100 text-slate-600 border border-slate-200",
};

function StatusPill({ status }: { status: string | null }) {
  const label = status ?? "NOT ASSESSED";
  return (
    <span
      className={`inline-flex items-center px-2.5 py-1 rounded-md text-[11px] font-bold tracking-wide border ${
        STATUS_TONE[label] ?? "bg-slate-100 text-slate-600 border-slate-200"
      }`}
    >
      {label.replace(/_/g, " ")}
    </span>
  );
}

function ConfidenceMeter({ value }: { value: number | null }) {
  if (value === null) return <span className="text-xs text-slate-400">Not recorded</span>;
  const tone = value >= 90 ? "text-emerald-600" : value >= 70 ? "text-amber-600" : "text-red-600";
  return (
    <span className={`inline-flex items-baseline gap-1 font-mono text-sm font-bold ${tone}`}>
      {value}%
      <span className="text-[10px] font-medium text-slate-400 uppercase tracking-wide">confidence</span>
    </span>
  );
}

/** Evidence viewer: the product image with the offending region outlined. */
function EvidencePanel({
  imageUrl,
  violation,
}: {
  imageUrl: string | null;
  violation: Violation | null;
}) {
  const box = parseBoundingBox(violation?.boundingBox);

  return (
    <div className="space-y-3">
      <div className="relative rounded-xl border border-slate-200 bg-slate-50 overflow-hidden">
        {imageUrl ? (
          // The evidence URL is short-lived and signed by the backend, so
          // next/image cannot fetch it through the optimiser.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageUrl}
            alt="Packaged commodity under inspection"
            className="w-full object-contain max-h-[520px]"
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-64 text-slate-400 gap-2">
            <AlertTriangle className="w-6 h-6" />
            <p className="text-xs">No evidence image is available for this inspection.</p>
          </div>
        )}

        {box && imageUrl ? (
          <div
            className="absolute border-2 border-red-500 bg-red-500/10 rounded-sm shadow-[0_0_0_9999px_rgba(15,23,42,0.35)] pointer-events-none"
            style={{
              left: `${box.x * 100}%`,
              top: `${box.y * 100}%`,
              width: `${box.width * 100}%`,
              height: `${box.height * 100}%`,
            }}
          >
            <span className="absolute -top-6 left-0 bg-red-600 text-white text-[10px] font-bold px-1.5 py-0.5 rounded">
              Detected region
            </span>
          </div>
        ) : null}
      </div>

      {violation ? (
        <dl className="grid grid-cols-2 gap-3 text-xs">
          <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
            <dt className="text-slate-500 font-semibold uppercase text-[10px] tracking-wide">
              Extracted value
            </dt>
            <dd className="mt-1 font-mono text-[#12304A] font-bold break-words">
              {violation.extractedEvidence || "—"}
            </dd>
          </div>
          <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
            <dt className="text-slate-500 font-semibold uppercase text-[10px] tracking-wide">
              Detection confidence
            </dt>
            <dd className="mt-1">
              <ConfidenceMeter value={toPercent(violation.confidence)} />
            </dd>
          </div>
          <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 col-span-2">
            <dt className="text-slate-500 font-semibold uppercase text-[10px] tracking-wide">
              Applicable rule
            </dt>
            <dd className="mt-1 text-[#12304A] font-bold">
              {violation.ruleId}
              {violation.violationType ? ` — ${violation.violationType}` : ""}
            </dd>
          </div>
          <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 col-span-2">
            <dt className="text-slate-500 font-semibold uppercase text-[10px] tracking-wide">
              Compliance reasoning
            </dt>
            <dd className="mt-1 text-slate-700 leading-relaxed">{violation.description}</dd>
            {violation.suggestedAction ? (
              <dd className="mt-2 text-[11px] text-slate-500">
                <span className="font-semibold">Suggested action:</span> {violation.suggestedAction}
              </dd>
            ) : null}
          </div>
        </dl>
      ) : (
        <p className="text-xs text-slate-500">
          No violation selected. The engine found nothing that breaches a statutory declaration
          requirement on this package.
        </p>
      )}
    </div>
  );
}

export default function ReviewsPage() {
  const { can, loading: sessionLoading } = useSession();

  const [queue, setQueue] = useState<ScanRow[]>([]);
  const [scope, setScope] = useState<string>("own");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ScanDetailPayload | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [activeViolationId, setActiveViolationId] = useState<string | null>(null);

  const [notes, setNotes] = useState("");
  const [overrideStatus, setOverrideStatus] = useState<"COMPLIANT" | "NON_COMPLIANT" | "REQUIRES_REVIEW">(
    "COMPLIANT",
  );
  const [submitting, setSubmitting] = useState<Decision | null>(null);
  const [banner, setBanner] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const loadQueue = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await apiFetch<{ reviews: ScanRow[]; count: number; scope: string }>(
        "/reviews",
      );
      setQueue(payload.reviews ?? []);
      setScope(payload.scope ?? "own");
      setError(null);
      setSelectedId((current) => current ?? payload.reviews?.[0]?.id ?? null);
    } catch (cause) {
      setQueue([]);
      setError(
        cause instanceof ApiRequestError
          ? cause.status === 403
            ? "Your role does not include inspection review."
            : cause.message
          : "Unable to reach the enforcement API.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }

    let cancelled = false;
    setDetailLoading(true);
    apiFetch<ScanDetailPayload>(`/scans/${encodeURIComponent(selectedId)}`)
      .then((payload) => {
        if (cancelled) return;
        setDetail(payload);
        setActiveViolationId(payload.violations?.[0]?.id ?? null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setDetail(null);
        setBanner({
          tone: "error",
          text:
            cause instanceof ApiRequestError
              ? cause.message
              : "Unable to load the inspection evidence.",
        });
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const violations = useMemo(() => detail?.violations ?? [], [detail]);
  const activeViolation = useMemo(
    () => violations.find((violation) => violation.id === activeViolationId) ?? violations[0] ?? null,
    [violations, activeViolationId],
  );
  const evidenceImage = detail?.images?.[0]?.url ?? null;

  const citations: RAGCitation[] = useMemo(() => {
    const fromAnalysis = detail?.analysis?.legalContext;
    return Array.isArray(fromAnalysis) ? fromAnalysis : [];
  }, [detail]);

  const submit = useCallback(
    async (decision: Decision) => {
      if (!selectedId) return;
      if (notes.trim().length < 2) {
        setBanner({ tone: "error", text: "Reviewer notes are required before recording a determination." });
        return;
      }
      if (decision === "OVERRIDDEN" && overrideStatus === detail?.scan.complianceStatus) {
        setBanner({
          tone: "error",
          text: "The override status matches the AI decision — use “Accept AI decision” instead.",
        });
        return;
      }

      const result: DecisionResult = { decision, notes: notes.trim() };
      if (decision === "OVERRIDDEN") result.overriddenStatus = overrideStatus;

      setSubmitting(decision);
      setBanner(null);
      try {
        await apiFetch(`/reviews/${encodeURIComponent(selectedId)}/decision`, {
          method: "POST",
          json: result,
        });
        setBanner({
          tone: "ok",
          text: `Determination recorded (${decision.replace(/_/g, " ").toLowerCase()}) and written to the audit trail.`,
        });
        setNotes("");
        await loadQueue();
        setSelectedId(null);
      } catch (cause) {
        setBanner({
          tone: "error",
          text:
            cause instanceof ApiRequestError
              ? cause.message
              : "The determination could not be recorded.",
        });
      } finally {
        setSubmitting(null);
      }
    },
    [selectedId, notes, overrideStatus, detail?.scan.complianceStatus, loadQueue],
  );

  if (sessionLoading || loading) {
    return (
      <div className="flex min-h-screen bg-[#F8FAFC]">
        <Sidebar />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-3">
            <Loader2 className="w-7 h-7 border-3 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-xs text-slate-500 font-medium">Loading review queue...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-[#F8FAFC]">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar breadcrumbs={[{ label: "Supervisor Review" }]} />

        <main className="p-6 lg:p-8 max-w-[1600px] w-full mx-auto space-y-6 flex-1">
          <div className="pb-2 border-b border-slate-200 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold text-[#12304A] tracking-tight flex items-center gap-2">
                <Scale className="w-6 h-6 text-blue-700" />
                Human Review Queue
              </h1>
              <p className="text-sm text-slate-500 mt-1">
                Verify the AI determination against the evidence and the statutory rule, then record a
                determination. Scope: <span className="font-semibold">{scope}</span>.
              </p>
            </div>
            <Link href="/inspections">
              <Button variant="secondary">
                <ArrowLeft className="w-3.5 h-3.5 mr-1.5" />
                All inspections
              </Button>
            </Link>
          </div>

          {banner ? (
            <div
              role="status"
              className={`p-3 rounded-xl border text-xs font-medium ${
                banner.tone === "ok"
                  ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                  : "bg-red-50 border-red-200 text-red-800"
              }`}
            >
              {banner.text}
            </div>
          ) : null}

          {error ? (
            <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-900">
              {error}
            </div>
          ) : null}

          <div className="grid grid-cols-1 xl:grid-cols-[320px_minmax(0,1fr)] gap-6 items-start">
            {/* Queue */}
            <section
              aria-label="Inspections awaiting review"
              className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden"
            >
              <header className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
                <h2 className="text-xs font-bold text-[#12304A] uppercase tracking-wide">
                  Awaiting determination
                </h2>
                <span className="text-[11px] font-mono text-slate-500 bg-white border border-slate-200 rounded px-1.5 py-0.5">
                  {queue.length}
                </span>
              </header>

              {queue.length === 0 ? (
                <div className="p-8 text-center">
                  <ClipboardCheck className="w-7 h-7 text-emerald-500 mx-auto mb-2" />
                  <p className="text-xs font-semibold text-slate-700">Queue is clear</p>
                  <p className="text-[11px] text-slate-500 mt-1">
                    No inspection in your scope is awaiting a determination.
                  </p>
                </div>
              ) : (
                <ul className="divide-y divide-slate-100 max-h-[70vh] overflow-y-auto">
                  {queue.map((row) => {
                    const item = row as Record<string, unknown>;
                    const id = String(item.id);
                    const active = id === selectedId;
                    return (
                      <li key={id}>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedId(id);
                            setNotes("");
                            setBanner(null);
                          }}
                          aria-current={active ? "true" : undefined}
                          className={`w-full text-left px-4 py-3 transition-colors ${
                            active ? "bg-blue-50 border-l-2 border-blue-600" : "hover:bg-slate-50 border-l-2 border-transparent"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono text-xs font-bold text-[#12304A]">
                              {String(item.scanNumber ?? id)}
                            </span>
                            <StatusPill
                              status={(item.complianceStatus as string | null) ?? null}
                            />
                          </div>
                          <p className="text-[11px] text-slate-500 mt-1 truncate">
                            {String(item.location ?? "Location not recorded")}
                          </p>
                          <p className="text-[10px] text-slate-400 mt-0.5">
                            {item.createdAt ? new Date(String(item.createdAt)).toLocaleString() : "—"}
                          </p>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {/* Case file */}
            <section className="space-y-5 min-w-0">
              {!selectedId ? (
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-12 text-center">
                  <ClipboardCheck className="w-8 h-8 text-slate-300 mx-auto mb-3" />
                  <p className="text-sm font-semibold text-slate-600">Select an inspection to review</p>
                  <p className="text-xs text-slate-500 mt-1">
                    The evidence, applicable rules and determination panel appear here.
                  </p>
                </div>
              ) : detailLoading || !detail ? (
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-12 text-center">
                  <Loader2 className="w-6 h-6 border-3 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto" />
                  <p className="text-xs text-slate-500 mt-3">Loading evidence and rules...</p>
                </div>
              ) : (
                <>
                  <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                    <header className="px-5 py-4 border-b border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="font-mono text-sm font-bold text-[#12304A]">
                          {detail.scan.scanNumber}
                        </p>
                        <p className="text-[11px] text-slate-500 mt-0.5">
                          {detail.scan.location ?? "Location not recorded"} ·{" "}
                          {new Date(detail.scan.createdAt).toLocaleString()}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <StatusPill status={detail.scan.complianceStatus} />
                        <Link href={`/inspections/${detail.scan.id}`}>
                          <Button variant="ghost" className="text-[11px]">
                            Open full workspace
                          </Button>
                        </Link>
                      </div>
                    </header>

                    <div className="p-5 grid grid-cols-2 lg:grid-cols-4 gap-4">
                      <div>
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">
                          AI decision
                        </p>
                        <p className="text-sm font-bold text-[#12304A] mt-0.5">
                          {detail.scan.complianceStatus?.replace(/_/g, " ") ?? "—"}
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">
                          Compliance score
                        </p>
                        <p className="text-sm font-bold text-[#12304A] mt-0.5 font-mono">
                          {detail.scan.complianceScore ? `${detail.scan.complianceScore}%` : "—"}
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">
                          Violations
                        </p>
                        <p className="text-sm font-bold text-[#12304A] mt-0.5">{violations.length}</p>
                      </div>
                      <div>
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">
                          Mean confidence
                        </p>
                        <p className="mt-0.5">
                          <ConfidenceMeter
                            value={
                              violations.length
                                ? Math.round(
                                    violations.reduce(
                                      (sum, violation) => sum + (toPercent(violation.confidence) ?? 0),
                                      0,
                                    ) / violations.length,
                                  )
                                : null
                            }
                          />
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                    <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
                      <h2 className="text-xs font-bold text-[#12304A] uppercase tracking-wide mb-3">
                        Evidence
                      </h2>
                      <EvidencePanel imageUrl={evidenceImage} violation={activeViolation} />
                    </div>

                    <div className="space-y-5">
                      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                        <header className="px-5 py-3 border-b border-slate-200 bg-slate-50">
                          <h2 className="text-xs font-bold text-[#12304A] uppercase tracking-wide">
                            Violations ({violations.length})
                          </h2>
                        </header>
                        {violations.length === 0 ? (
                          <p className="p-5 text-xs text-slate-500">
                            The deterministic engine raised no violations for this package.
                          </p>
                        ) : (
                          <ul className="divide-y divide-slate-100">
                            {violations.map((violation) => (
                              <li key={violation.id}>
                                <button
                                  type="button"
                                  onClick={() => setActiveViolationId(violation.id)}
                                  className={`w-full text-left px-5 py-3 transition-colors ${
                                    violation.id === activeViolation?.id
                                      ? "bg-blue-50"
                                      : "hover:bg-slate-50"
                                  }`}
                                >
                                  <div className="flex items-start justify-between gap-2">
                                    <span className="text-xs font-bold text-[#12304A]">
                                      {violation.title}
                                    </span>
                                    <span
                                      className={`shrink-0 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide ${
                                        SEVERITY_TONE[violation.severity] ??
                                        "bg-slate-100 text-slate-600 border border-slate-200"
                                      }`}
                                    >
                                      {violation.severity}
                                    </span>
                                  </div>
                                  <p className="text-[10px] font-mono text-slate-500 mt-1">
                                    {violation.ruleId}
                                  </p>
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>

                      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                        <header className="px-5 py-3 border-b border-slate-200 bg-slate-50 flex items-center gap-2">
                          <Gavel className="w-3.5 h-3.5 text-blue-700" />
                          <h2 className="text-xs font-bold text-[#12304A] uppercase tracking-wide">
                            Retrieved statute
                          </h2>
                        </header>
                        {citations.length === 0 ? (
                          <p className="p-5 text-xs text-slate-500">
                            No RAG citation was attached to this determination.
                          </p>
                        ) : (
                          <ul className="divide-y divide-slate-100">
                            {citations.map((citation, index) => (
                              <li key={`${citation.ruleId ?? index}`} className="px-5 py-3">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-xs font-bold text-[#12304A]">
                                    {citation.ruleNumber ?? citation.ruleId ?? "Statutory provision"}
                                  </span>
                                  {typeof citation.similarityScore === "number" &&
                                  citation.similarityScore > 0 ? (
                                    <span className="text-[10px] font-mono text-blue-700 bg-blue-50 border border-blue-200 rounded px-1.5 py-0.5">
                                      {Math.round(citation.similarityScore * 100)}% match
                                    </span>
                                  ) : null}
                                </div>
                                <p className="text-[11px] text-slate-600 mt-1 leading-relaxed">
                                  {citation.statutoryObligation ?? citation.text}
                                </p>
                                {citation.sourceAct ? (
                                  <p className="text-[10px] text-slate-400 mt-1 font-medium">
                                    {citation.sourceAct}
                                    {citation.clause ? ` (${citation.clause})` : ""}
                                  </p>
                                ) : null}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Determination */}
                  <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                    <header className="px-5 py-3 border-b border-slate-200 bg-slate-50">
                      <h2 className="text-xs font-bold text-[#12304A] uppercase tracking-wide">
                        Record determination
                      </h2>
                    </header>

                    <div className="p-5 space-y-4">
                      <div>
                        <label
                          htmlFor="review-notes"
                          className="block text-[11px] font-bold text-slate-600 uppercase tracking-wide mb-1.5"
                        >
                          Reviewer notes (required)
                        </label>
                        <textarea
                          id="review-notes"
                          value={notes}
                          onChange={(event) => setNotes(event.target.value)}
                          rows={3}
                          placeholder="State the observable basis for this determination, e.g. 'MRP printed without the Incl. of all taxes statement; photograph confirmed.'"
                          className="w-full px-3 py-2 text-xs text-slate-800 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 resize-y"
                        />
                      </div>

                      <fieldset>
                        <legend className="text-[11px] font-bold text-slate-600 uppercase tracking-wide mb-1.5">
                          Corrected status (override only)
                        </legend>
                        <div className="flex flex-wrap gap-2">
                          {(["COMPLIANT", "NON_COMPLIANT", "REQUIRES_REVIEW"] as const).map((option) => (
                            <label
                              key={option}
                              className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-semibold cursor-pointer transition-colors ${
                                overrideStatus === option
                                  ? "bg-blue-600 text-white border-blue-600"
                                  : "bg-white text-slate-600 border-slate-300 hover:bg-slate-50"
                              }`}
                            >
                              <input
                                type="radio"
                                name="override-status"
                                value={option}
                                checked={overrideStatus === option}
                                onChange={() => setOverrideStatus(option)}
                                className="sr-only"
                              />
                              {option.replace(/_/g, " ")}
                            </label>
                          ))}
                        </div>
                      </fieldset>

                      <div className="flex flex-wrap gap-2 pt-1">
                        {can("INSPECTION_APPROVE") ? (
                          <>
                            <Button
                              onClick={() => void submit("ACCEPTED")}
                              disabled={submitting !== null}
                              className="bg-emerald-600 hover:bg-emerald-700"
                            >
                              <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />
                              Accept AI decision
                            </Button>
                            <Button
                              variant="secondary"
                              onClick={() => void submit("OVERRIDDEN")}
                              disabled={submitting !== null}
                            >
                              <ShieldAlert className="w-3.5 h-3.5 mr-1.5" />
                              Override
                            </Button>
                            <Button
                              variant="secondary"
                              onClick={() => void submit("REINSPECTION_REQUIRED")}
                              disabled={submitting !== null}
                            >
                              <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
                              Request re-inspection
                            </Button>
                            <Button
                              variant="ghost"
                              onClick={() => void submit("REJECTED")}
                              disabled={submitting !== null}
                              className="text-red-700"
                            >
                              <XCircle className="w-3.5 h-3.5 mr-1.5" />
                              Reject
                            </Button>
                          </>
                        ) : (
                          <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                            Your role can view this case but not record a determination.
                          </p>
                        )}
                      </div>

                      <p className="text-[10px] text-slate-400 leading-relaxed">
                        The officer who performed this inspection cannot sign it off. Every outcome is
                        appended to the statutory audit trail together with the original AI decision and
                        the final determination.
                      </p>
                    </div>
                  </div>
                </>
              )}
            </section>
          </div>
        </main>
      </div>
    </div>
  );
}