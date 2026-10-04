import { buildApp } from "../app.js";
import { DBRepo } from "../db/repo.js";

async function runDashboardTest() {
  console.log("================================================================================");
  console.log("📊 MODULE 15: LIVE ENFORCEMENT DASHBOARD METRICS TEST");
  console.log("================================================================================");

  const app = buildApp();

  // 1. Seed some scans in DBRepo to verify dynamic calculation
  console.log("\n[STEP 1] Seeding Test Inspection Scans in Database...");
  const p1 = await DBRepo.insertProduct({ name: "Edible Sunflower Oil 1L", category: "Edible Oils" });
  const p2 = await DBRepo.insertProduct({ name: "Herbal Shampoo 200ml", category: "Cosmetics" });

  await DBRepo.insertScan({
    productId: p1.id,
    scanNumber: `INS-2026-${Math.floor(100000 + Math.random() * 900000)}`,
    status: "COMPLETED",
    complianceStatus: "COMPLIANT",
    complianceScore: "100.00",
  });

  await DBRepo.insertScan({
    productId: p2.id,
    scanNumber: `INS-2026-${Math.floor(100000 + Math.random() * 900000)}`,
    status: "COMPLETED",
    complianceStatus: "NON_COMPLIANT",
    complianceScore: "50.00",
  });

  console.log("   ✓ Test scans seeded successfully.");

  // 2. Query Dashboard Metrics API Endpoint (/api/dashboard/stats)
  console.log("\n[STEP 2] Requesting Aggregated Dashboard Statistics via Fastify API...");
  // Admin scope: the seeded rows above are not attributed to any inspector, so
  // only a global scope can see them. This doubles as a scope check.
  const response = await app.inject({
    method: "GET",
    url: "/api/dashboard/stats",
    headers: { authorization: "Bearer dev-admin" },
  });

  if (response.statusCode !== 200) {
    throw new Error(`Dashboard request failed: ${response.body}`);
  }

  const data = response.json().data;

  console.log("   ✓ Dashboard API returned HTTP 200 OK!");
  console.log(`   • Dashboard Scope    : ${data.scope}`);
  console.log(`   • Total Inspections : ${data.metrics.totalInspections}`);
  console.log(`   • Compliant Scans   : ${data.metrics.compliant}`);
  console.log(`   • Non-Compliant     : ${data.metrics.nonCompliant}`);
  console.log(`   • Requires Review   : ${data.metrics.requiresReview}`);
  console.log(`   • Compliance Rate   : ${data.metrics.complianceRatePercentage}%`);
  console.log(`   • Total Violations  : ${data.metrics.totalViolations}`);
  console.log(`   • Severity Buckets  : ${data.severityBreakdown.length}`);
  console.log(`   • Category Buckets  : ${data.topCategories.length}`);
  console.log(`   • Trend Periods     : ${data.complianceTrend.length}`);
  console.log(`   • Recent Feed Count : ${data.recentInspections.length}`);

  if (data.metrics.totalInspections < 2) {
    throw new Error("Admin dashboard did not aggregate the seeded inspections.");
  }

  // An inspector must never receive the organisation-wide aggregate.
  const inspectorRes = await app.inject({
    method: "GET",
    url: "/api/dashboard/stats",
    headers: { authorization: "Bearer dev-inspector" },
  });
  const inspectorData = inspectorRes.json().data;
  console.log(`   • Inspector Scope   : ${inspectorData.scope} (${inspectorData.metrics.totalInspections} inspections)`);
  if (inspectorData.scope === "global") {
    throw new Error("An inspector was served a global dashboard scope.");
  }

  // And nobody gets an aggregate without a session.
  const anonRes = await app.inject({ method: "GET", url: "/api/dashboard/stats" });
  if (anonRes.statusCode !== 401) {
    throw new Error(`Anonymous dashboard request was not refused (status ${anonRes.statusCode}).`);
  }

  console.log("\n================================================================================");
  console.log("✅ MODULE 15: LIVE ENFORCEMENT DASHBOARD VERIFIED!");
  console.log("================================================================================");
}

runDashboardTest().catch((err) => {
  console.error("❌ Module 15 dashboard test failed:", err);
  process.exit(1);
});
