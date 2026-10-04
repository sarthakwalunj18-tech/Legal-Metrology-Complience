"use client";

/**
 * Violation management (Module 18).
 *
 * Every row is a deterministic rule breach, not an AI opinion: the rule id,
 * the extracted evidence and the detection confidence all come from the
 * compliance engine. Selecting a row opens the evidence that justifies it.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Sidebar } from "@/components/layout/Sidebar";
import { TopBar } from "@/components/layout/TopBar";
import { Button } from "@/components/ui/Button";
import {
  AlertOctagon,
  ChevronLeft,
  ChevronRight,
  Filter,
  Loader2,
  Search,
  ShieldAlert,
  X,
} from "lucide-react";
import { ApiRequestError, apiFetch } from "@/lib/session";
import {
  parseBoundingBox,
  toPercent,
  type Scan,
  type ScanImage,
  type Violation,
} from "@/lib/domain";

interface ViolationPage {
  violations: Violation[];
  total: number;
  page: number;
  pageSize: number;
  pageCount?: number;
  hasNext?: boolean;
  hasPrevious?: boolean;
}

interface ViolationDetail {
  violation: Violation;
  scan: Scan;
  images: ScanImage[];
}

const SEVERITY_TONE: Record<string, string> = {
  CRITICAL: "bg-red-600 text-white border-red-600",
  HIGH: "bg-red-50 text-red-700 border-red-200",
  MEDIUM: "bg-amber-50 text-amber-800 border-amber-200",
  LOW: "bg-slate-100 text-slate-600 border-slate-200",
};

const REVIEW_TONE: Record<string, string> = {
  PENDING: "bg-amber-50 text-amber-800 border-amber-200",
  CONFIRMED: "bg-red-50 text-red-700 border-red-200",
  DISMISSED: "bg-emerald-50 text-emerald-700 border-emerald-200",
};

const PAGE_SIZE = 25;

function SeverityBadge({ severity }: { severity: string }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide border ${
        SEVERITY_TONE[severity] ?? "bg-slate-100 text-slate-600 border-slate-200"
      }`}
    >
      {severity}
    </span>
  );
}

function Confidence({ value }: { value: string | number | null }) {
  const percent = toPercent(value);
  if (percent === null) return <span className="text-slate-400">—</span>;
  const tone = percent >= 90 ? "text-emerald-600" : percent >= 70 ? "text-amber-600" : "text-red-600";
  return <span className={`font-mono font-bold ${tone}`}>{percent}%</span>;
}

/** Debounced so typing does not fire a request per keystroke. */
function useDebounced<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function EvidenceDrawer({
  detail,
  loading,
  onClose,
}: {
  detail: ViolationDetail | null;
  loading: boolean;
  onClose: () => void;
}) {
  const box = detail ? parseBoundingBox(detail.violation.boundingBox) : null;
  const imageUrl = detail?.images?.[0]?.url ?? null;

  useEffect(() => {
    if (!detail && !loading) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail, loading, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Violation evidence">
      <button
        type="button"
        aria-label="Close evidence"
        onClick={onClose}
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-[1px]"
      />

      <aside className="relative w-full max-w-xl bg-white h-full overflow-y-auto shadow-2xl">
        <header className="sticky top-0 bg-white border-b border-slate-200 px-5 py-4 flex items-start justify-between gap-3 z-10">
          <div className="min-w-0">
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">
              Violation evidence
            </p>
            <h2 className="text-sm font-bold text-[#12304A] mt-0.5 truncate">
              {detail?.violation.title ?? "Loading..."}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="p-5 space-y-4">
          {loading || !detail ? (
            <div className="py-16 text-center">
              <Loader2 className="w-6 h-6 border-3 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto" />
              <p className="text-xs text-slate-500 mt-3">Loading evidence...</p>
            </div>
          ) : (
            <>
              <div className="relative rounded-xl border border-slate-200 bg-slate-50 overflow-hidden">
                {imageUrl ? (
                  // The evidence URL is short-lived and signed by the backend, so
                  // next/image cannot fetch it through the optimiser.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={imageUrl}
                    alt="Evidence for the selected violation"
                    className="w-full object-contain max-h-[420px]"
                  />
                ) : (
                  <div className="flex flex-col items-center justify-center h-56 text-slate-400 gap-2">
                    <ShieldAlert className="w-6 h-6" />
                    <p className="text-xs">No stored image for this inspection.</p>
                  </div>
                )}
                {box && imageUrl ? (
                  <div
                    className="absolute border-2 border-red-500 bg-red-500/10 rounded-sm pointer-events-none"
                    style={{
                      left: `${box.x * 100}%`,
                      top: `${box.y * 100}%`,
                      width: `${box.width * 100}%`,
                      height: `${box.height * 100}%`,
                    }}
                  />
                ) : null}
              </div>

              <dl className="grid grid-cols-2 gap-3 text-xs">
                <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                  <dt className="text-[10px] text-slate-500 font-bold uppercase tracking-wide">Severity</dt>
                  <dd className="mt-1">
                    <SeverityBadge severity={detail.violation.severity} />
                  </dd>
                </div>
                <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                  <dt className="text-[10px] text-slate-500 font-bold uppercase tracking-wide">Confidence</dt>
                  <dd className="mt-1">
                    <Confidence value={detail.violation.confidence} />
                  </dd>
                </div>
                <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                  <dt className="text-[10px] text-slate-500 font-bold uppercase tracking-wide">Case state</dt>
                  <dd className="mt-1">
                    <span
                      className={`inline-flex px-2 py-0.5 rounded text-[10px] font-bold border ${
                        REVIEW_TONE[detail.violation.status ?? ""] ?? "bg-slate-100 text-slate-600 border-slate-200"
                      }`}
                    >
                      {detail.violation.status}
                    </span>
                  </dd>
                </div>
                <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                  <dt className="text-[10px] text-slate-500 font-bold uppercase tracking-wide">Raised</dt>
                  <dd className="mt-1 text-slate-700">
                    {new Date(detail.violation.createdAt).toLocaleDateString()}
                  </dd>
                </div>
                <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 col-span-2">
                  <dt className="text-[10px] text-slate-500 font-bold uppercase tracking-wide">
                    Statutory basis
                  </dt>
                  <dd className="mt-1 font-mono font-bold text-[#12304A] break-words">
                    {detail.violation.ruleNumber ?? detail.violation.ruleId}
                    {detail.violation.category ? ` · ${detail.violation.category}` : ""}
                  </dd>
                </div>
                <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 col-span-2">
                  <dt className="text-[10px] text-slate-500 font-bold uppercase tracking-wide">
                    Compliance reasoning
                  </dt>
                  <dd className="mt-1 text-slate-700 leading-relaxed">
                    {detail.violation.description}
                  </dd>
                </div>
              </dl>

              <Link href={`/inspections/${detail.scan.id}`} className="block">
                <Button variant="secondary" className="w-full">
                  Open inspection {detail.scan.scanNumber}
                </Button>
              </Link>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

export default function ViolationsPage() {
  const [rows, setRows] = useState<Violation[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [severity, setSeverity] = useState("");
  const [reviewStatus, setReviewStatus] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  const [selected, setSelected] = useState<ViolationDetail | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);

  const debouncedSearch = useDebounced(search);
  const hasFilters = Boolean(debouncedSearch || severity || reviewStatus);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const query = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (debouncedSearch) query.set("search", debouncedSearch);
      if (severity) query.set("severity", severity);
      if (reviewStatus) query.set("reviewStatus", reviewStatus);

      const payload = await apiFetch<ViolationPage>(`/violations?${query.toString()}`);
      setRows(payload.violations ?? []);
      setTotal(payload.total ?? 0);
      setPageCount(payload.pageCount ?? 1);
      setError(null);
    } catch (cause) {
      setRows([]);
      setError(
        cause instanceof ApiRequestError
          ? cause.status === 403
            ? "Your role does not include violation access."
            : cause.message
          : "Unable to reach the enforcement API.",
      );
    } finally {
      setLoading(false);
    }
  }, [page, debouncedSearch, severity, reviewStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  // Any filter change restarts pagination, otherwise page 4 of a new result set is empty.
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, severity, reviewStatus]);

  const openEvidence = useCallback(async (violationId: string) => {
    setDrawerLoading(true);
    setSelected(null);
    try {
      const payload = await apiFetch<ViolationDetail>(
        `/violations/${encodeURIComponent(violationId)}`,
      );
      setSelected(payload);
    } catch (cause) {
      setError(
        cause instanceof ApiRequestError ? cause.message : "Unable to load the violation evidence.",
      );
    } finally {
      setDrawerLoading(false);
    }
  }, []);

  const summary = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.severity, (counts.get(row.severity) ?? 0) + 1);
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [rows]);

  return (
    <div className="flex min-h-screen bg-[#F8FAFC]">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar breadcrumbs={[{ label: "Violation Register" }]} />

        <main className="p-6 lg:p-8 max-w-[1600px] w-full mx-auto space-y-5 flex-1">
          <div className="pb-2 border-b border-slate-200 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold text-[#12304A] tracking-tight flex items-center gap-2">
                <AlertOctagon className="w-6 h-6 text-red-600" />
                Statutory Violations
              </h1>
              <p className="text-sm text-slate-500 mt-1">
                Every entry is a deterministic rule breach with its evidence, rule reference and
                detection confidence.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search violation, rule or evidence"
                  aria-label="Search violations"
                  className="pl-9 pr-3 py-2 w-64 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 bg-white"
                />
              </div>
              <Button
                variant={showFilters || hasFilters ? "primary" : "secondary"}
                onClick={() => setShowFilters((value) => !value)}
              >
                <Filter className="w-3.5 h-3.5 mr-1.5" />
                Filters
              </Button>
            </div>
          </div>

          {showFilters ? (
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 flex flex-wrap gap-4">
              <div>
                <label
                  htmlFor="filter-severity"
                  className="block text-[10px] font-bold text-slate-500 uppercase tracking-wide mb-1"
                >
                  Severity
                </label>
                <select
                  id="filter-severity"
                  value={severity}
                  onChange={(event) => setSeverity(event.target.value)}
                  className="px-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                >
                  <option value="">All severities</option>
                  <option value="CRITICAL">Critical</option>
                  <option value="HIGH">High</option>
                  <option value="MEDIUM">Medium</option>
                  <option value="LOW">Low</option>
                </select>
              </div>

              <div>
                <label
                  htmlFor="filter-review"
                  className="block text-[10px] font-bold text-slate-500 uppercase tracking-wide mb-1"
                >
                  Review state
                </label>
                <select
                  id="filter-review"
                  value={reviewStatus}
                  onChange={(event) => setReviewStatus(event.target.value)}
                  className="px-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                >
                  <option value="">Any state</option>
                  <option value="PENDING">Pending</option>
                  <option value="CONFIRMED">Confirmed</option>
                  <option value="DISMISSED">Dismissed</option>
                </select>
              </div>

              {hasFilters ? (
                <button
                  type="button"
                  onClick={() => {
                    setSearch("");
                    setSeverity("");
                    setReviewStatus("");
                  }}
                  className="self-end text-xs font-semibold text-blue-700 hover:underline"
                >
                  Clear all
                </button>
              ) : null}
            </div>
          ) : null}

          {error ? (
            <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-xs text-red-800">
              {error}
            </div>
          ) : null}

          {summary.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {summary.map(([level, count]) => (
                <span
                  key={level}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-[11px] font-semibold text-slate-600"
                >
                  <SeverityBadge severity={level} />
                  {count} on this page
                </span>
              ))}
            </div>
          ) : null}

          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <caption className="sr-only">
                  Statutory violations raised by the compliance engine
                </caption>
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    {["Violation", "Rule", "Severity", "Evidence", "Confidence", "Review", "Date"].map(
                      (heading) => (
                        <th
                          key={heading}
                          scope="col"
                          className="px-4 py-2.5 text-[10px] font-bold text-slate-500 uppercase tracking-wide whitespace-nowrap"
                        >
                          {heading}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    Array.from({ length: 6 }).map((_, index) => (
                      <tr key={index} className="border-b border-slate-100">
                        {Array.from({ length: 7 }).map((__, cell) => (
                          <td key={cell} className="px-4 py-3">
                            <div className="h-3 rounded bg-slate-100 animate-pulse" />
                          </td>
                        ))}
                      </tr>
                    ))
                  ) : rows.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-16 text-center">
                        <ShieldAlert className="w-7 h-7 text-emerald-500 mx-auto mb-2" />
                        <p className="text-sm font-semibold text-slate-700">
                          {hasFilters ? "No violations match these filters" : "No violations recorded"}
                        </p>
                        <p className="text-xs text-slate-500 mt-1">
                          {hasFilters
                            ? "Try widening the severity or review-state filter."
                            : "Nothing in your scope has breached a statutory declaration requirement."}
                        </p>
                      </td>
                    </tr>
                  ) : (
                    rows.map((violation) => (
                      <tr
                        key={violation.id}
                        onClick={() => void openEvidence(violation.id)}
                        tabIndex={0}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            void openEvidence(violation.id);
                          }
                        }}
                        className="border-b border-slate-100 hover:bg-blue-50/50 cursor-pointer transition-colors focus:outline-none focus:bg-blue-50"
                      >
                        <td className="px-4 py-3">
                          <p className="text-xs font-semibold text-[#12304A]">{violation.title}</p>
                          <p className="text-[10px] text-slate-500 mt-0.5">{violation.violationType}</p>
                        </td>
                        <td className="px-4 py-3">
                          <span className="font-mono text-[11px] text-slate-600">{violation.ruleId}</span>
                        </td>
                        <td className="px-4 py-3">
                          <SeverityBadge severity={violation.severity} />
                        </td>
                        <td className="px-4 py-3 max-w-[220px]">
                          <span className="font-mono text-[11px] text-slate-700 break-words">
                            {violation.extractedEvidence || "—"}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <Confidence value={violation.confidence} />
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex px-2 py-0.5 rounded text-[10px] font-bold border ${
                              REVIEW_TONE[violation.reviewStatus] ??
                              "bg-slate-100 text-slate-600 border-slate-200"
                            }`}
                          >
                            {violation.reviewStatus}
                          </span>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-[11px] text-slate-500">
                          {new Date(violation.createdAt).toLocaleDateString()}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <footer className="px-4 py-3 border-t border-slate-200 bg-slate-50 flex items-center justify-between">
              <p className="text-[11px] text-slate-500">
                Page <span className="font-semibold text-slate-700">{page}</span> of{" "}
                <span className="font-semibold text-slate-700">{Math.max(pageCount, 1)}</span> ·{" "}
                <span className="font-semibold text-slate-700">{total}</span> violation
                {total === 1 ? "" : "s"}
              </p>
              <div className="flex items-center gap-1.5">
                <Button
                  variant="secondary"
                  disabled={page <= 1 || loading}
                  onClick={() => setPage((value) => Math.max(1, value - 1))}
                  aria-label="Previous page"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                </Button>
                <Button
                  variant="secondary"
                  disabled={page >= pageCount || loading}
                  onClick={() => setPage((value) => value + 1)}
                  aria-label="Next page"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </Button>
              </div>
            </footer>
          </div>
        </main>
      </div>

      {drawerLoading || selected ? (
        <EvidenceDrawer detail={selected} loading={drawerLoading} onClose={() => setSelected(null)} />
      ) : null}
    </div>
  );
}