"use client";

/**
 * Legal Metrology AI assistant.
 *
 * The interface is deliberately explicit about what the system knows: an answer
 * only appears when statutory text was actually retrieved, the sources behind it are
 * always shown, and the persistent banner states that this is assistance rather than
 * a compliance determination. When nothing grounds the question the page says so
 * instead of offering a guess.
 */

import React, { useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  BookOpen,
  Info,
  Loader2,
  Scale,
  Send,
  Sparkles,
} from "lucide-react";
import { ApiRequestError, apiFetch } from "@/lib/session";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";

interface Citation {
  ruleId: string;
  ruleNumber: string;
  sourceAct: string;
  clause: string;
  text: string;
  similarityScore: number;
  statutoryObligation: string;
  effectiveDate: string;
}

interface AssistantAnswer {
  question: string;
  category: string;
  answer: string | null;
  grounded: boolean;
  generated: boolean;
  refusal: "NO_GROUNDING" | "NO_MODEL" | null;
  citations: Citation[];
  disclaimer: string;
}

interface Exchange {
  id: number;
  question: string;
  result: AssistantAnswer;
}

const CATEGORIES = [
  { value: "GENERAL", label: "General" },
  { value: "PACKAGING", label: "Packaged commodities" },
  { value: "LABELLING", label: "Labelling & declarations" },
  { value: "NET_QUANTITY", label: "Net quantity" },
  { value: "MRP", label: "MRP" },
  { value: "PACKER", label: "Packer & importer" },
];

const STARTERS = [
  "Which declarations are mandatory on a packaged commodity?",
  "How must net quantity be declared on a prepacked package?",
  "What are the permissible error limits for net quantity?",
  "When must an MRP be displayed, and may it be rounded?",
  "What are the obligations of a packer or importer of packaged goods?",
];

export default function AssistantPage() {
  const [question, setQuestion] = useState("");
  const [category, setCategory] = useState("GENERAL");
  const [history, setHistory] = useState<Exchange[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ask = async (asked: string) => {
    const trimmed = asked.trim();
    if (trimmed.length < 3 || loading) return;

    setLoading(true);
    setError(null);

    try {
      const result = await apiFetch<AssistantAnswer>("/rag/ask", {
        method: "POST",
        json: { question: trimmed, category },
      });
      setHistory((current) => [
        ...current,
        { id: Date.now(), question: trimmed, result },
      ]);
      setQuestion("");
    } catch (cause: unknown) {
      setError(
        cause instanceof ApiRequestError
          ? cause.message
          : "The statutory assistant is temporarily unavailable.",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-5xl space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Statutory Assistant</h1>
          <p className="text-xs text-slate-500 mt-1">
            Ask about the Legal Metrology Act and the Packaged Commodities Rules. Answers are drawn
            only from retrieved statutory text.
          </p>
        </div>
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-[10px] font-bold uppercase tracking-wide shrink-0">
          <Sparkles className="w-3.5 h-3.5" />
          AI assistance
        </div>
      </div>

      <div className="flex items-start gap-2 px-3.5 py-2.5 rounded-lg bg-amber-50 border border-amber-200">
        <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
        <p className="text-[11px] text-amber-900 leading-relaxed">
          This assistant explains retrieved statutory text. It does not decide compliance. The
          deterministic rules engine produces the determination and a human officer signs it off on
          the review workspace.
        </p>
      </div>

      <Card>
        <CardHeader title="Ask a question" />
        <CardBody className="space-y-3">
          <textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void ask(question);
            }}
            rows={3}
            maxLength={500}
            placeholder="e.g. What are the permissible error limits for net quantity?"
            aria-label="Your question"
            className="w-full px-3 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 resize-y"
          />

          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <label htmlFor="assistant-category" className="text-[11px] font-semibold text-slate-600">
                Topic
              </label>
              <select
                id="assistant-category"
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/40"
              >
                {CATEGORIES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <Button onClick={() => void ask(question)} disabled={loading || question.trim().length < 3}>
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              <span>{loading ? "Retrieving…" : "Ask"}</span>
            </Button>
          </div>

          {history.length === 0 ? (
            <div className="pt-1">
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide mb-2">
                Try one of these
              </p>
              <div className="flex flex-wrap gap-1.5">
                {STARTERS.map((starter) => (
                  <button
                    key={starter}
                    type="button"
                    onClick={() => void ask(starter)}
                    className="text-left px-2.5 py-1.5 text-[11px] text-slate-600 bg-slate-50 hover:bg-blue-50 hover:text-blue-700 border border-slate-200 rounded-lg transition-colors"
                  >
                    {starter}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {error ? (
            <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {error}
            </p>
          ) : null}
        </CardBody>
      </Card>

      <div className="space-y-3">
        {history.map((exchange) => {
          const { result } = exchange;
          return (
            <div key={exchange.id} className="space-y-2">
              <div className="flex justify-end">
                <p className="max-w-[80%] px-3.5 py-2 rounded-2xl rounded-br-sm bg-[#12304A] text-white text-xs leading-relaxed">
                  {exchange.question}
                </p>
              </div>

              <Card>
                <CardBody className="space-y-3">
                  {result.refusal === "NO_GROUNDING" ? (
                    <div className="flex items-start gap-2.5 px-3.5 py-3 rounded-lg bg-slate-50 border border-slate-200">
                      <Info className="w-4 h-4 text-slate-500 shrink-0 mt-0.5" />
                      <div className="text-[11px] text-slate-700 leading-relaxed">
                        <p className="font-bold text-slate-800">No statutory basis found</p>
                        <p className="mt-1">
                          Nothing in the rule corpus covers this question, so no answer was written.
                          Try rephrasing it in enforcement terms, or check the rule knowledge base.
                        </p>
                        <Link
                          href="/rules"
                          className="inline-flex items-center gap-1 mt-1.5 font-semibold text-blue-700 hover:underline"
                        >
                          <BookOpen className="w-3 h-3" />
                          Open Rule Knowledge Base
                        </Link>
                      </div>
                    </div>
                  ) : null}

                  {result.refusal === "NO_MODEL" ? (
                    <div className="flex items-start gap-2.5 px-3.5 py-2.5 rounded-lg bg-sky-50 border border-sky-200">
                      <Info className="w-4 h-4 text-sky-700 shrink-0 mt-0.5" />
                      <p className="text-[11px] text-sky-900 leading-relaxed">
                        The statutory text below was retrieved, but no language model is configured, so
                        only the source material is shown rather than a written summary.
                      </p>
                    </div>
                  ) : null}

                  {result.answer ? (
                    <div className="text-[13px] text-slate-800 leading-relaxed whitespace-pre-wrap">
                      {result.answer}
                    </div>
                  ) : null}

                  {result.citations.length > 0 ? (
                    <div>
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide mb-2 flex items-center gap-1.5">
                        <Scale className="w-3 h-3" />
                        {result.generated ? "Cited statutory basis" : "Retrieved statutory text"}
                      </p>
                      <ul className="space-y-2">
                        {result.citations.map((citation) => (
                          <li
                            key={`${citation.ruleId}-${citation.clause}`}
                            className="px-3 py-2.5 rounded-lg border border-slate-200 bg-slate-50"
                          >
                            <div className="flex items-center justify-between gap-2 flex-wrap">
                              <span className="font-mono text-[11px] font-bold text-[#12304A]">
                                {citation.ruleNumber}
                                {citation.clause ? ` · ${citation.clause}` : ""}
                              </span>
                              <span className="text-[10px] text-slate-500">
                                {citation.sourceAct}
                                {citation.effectiveDate ? ` · from ${citation.effectiveDate}` : ""}
                              </span>
                            </div>
                            {citation.statutoryObligation ? (
                              <p className="text-[11px] font-semibold text-slate-700 mt-1.5">
                                {citation.statutoryObligation}
                              </p>
                            ) : null}
                            <p className="text-[11px] text-slate-600 mt-1 leading-relaxed">
                              {citation.text}
                            </p>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  <p className="text-[10px] text-slate-400 border-t border-slate-100 pt-2 italic">
                    {result.disclaimer}
                  </p>
                </CardBody>
              </Card>
            </div>
          );
        })}
      </div>
    </div>
  );
}