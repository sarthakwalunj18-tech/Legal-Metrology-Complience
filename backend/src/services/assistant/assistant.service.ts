import { GoogleGenerativeAI } from "@google/generative-ai";
import { RagLegalService, type LegalContextChunk } from "../rag/rag.service.js";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";

/**
 * Officer-facing statutory assistance.
 *
 * The hard rule for this module: the narrative answer may only ever restate the
 * retrieved statutory chunks. Retrieval is the authority; the language model is a
 * reading aid. Two consequences are enforced in code rather than in the prompt
 * alone:
 *
 *  1. No retrieval  -> no answer. The officer is told nothing was found instead of
 *     receiving a plausible-sounding invention.
 *  2. Every citation offered to the UI is a chunk that was actually retrieved, and
 *     a citation the model did not reference is dropped. The model cannot cite
 *     itself into a rule that is not in the corpus.
 */

export interface AssistantCitation {
  ruleId: string;
  ruleNumber: string;
  sourceAct: string;
  clause: string;
  text: string;
  similarityScore: number;
  statutoryObligation: string;
  effectiveDate: string;
  /** True when the model referenced this chunk in its answer. */
  referenced: boolean;
}

export interface AssistantAnswer {
  question: string;
  category: string;
  /** Narrative answer, or null when the question could not be grounded. */
  answer: string | null;
  /** True only when statutory support was actually retrieved. */
  grounded: boolean;
  /** False when retrieval succeeded but no model was available to phrase it. */
  generated: boolean;
  refusal: "NO_GROUNDING" | "NO_MODEL" | null;
  citations: AssistantCitation[];
  disclaimer: string;
}

const DISCLAIMER =
  "AI assistance only. It summarises retrieved statutory text and is not a " +
  "compliance determination — the rules engine and a human officer decide the outcome.";

const SYSTEM_PROMPT = `You are a Legal Metrology advisory assistant for Indian packaged-commodities officers.

You will be given ONLY the statutory excerpts retrieved for the officer's question. Your entire answer must be derived from those excerpts.

ABSOLUTE RULES:
1. Never state a requirement, tolerance, penalty or clause that is not present in the supplied excerpts.
2. Never invent rule numbers, clause numbers, dates, penalties or thresholds. If an excerpt does not state a value, say the excerpt does not state it.
3. If the excerpts do not answer the question, say so plainly and name what is missing.
4. Cite the rule number and clause inline for every statement, using the exact identifiers from the excerpts.
5. Where the Law (Metrology) (Packaged Commodities) Rules, 2011 and the Legal Metrology Act, 2009 are both relevant, keep them clearly attributed to their own source.
6. Be concise and practical for a field officer: what to check, what the requirement is, what the exposure is.
7. Plain prose or short bullets. No markdown headings.`;

/** Chunks the answer is allowed to draw on. */
const TOP_K = 5;

function buildContextBlock(chunks: LegalContextChunk[]): string {
  return chunks
    .map((chunk, index) => {
      const parts = [
        `[${index + 1}] ${chunk.ruleNumber}${chunk.clause ? ` · ${chunk.clause}` : ""}`,
        `Source: ${chunk.sourceAct}`,
      ];
      if (chunk.statutoryObligation) parts.push(`Obligation: ${chunk.statutoryObligation}`);
      if (chunk.effectiveDate) parts.push(`Effective: ${chunk.effectiveDate}`);
      parts.push(`Text: ${chunk.text}`);
      return parts.join("\n");
    })
    .join("\n\n");
}

/**
 * Drops any citation the model never referenced, so the UI cannot present a rule
 * as supporting the answer when the model did not actually use it.
 */
function keepReferencedCitations(chunks: LegalContextChunk[], answer: string): AssistantCitation[] {
  return chunks
    .map((chunk) => {
      const ruleNumber = chunk.ruleNumber.trim();
      const clause = chunk.clause?.trim() ?? "";
      // Match on the rule number, and on the clause when the model quoted one.
      const mentionsRule = ruleNumber.length > 0 && answer.includes(ruleNumber);
      const mentionsClause =
        clause.length > 0 &&
        (answer.includes(clause) || answer.toLowerCase().includes(clause.toLowerCase()));
      return {
        ruleId: chunk.ruleId,
        ruleNumber,
        sourceAct: chunk.sourceAct,
        clause,
        text: chunk.text,
        similarityScore: chunk.similarityScore,
        statutoryObligation: chunk.statutoryObligation,
        effectiveDate: chunk.effectiveDate,
        referenced: mentionsRule || mentionsClause,
      };
    })
    .filter((citation) => citation.referenced);
}

/** Model answer with markdown fences and stray preamble removed. */
function cleanAnswer(raw: string): string {
  return raw
    .replace(/^```[a-z]*\n?/i, "")
    .replace(/```$/i, "")
    .trim();
}

/** Words that carry no statutory signal. */
const STOP_WORDS = new Set([
  "the", "and", "for", "are", "was", "were", "has", "have", "had", "with", "that", "this",
  "these", "those", "from", "what", "which", "when", "where", "who", "whom", "how", "why",
  "does", "did", "can", "could", "should", "would", "must", "any", "all", "its", "it", "is",
  "be", "been", "being", "on", "in", "of", "to", "a", "an", "or", "and", "but", "not", "no",
  "do", "i", "you", "we", "they", "my", "our", "their", "me", "us", "them", "if", "then",
]);

/** Lower-cased content word, singularised enough to survive "declarations"/"declaration". */
function contentToken(word: string): string | null {
  const cleaned = word.toLowerCase().replace(/[^a-z]/g, "");
  if (cleaned.length < 4 || STOP_WORDS.has(cleaned)) return null;
  return cleaned;
}

/**
 * Whether the retrieved chunks actually speak to this question.
 *
 * Vector similarity alone cannot answer that: the in-memory index returns its top-K
 * for any input, and an unrelated question scores as highly as a real one. So the
 * gate is lexical — the officer's own content words have to appear in the statutory
 * text that came back. Deterministic, inspectable, and it cannot be talked past by
 * a confident-sounding nearest neighbour.
 */
function hasGrounding(question: string, chunks: LegalContextChunk[]): boolean {
  const questionTokens = question
    .split(/\s+/)
    .map(contentToken)
    .filter((token): token is string => Boolean(token));
  if (questionTokens.length === 0) return false;

  const corpus = chunks
    .map((chunk) => `${chunk.text} ${chunk.ruleNumber} ${chunk.statutoryObligation} ${chunk.sourceAct}`)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ");

  const corpusStems = new Set(
    corpus
      .split(/\s+/)
      .map((word) => word.replace(/(?:ies|es|s)$/, ""))
      .filter(Boolean),
  );

  const matched = questionTokens.filter((token) => {
    const stem = token.replace(/(?:ies|es|s)$/, "");
    return corpus.includes(token) || corpusStems.has(stem);
  }).length;

  // One shared word is coincidence ("commodity"); two is a real topical match.
  return matched >= 2;
}

export class AssistantService {
  /**
   * Answers an officer question strictly from retrieved statutory text.
   *
   * Never throws for a missing model or missing grounding: both are reported in the
   * response so the UI can show the officer something truthful.
   */
  static async answer(question: string, category = "GENERAL"): Promise<AssistantAnswer> {
    const chunks = await RagLegalService.retrieveLegalContext(question, category, TOP_K);

    // Retrieval that never had anything to say about the question is not grounding.
    if (chunks.length === 0 || !hasGrounding(question, chunks)) {
      return {
        question,
        category,
        answer: null,
        grounded: false,
        generated: false,
        refusal: "NO_GROUNDING",
        citations: [],
        disclaimer: DISCLAIMER,
      };
    }

    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) {
      // Retrieval still has value: show the officer exactly what backs the question.
      return {
        question,
        category,
        answer: null,
        grounded: true,
        generated: false,
        refusal: "NO_MODEL",
        citations: chunks.map((chunk) => ({
          ruleId: chunk.ruleId,
          ruleNumber: chunk.ruleNumber,
          sourceAct: chunk.sourceAct,
          clause: chunk.clause ?? "",
          text: chunk.text,
          similarityScore: chunk.similarityScore,
          statutoryObligation: chunk.statutoryObligation,
          effectiveDate: chunk.effectiveDate,
          referenced: true,
        })),
        disclaimer: DISCLAIMER,
      };
    }

    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({
        model: env.GEMINI_MODEL,
        systemInstruction: SYSTEM_PROMPT,
      });

      const result = await model.generateContent(
        `Question from a field officer:\n${question}\n\n` +
          `Statutory excerpts retrieved for this question:\n\n${buildContextBlock(chunks)}\n\n` +
          `Answer using only the excerpts above, citing rule number and clause inline.`,
      );

      const answer = cleanAnswer(result.response.text());
      if (!answer) throw new Error("Model returned an empty answer");

      return {
        question,
        category,
        answer,
        grounded: true,
        generated: true,
        refusal: null,
        citations: keepReferencedCitations(chunks, answer),
        disclaimer: DISCLAIMER,
      };
    } catch (error) {
      // A model failure must not become a fabricated answer.
      logger.warn("Assistant generation failed; returning retrieval only", {
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        question,
        category,
        answer: null,
        grounded: true,
        generated: false,
        refusal: "NO_MODEL",
        citations: chunks.map((chunk) => ({
          ruleId: chunk.ruleId,
          ruleNumber: chunk.ruleNumber,
          sourceAct: chunk.sourceAct,
          clause: chunk.clause ?? "",
          text: chunk.text,
          similarityScore: chunk.similarityScore,
          statutoryObligation: chunk.statutoryObligation,
          effectiveDate: chunk.effectiveDate,
          referenced: true,
        })),
        disclaimer: DISCLAIMER,
      };
    }
  }
}