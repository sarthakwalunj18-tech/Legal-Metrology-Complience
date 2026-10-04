import { buildApp } from "../app.js";

/**
 * The assistant must never invent law.
 *
 * These assertions cover the two ways a fabricated answer could appear: answering a
 * question the corpus cannot support, and presenting a citation the answer never used.
 */

let passed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    passed += 1;
    console.log(`   ✓ ${label}`);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`   ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function run() {
  console.log("==================================================");
  console.log("⚖️  GROUNDED STATUTORY ASSISTANCE");
  console.log("==================================================");

  const app = buildApp();
  const login = async (role: string) => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { role } });
    return res.json().data.token as string;
  };
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  const inspectorToken = await login("INSPECTOR");

  console.log("\n1️⃣ Unauthenticated and unauthorised callers are refused");
  const anonymous = await app.inject({ method: "POST", url: "/api/rag/ask", payload: { question: "MRP rules" } });
  check("Anonymous ask is 401", anonymous.statusCode === 401, `got ${anonymous.statusCode}`);

  console.log("\n2️⃣ A grounded question returns statutory support");
  const grounded = await app.inject({
    method: "POST",
    url: "/api/rag/ask",
    payload: { question: "What are the mandatory declarations on a packaged commodity?" },
    headers: auth(inspectorToken),
  });
  check("Ask is 200", grounded.statusCode === 200, `got ${grounded.statusCode}`);
  const answer = grounded.json().data;
  check("Response is marked grounded", answer.grounded === true);
  check("Citations are present", Array.isArray(answer.citations) && answer.citations.length > 0);
  check(
    "Every citation carries rule number and text",
    (answer.citations as { ruleNumber: string; text: string }[]).every(
      (c) => Boolean(c.ruleNumber) && Boolean(c.text),
    ),
  );
  check("A disclaimer is always returned", typeof answer.disclaimer === "string" && answer.disclaimer.length > 0);
  check("Disclaimer states it is not a determination", /not a compliance determination/i.test(answer.disclaimer));

  if (!answer.generated) {
    check("Without a model the answer is withheld, not guessed", answer.answer === null);
    check("Without a model the refusal reason is explicit", answer.refusal === "NO_MODEL");
  } else {
    check("Generated answer is non-empty", typeof answer.answer === "string" && answer.answer.length > 0);
  }

  console.log("\n3️⃣ An unanswerable question is refused instead of answered");
  const unsupported = await app.inject({
    method: "POST",
    url: "/api/rag/ask",
    payload: { question: "What is the registration procedure for a drone racing league?" },
    headers: auth(inspectorToken),
  });
  const unsupportedData = unsupported.json().data;
  check("Ungrounded question is not marked grounded", unsupportedData.grounded === false);
  check("Ungrounded question has no answer text", unsupportedData.answer === null);
  check("Ungrounded question reports NO_GROUNDING", unsupportedData.refusal === "NO_GROUNDING");
  check("Ungrounded question has no citations", (unsupportedData.citations as unknown[]).length === 0);

  console.log("\n4️⃣ Malformed questions are rejected before any work happens");
  const tooShort = await app.inject({
    method: "POST",
    url: "/api/rag/ask",
    payload: { question: "x" },
    headers: auth(inspectorToken),
  });
  check("Too-short question is 400", tooShort.statusCode === 400, `got ${tooShort.statusCode}`);

  const tooLong = await app.inject({
    method: "POST",
    url: "/api/rag/ask",
    payload: { question: "a".repeat(501) },
    headers: auth(inspectorToken),
  });
  check("Over-long question is 400", tooLong.statusCode === 400, `got ${tooLong.statusCode}`);

  const blank = await app.inject({
    method: "POST",
    url: "/api/rag/ask",
    payload: {},
    headers: auth(inspectorToken),
  });
  check("Missing question is 400", blank.statusCode === 400, `got ${blank.statusCode}`);

  console.log("\n5️⃣ Every query is written to the audit trail");
  const audit = await app.inject({
    method: "GET",
    url: "/api/audit-logs?page=1&pageSize=50",
    headers: auth(await login("ADMIN")),
  });
  const entries = audit.json().data.logs as { action: string; details: Record<string, unknown> }[];
  const assistanceEntries = entries.filter((row) => row.action === "RAG_ASSISTANCE_REQUESTED");
  // The two 200s (grounded and refused). Rejected payloads never reach the service,
  // so they are deliberately not audited.
  check("Assistance queries are audited", assistanceEntries.length === 2, `${assistanceEntries.length} entries`);
  check(
    "Audit records whether the system could ground the answer",
    assistanceEntries.some((row) => row.details?.grounded === false && row.details?.refusal === "NO_GROUNDING"),
  );

  await app.close();

  console.log("\n==================================================");
  if (failures.length === 0) {
    console.log(`✅ All ${passed} grounding checks passed`);
    console.log("==================================================");
    return;
  }

  console.log(`❌ ${failures.length} failed, ${passed} passed`);
  for (const failure of failures) console.log(`   - ${failure}`);
  console.log("==================================================");
  throw new Error("Assistant grounding regressions detected");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});