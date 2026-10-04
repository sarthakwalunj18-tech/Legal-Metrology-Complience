import { buildApp } from "../app.js";
import { DBRepo } from "../db/repo.js";

/**
 * Authorisation regressions for the supervisory review workflow and global search.
 *
 * These are the two write/read paths where a scoping mistake would silently
 * expose another officer's statutory determinations, so each rule below is
 * asserted directly against the running Fastify app.
 */

const INSPECTOR = { role: "INSPECTOR", id: "11111111-1111-1111-1111-111111111111" };
const SUPERVISOR = { role: "SUPERVISOR", id: "22222222-2222-2222-2222-222222222222" };
const ADMIN = { role: "ADMIN", id: "33333333-3333-3333-3333-333333333333" };

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

async function login(app: ReturnType<typeof buildApp>, role: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { role } });
  if (res.statusCode !== 200) throw new Error(`Login as ${role} failed: ${res.statusCode}`);
  return res.json().data.token as string;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function run() {
  console.log("==================================================");
  console.log("🔐 REVIEW WORKFLOW & SEARCH SCOPING");
  console.log("==================================================");

  const app = buildApp();

  const inspectorToken = await login(app, INSPECTOR.role);
  const supervisorToken = await login(app, SUPERVISOR.role);
  const adminToken = await login(app, ADMIN.role);

  // Inspector-authored inspection, same department as the supervisor.
  const ownScan = await DBRepo.insertScan({
    scanNumber: "REV-OWN-001",
    status: "COMPLETED",
    complianceStatus: "REQUIRES_REVIEW",
    inspectorId: INSPECTOR.id,
    location: "Review scope harness, Zone A",
  });

  // Inspection owned by the supervisor's own department but authored by the
  // supervisor — used for the separation-of-duties assertion.
  const supervisorAuthoredScan = await DBRepo.insertScan({
    scanNumber: "REV-SELF-002",
    status: "COMPLETED",
    complianceStatus: "REQUIRES_REVIEW",
    inspectorId: SUPERVISOR.id,
    location: "Review scope harness, Zone B",
  });

  // Inspection owned by another department entirely.
  const foreignScan = await DBRepo.insertScan({
    scanNumber: "REV-FOREIGN-003",
    status: "COMPLETED",
    complianceStatus: "REQUIRES_REVIEW",
    inspectorId: ADMIN.id,
    location: "Review scope harness, Foreign Zone",
  });

  console.log("\n1️⃣ Inspectors have no review permission at all");
  const inspectorQueue = await app.inject({
    method: "GET",
    url: "/api/reviews",
    headers: auth(inspectorToken),
  });
  check("GET /api/reviews as INSPECTOR is 403", inspectorQueue.statusCode === 403, `got ${inspectorQueue.statusCode}`);

  const inspectorDecision = await app.inject({
    method: "POST",
    url: `/api/reviews/${ownScan.id}/decision`,
    headers: auth(inspectorToken),
    payload: { decision: "ACCEPTED", notes: "self sign-off attempt" },
  });
  check(
    "POST decision as INSPECTOR is 403",
    inspectorDecision.statusCode === 403,
    `got ${inspectorDecision.statusCode}`,
  );

  console.log("\n2️⃣ Review queue is scoped, not global");
  const supervisorQueue = await app.inject({
    method: "GET",
    url: "/api/reviews",
    headers: auth(supervisorToken),
  });
  const queueIds = (supervisorQueue.json().data.reviews as { id: string }[]).map((r) => String(r.id));
  check("Supervisor queue is 200", supervisorQueue.statusCode === 200, `got ${supervisorQueue.statusCode}`);
  check("Queue includes same-department case", queueIds.includes(String(ownScan.id)));
  check("Queue excludes other-department case", !queueIds.includes(String(foreignScan.id)));
  check("Queue reports department scope", supervisorQueue.json().data.scope === "department");

  console.log("\n3️⃣ A decision cannot be aimed at an out-of-scope id");
  const foreignDecision = await app.inject({
    method: "POST",
    url: `/api/reviews/${foreignScan.id}/decision`,
    headers: auth(supervisorToken),
    payload: { decision: "ACCEPTED", notes: "attempting cross-department sign-off" },
  });
  check(
    "Cross-department decision is 403",
    foreignDecision.statusCode === 403,
    `got ${foreignDecision.statusCode}`,
  );
  const foreignAfter = await DBRepo.getScan(String(foreignScan.id));
  check(
    "Out-of-scope record is untouched",
    foreignAfter?.reviewStatus === "PENDING",
    `reviewStatus=${foreignAfter?.reviewStatus}`,
  );

  console.log("\n4️⃣ Separation of duties holds for the author's own department");
  const selfDecision = await app.inject({
    method: "POST",
    url: `/api/reviews/${supervisorAuthoredScan.id}/decision`,
    headers: auth(supervisorToken),
    payload: { decision: "ACCEPTED", notes: "signing off my own inspection" },
  });
  check("Author cannot sign off own inspection", selfDecision.statusCode === 403, `got ${selfDecision.statusCode}`);
  check(
    "Rejection is attributed to separation of duties",
    String(selfDecision.json()?.error?.message ?? "").toLowerCase().includes("separation of duties"),
    selfDecision.json()?.error?.message,
  );

  const adminSelfDecision = await app.inject({
    method: "POST",
    url: `/api/reviews/${foreignScan.id}/decision`,
    headers: auth(adminToken),
    payload: { decision: "ACCEPTED", notes: "admin signing own inspection" },
  });
  check(
    "Administrator cannot bypass separation of duties",
    adminSelfDecision.statusCode === 403,
    `got ${adminSelfDecision.statusCode}`,
  );

  console.log("\n5️⃣ Decision payload is validated before anything is written");
  const missingStatus = await app.inject({
    method: "POST",
    url: `/api/reviews/${ownScan.id}/decision`,
    headers: auth(supervisorToken),
    payload: { decision: "OVERRIDDEN", notes: "override without a corrected status" },
  });
  check("Override without status is rejected", missingStatus.statusCode === 400, `got ${missingStatus.statusCode}`);

  const contradictory = await app.inject({
    method: "POST",
    url: `/api/reviews/${ownScan.id}/decision`,
    headers: auth(supervisorToken),
    payload: { decision: "ACCEPTED", notes: "accept but restate an outcome", overriddenStatus: "COMPLIANT" },
  });
  check("Accept cannot also override", contradictory.statusCode === 400, `got ${contradictory.statusCode}`);

  const thinNotes = await app.inject({
    method: "POST",
    url: `/api/reviews/${ownScan.id}/decision`,
    headers: auth(supervisorToken),
    payload: { decision: "ACCEPTED", notes: "" },
  });
  check("Empty notes are rejected", thinNotes.statusCode === 400, `got ${thinNotes.statusCode}`);

  const stillPending = await DBRepo.getScan(String(ownScan.id));
  check("Rejected payloads wrote nothing", stillPending?.reviewStatus === "PENDING", `reviewStatus=${stillPending?.reviewStatus}`);

  console.log("\n6️⃣ A valid override is recorded on both the scan and the audit trail");
  const override = await app.inject({
    method: "POST",
    url: `/api/reviews/${ownScan.id}/decision`,
    headers: auth(supervisorToken),
    payload: {
      decision: "OVERRIDDEN",
      notes: "Packaging declaration does not match the declared net quantity.",
      overriddenStatus: "NON_COMPLIANT",
    },
  });
  check("Valid override is 200", override.statusCode === 200, `got ${override.statusCode}`);

  const afterOverride = await DBRepo.getScan(String(ownScan.id));
  check("Compliance status updated", afterOverride?.complianceStatus === "NON_COMPLIANT", `${afterOverride?.complianceStatus}`);
  check("Review status updated", afterOverride?.reviewStatus === "OVERRIDDEN", `${afterOverride?.reviewStatus}`);
  check("Reviewer recorded", String(afterOverride?.reviewedBy ?? "") === SUPERVISOR.id);
  check("Reviewer notes retained", String(afterOverride?.reviewerNotes ?? "").startsWith("Packaging declaration"));
  check("Review timestamp recorded", Boolean(afterOverride?.reviewedAt));

  const audit = await DBRepo.getAuditLogsPage({ page: 1, pageSize: 50 });
  const entry = (audit.items as { resourceId: string; action: string; details: Record<string, unknown> }[]).find(
    (row) => String(row.resourceId) === String(ownScan.id) && row.action === "INSPECTION_OVERRIDDEN",
  );
  check("Override written to the audit log", Boolean(entry));
  check(
    "Audit keeps the original AI decision",
    entry?.details?.aiDecision === "REQUIRES_REVIEW",
    String(entry?.details?.aiDecision),
  );
  check(
    "Audit keeps the final human decision",
    entry?.details?.finalComplianceStatus === "NON_COMPLIANT",
    String(entry?.details?.finalComplianceStatus),
  );
  check("Audit records disagreement", entry?.details?.agreement === "DISAGREED", String(entry?.details?.agreement));
  check("Audit records the reviewer role", entry?.details?.reviewerRole === "SUPERVISOR");

  console.log("\n7️⃣ Global search cannot be used to escape scope");
  const adminSearch = await app.inject({
    method: "GET",
    url: "/api/search?q=REV-FOREIGN-003",
    headers: auth(adminToken),
  });
  const adminHits = adminSearch.json().data.inspections as { id: string }[];
  check(
    "Administrator finds the global record",
    adminHits.some((hit) => String(hit.id) === String(foreignScan.id)),
  );

  const inspectorSearch = await app.inject({
    method: "GET",
    url: "/api/search?q=REV-FOREIGN-003",
    headers: auth(inspectorToken),
  });
  check("Inspector search is 200", inspectorSearch.statusCode === 200, `got ${inspectorSearch.statusCode}`);
  const inspectorData = inspectorSearch.json().data;
  check(
    "Inspector cannot discover another officer's inspection",
    !(inspectorData.inspections as { id: string }[]).some((hit) => String(hit.id) === String(foreignScan.id)),
  );
  check("Inspector search reports own scope", inspectorData.scope === "own");

  const supervisorSearch = await app.inject({
    method: "GET",
    url: "/api/search?q=REV-FOREIGN-003",
    headers: auth(supervisorToken),
  });
  check(
    "Supervisor search excludes other departments",
    !(supervisorSearch.json().data.inspections as { id: string }[]).some(
      (hit) => String(hit.id) === String(foreignScan.id),
    ),
  );
  check("Supervisor search reports department scope", supervisorSearch.json().data.scope === "department");

  console.log("\n8️⃣ Empty search returns the same shape as a populated one");
  const emptySearch = await app.inject({
    method: "GET",
    url: "/api/search?q=",
    headers: auth(inspectorToken),
  });
  const emptyData = emptySearch.json().data;
  check(
    "Empty query returns every group as an array",
    ["inspections", "products", "rules", "violations"].every((key) => Array.isArray(emptyData[key])),
  );
  check("Empty query still reports scope", emptyData.scope === "own");

  await app.close();

  console.log("\n==================================================");
  if (failures.length === 0) {
    console.log(`✅ All ${passed} review/search authorisation checks passed`);
    console.log("==================================================");
    return;
  }

  console.log(`❌ ${failures.length} failed, ${passed} passed`);
  for (const failure of failures) console.log(`   - ${failure}`);
  console.log("==================================================");
  throw new Error("Review workflow authorisation regressions detected");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});