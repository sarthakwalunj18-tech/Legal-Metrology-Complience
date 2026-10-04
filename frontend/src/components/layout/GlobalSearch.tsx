"use client";

/**
 * Global search across inspections, products, statutory rules and violations.
 *
 * Requests are debounced by 300ms so typing never hits the API per keystroke,
 * and results are scoped server-side — the box cannot be used to discover
 * records outside the caller's remit.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BookOpen, Loader2, Package, Search, ShieldAlert, X, FileSearch } from "lucide-react";
import { ApiRequestError, apiFetch } from "@/lib/session";

interface InspectionHit {
  id: string;
  scanNumber: string;
  productName: string | null;
  location: string | null;
  complianceStatus: string | null;
  reviewStatus: string | null;
  createdAt: string;
}

interface ProductHit {
  id: string;
  name: string;
  brand: string | null;
  category: string | null;
  manufacturerName: string | null;
}

interface RuleHit {
  id: string;
  ruleNumber: string;
  title: string;
  category: string | null;
  requirement?: string | null;
}

interface ViolationHit {
  id: string;
  title: string;
  ruleId: string;
  severity: string;
  scanId: string;
  scanNumber: string | null;
}

interface SearchPayload {
  inspections: InspectionHit[];
  products: ProductHit[];
  rules: RuleHit[];
  violations: ViolationHit[];
  scope: "own" | "department" | "global";
}

const DEBOUNCE_MS = 300;

const STATUS_TONE: Record<string, string> = {
  COMPLIANT: "text-emerald-600",
  NON_COMPLIANT: "text-red-600",
  REQUIRES_REVIEW: "text-amber-600",
};

export function GlobalSearch() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [term, setTerm] = useState("");
  const [debounced, setDebounced] = useState("");
  const [results, setResults] = useState<SearchPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(term.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [term]);

  useEffect(() => {
    if (debounced.length < 2) {
      setResults(null);
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    apiFetch<SearchPayload>(`/search?q=${encodeURIComponent(debounced)}`)
      .then((payload) => {
        if (cancelled) return;
        setResults(payload);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setResults(null);
        setError(
          cause instanceof ApiRequestError ? cause.message : "Search is temporarily unavailable.",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [debounced]);

  // Cmd/Ctrl+K focuses the box from anywhere in the app.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
      if (event.key === "Escape") {
        setOpen(false);
        inputRef.current?.blur();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const go = useCallback(
    (href: string) => {
      setOpen(false);
      setTerm("");
      setDebounced("");
      router.push(href);
    },
    [router],
  );

  const total =
    (results?.inspections.length ?? 0) +
    (results?.products.length ?? 0) +
    (results?.rules.length ?? 0) +
    (results?.violations.length ?? 0);

  const showPanel = open && term.trim().length >= 2;

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Search
          className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
          aria-hidden="true"
        />
        <input
          ref={inputRef}
          type="search"
          role="combobox"
          aria-expanded={showPanel}
          aria-controls="global-search-results"
          aria-label="Search inspections, products, rules and violations"
          value={term}
          onChange={(event) => {
            setTerm(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder="Search inspections, rules, products…"
          className="pl-9 pr-16 py-1.5 w-72 text-xs border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500"
        />
        {term ? (
          <button
            type="button"
            onClick={() => {
              setTerm("");
              setDebounced("");
              inputRef.current?.focus();
            }}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-700 rounded"
          >
            <X className="w-3 h-3" />
          </button>
        ) : (
          <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] font-mono text-slate-400 bg-slate-100 border border-slate-200 rounded px-1 py-0.5 pointer-events-none">
            ⌘K
          </kbd>
        )}
      </div>

      {showPanel ? (
        <div
          id="global-search-results"
          role="listbox"
          className="absolute right-0 mt-2 w-[420px] max-w-[90vw] bg-white border border-slate-200 rounded-xl shadow-xl overflow-hidden z-50 max-h-[70vh] flex flex-col"
        >
          {loading ? (
            <div className="flex items-center gap-2 px-4 py-6 text-xs text-slate-500">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Searching the enforcement register…
            </div>
          ) : error ? (
            <div className="px-4 py-6 text-xs text-red-700">{error}</div>
          ) : !results || total === 0 ? (
            <div className="px-4 py-8 text-center">
              <FileSearch className="w-6 h-6 text-slate-300 mx-auto mb-2" />
              <p className="text-xs font-semibold text-slate-700">No matches in your scope</p>
              <p className="text-[11px] text-slate-500 mt-1">
                Search covers {results?.scope ?? "your"} records only.
              </p>
            </div>
          ) : (
            <div className="overflow-y-auto">
              {results.inspections.length > 0 ? (
                <section>
                  <h3 className="px-4 pt-3 pb-1.5 text-[10px] font-bold text-slate-400 uppercase tracking-wide">
                    Inspections
                  </h3>
                  <ul>
                    {results.inspections.map((hit) => (
                      <li key={hit.id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected="false"
                          onClick={() => go(`/inspections/${hit.id}`)}
                          className="w-full text-left px-4 py-2 hover:bg-blue-50 transition-colors"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono text-[11px] font-bold text-[#12304A]">
                              {hit.scanNumber}
                            </span>
                            <span
                              className={`text-[10px] font-bold ${STATUS_TONE[hit.complianceStatus ?? ""] ?? "text-slate-500"}`}
                            >
                              {hit.complianceStatus?.replace(/_/g, " ") ?? "—"}
                            </span>
                          </div>
                          <p className="text-[11px] text-slate-600 truncate">
                            {hit.productName ?? "Unnamed commodity"}
                          </p>
                          <p className="text-[10px] text-slate-400 truncate">{hit.location ?? "—"}</p>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {results.violations.length > 0 ? (
                <section className="border-t border-slate-100">
                  <h3 className="px-4 pt-3 pb-1.5 text-[10px] font-bold text-slate-400 uppercase tracking-wide flex items-center gap-1.5">
                    <ShieldAlert className="w-3 h-3" />
                    Violations
                  </h3>
                  <ul>
                    {results.violations.map((hit) => (
                      <li key={hit.id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected="false"
                          onClick={() => go(`/inspections/${hit.scanId}`)}
                          className="w-full text-left px-4 py-2 hover:bg-blue-50 transition-colors"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[11px] font-semibold text-[#12304A] truncate">
                              {hit.title}
                            </span>
                            <span className="shrink-0 text-[9px] font-bold uppercase text-red-600">
                              {hit.severity}
                            </span>
                          </div>
                          <p className="text-[10px] font-mono text-slate-500">
                            {hit.ruleId} · {hit.scanNumber ?? hit.scanId}
                          </p>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {results.rules.length > 0 ? (
                <section className="border-t border-slate-100">
                  <h3 className="px-4 pt-3 pb-1.5 text-[10px] font-bold text-slate-400 uppercase tracking-wide flex items-center gap-1.5">
                    <BookOpen className="w-3 h-3" />
                    Statutory rules
                  </h3>
                  <ul>
                    {results.rules.map((hit) => (
                      <li key={hit.id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected="false"
                          onClick={() => go(`/rules?query=${encodeURIComponent(hit.ruleNumber)}`)}
                          className="w-full text-left px-4 py-2 hover:bg-blue-50 transition-colors"
                        >
                          <span className="font-mono text-[11px] font-bold text-[#12304A]">
                            {hit.ruleNumber}
                          </span>
                          <p className="text-[11px] text-slate-600 truncate">{hit.title}</p>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {results.products.length > 0 ? (
                <section className="border-t border-slate-100">
                  <h3 className="px-4 pt-3 pb-1.5 text-[10px] font-bold text-slate-400 uppercase tracking-wide flex items-center gap-1.5">
                    <Package className="w-3 h-3" />
                    Commodities
                  </h3>
                  <ul>
                    {results.products.map((hit) => (
                      <li key={hit.id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected="false"
                          onClick={() => go(`/products/${hit.id}`)}
                          className="w-full text-left px-4 py-2 hover:bg-blue-50 transition-colors"
                        >
                          <span className="text-[11px] font-semibold text-[#12304A] truncate block">
                            {hit.name}
                          </span>
                          <p className="text-[10px] text-slate-500 truncate">
                            {hit.manufacturerName ?? hit.category ?? "—"}
                          </p>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              <footer className="px-4 py-2 border-t border-slate-100 bg-slate-50 text-[10px] text-slate-500">
                {total} result{total === 1 ? "" : "s"} · scope: {results.scope}
              </footer>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}