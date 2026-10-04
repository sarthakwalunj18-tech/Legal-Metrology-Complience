"use client";

/**
 * Statutory rule knowledge base.
 *
 * Reads the rule library served by `GET /api/rules` (requires RULE_VIEW). The
 * library is read-only over the API because it mirrors statutory text.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Sidebar } from "@/components/layout/Sidebar";
import { TopBar } from "@/components/layout/TopBar";
import { Card, CardHeader, CardBody } from "@/components/ui/Card";
import { Search, Loader2 } from "lucide-react";
import { ApiRequestError, apiFetch } from "@/lib/session";

interface StatutoryRule {
  id: string;
  ruleNumber?: string | null;
  title: string;
  category?: string | null;
  severity?: string | null;
  requirement?: string | null;
  act?: string | null;
  clause?: string | null;
  isActive?: boolean | null;
}

const SEVERITY_TONE: Record<string, string> = {
  CRITICAL: "bg-red-50 text-red-800 border-red-200",
  HIGH: "bg-orange-50 text-orange-800 border-orange-200",
  MEDIUM: "bg-amber-50 text-amber-800 border-amber-200",
  LOW: "bg-blue-50 text-blue-800 border-blue-200",
};

export default function RulesKnowledgeBasePage() {
  const [rules, setRules] = useState<StatutoryRule[]>([]);
  const [total, setTotal] = useState(0);
  const [searchTerm, setSearchTerm] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<{ total: number; rules: StatutoryRule[] }>("/rules");
      setRules(data.rules ?? []);
      setTotal(data.total ?? 0);
      setError(null);
    } catch (cause) {
      setRules([]);
      setError(
        cause instanceof ApiRequestError
          ? cause.status === 403
            ? "Your role does not have rule library access."
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

  const term = searchTerm.trim().toLowerCase();
  const filteredRules = term
    ? rules.filter((rule) =>
        [rule.ruleNumber, rule.title, rule.requirement, rule.clause, rule.category]
          .filter(Boolean)
          .some((field) => String(field).toLowerCase().includes(term)),
      )
    : rules;

  return (
    <div className="flex min-h-screen bg-[#F8FAFC]">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar breadcrumbs={[{ label: "Rule Knowledge Base" }]} onRefresh={load} isRefreshing={loading} />

        <main className="p-8 max-w-7xl w-full mx-auto space-y-6 flex-1">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 pb-2 border-b border-slate-200">
            <div>
              <h1 className="text-2xl font-bold text-[#12304A] tracking-tight">
                Statutory Rule Knowledge Base
              </h1>
              <p className="text-sm text-slate-500 mt-1">
                Legal Metrology (Packaged Commodities) Rules, 2011 and statutory amendments, as loaded by the
                deterministic rule engine.
              </p>
            </div>
            <span className="text-xs text-slate-500">
              {filteredRules.length} of {total.toLocaleString()} active rules
            </span>
          </div>

          {error && (
            <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-xs text-red-800">{error}</div>
          )}

          <div className="relative max-w-md">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
            <input
              type="text"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Search statutory rules by keyword or clause..."
              className="w-full pl-9 pr-3 py-2 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#12304A] bg-white text-slate-800"
            />
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-16 gap-2 text-xs text-slate-500">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading statutory library…
            </div>
          ) : filteredRules.length === 0 ? (
            <p className="text-xs text-slate-500 text-center py-16">
              {rules.length === 0
                ? "The statutory rule library is empty on this deployment."
                : "No rules match your search."}
            </p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {filteredRules.map((rule) => (
                <Card key={rule.id}>
                  <CardHeader
                    title={
                      <div className="flex items-center gap-2 flex-wrap">
                        {rule.ruleNumber && (
                          <span className="font-mono text-xs font-bold px-2 py-0.5 bg-blue-50 text-blue-800 rounded border border-blue-200">
                            {rule.ruleNumber}
                          </span>
                        )}
                        <span className="text-sm font-semibold text-slate-900">{rule.title}</span>
                      </div>
                    }
                    action={
                      rule.severity && (
                        <span
                          className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded border ${
                            SEVERITY_TONE[rule.severity] ?? "bg-slate-100 text-slate-700 border-slate-200"
                          }`}
                        >
                          {rule.severity}
                        </span>
                      )
                    }
                  />
                  <CardBody className="space-y-3 text-xs">
                    <div>
                      <span className="text-slate-400 font-semibold uppercase text-[10px] block mb-1">
                        Statutory Requirement
                      </span>
                      <p className="text-slate-700 leading-relaxed font-medium">
                        {rule.requirement ?? "No requirement text supplied."}
                      </p>
                    </div>

                    <div className="p-2.5 bg-slate-50 border border-slate-100 rounded-lg text-[11px] text-slate-500 space-y-0.5">
                      <div>
                        <strong>Act / Rules:</strong> {rule.act ?? "Legal Metrology (Packaged Commodities) Rules, 2011"}
                      </div>
                      <div>
                        <strong>Citation:</strong> {rule.clause ?? rule.ruleNumber ?? rule.id}
                      </div>
                      {rule.category && (
                        <div>
                          <strong>Category:</strong> {rule.category}
                        </div>
                      )}
                    </div>
                  </CardBody>
                </Card>
              ))}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
