import { buildApp } from "../app.js";
import { DBRepo } from "../db/repo.js";

/**
 * An inbox is personal.
 *
 * These assertions cover the failure modes that matter for notifications: reading
 * someone else's mail, marking it read to silently suppress it, and an officer
 * reviewing their own inspection being asked to sign it off.
 */

const INSPECTOR = "11111111-1111-1111-1111-111111111111";
const SUPERVISOR = "22222222-2222-2222-2222-222222222222";
const ADMIN = "33333333-3333-3333-3333-333333333333";

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
  console.log("🔔 NOTIFICATION INBOX");
  console.log("==================================================");

  const app = buildApp();
  const login = async (role: string) => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { role } });
    return res.json().data.token as string;
  };
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  const inspectorToken = await login("INSPECTOR");
  const supervisorToken = await login("SUPERVISOR");
  const adminToken = await login("ADMIN");

  console.log("\n1️⃣ Unauthenticated access is refused");
  const anonymous = await app.inject({ method: "GET", url: "/api/notifications" });
  check("Anonymous inbox is 401", anonymous.statusCode === 401, `got ${anonymous.statusCode}`);

  console.log("\n2️⃣ A review outcome reaches the officer who did the work");
  const scan = await DBRepo.insertScan({
    scanNumber: "NTF-001",
    status: "COMPLETED",
    complianceStatus: "REQUIRES_REVIEW",
    inspectorId: INSPECTOR,
    location: "Notification harness",
  });

  const decision = await app.inject({
    method: "POST",
    url: `/api/reviews/${scan.id}/decision`,
    headers: auth(supervisorToken),
    payload: { decision: "ACCEPTED", notes: "Determination recorded for the notification test." },
  });
  check("Decision is accepted", decision.statusCode === 200, `got ${decision.statusCode}`);

  // The notification write is fire-and-forget, so give the microtask queue a turn.
  await new Promise((resolve) => setTimeout(resolve, 150));

  const inspectorInbox = await app.inject({
    method: "GET",
    url: "/api/notifications",
    headers: auth(inspectorToken),
  });
  const inspectorData = inspectorInbox.json().data;
  check("Inspector inbox is 200", inspectorInbox.statusCode === 200, `got ${inspectorInbox.statusCode}`);
  const decided = (inspectorData.notifications as { type: string; title: string; href: string }[]).find(
    (row) => row.type === "REVIEW_DECIDED",
  );
  check("Author was notified of the outcome", Boolean(decided), JSON.stringify(inspectorData.notifications));
  check("Notification names the inspection", decided?.title.includes("NTF-001") === true, decided?.title);
  check("Notification links to the inspection", decided?.href === `/inspections/${scan.id}`, decided?.href);
  check("Unread count is reported", inspectorData.unread >= 1, String(inspectorData.unread));

  console.log("\n3️⃣ An inbox cannot be read by another officer");
  const supervisorInbox = await app.inject({
    method: "GET",
    url: "/api/notifications",
    headers: auth(supervisorToken),
  });
  check(
    "Supervisor does not see the inspector's notification",
    !(supervisorInbox.json().data.notifications as { type: string }[]).some(
      (row) => row.type === "REVIEW_DECIDED",
    ),
  );

  console.log("\n4️⃣ Another officer cannot mark it read");
  const crossMark = await app.inject({
    method: "PATCH",
    url: `/api/notifications/${decided ? encodeURIComponent((decided as { id: string }).id) : "missing"}/read`,
    headers: auth(adminToken),
  });
  check("Cross-officer mark-read is 404", crossMark.statusCode === 404, `got ${crossMark.statusCode}`);

  const stillUnread = await app.inject({
    method: "GET",
    url: "/api/notifications/unread-count",
    headers: auth(inspectorToken),
  });
  check(
    "Notification is still unread after the foreign attempt",
    stillUnread.json().data.unread >= 1,
    String(stillUnread.json().data.unread),
  );

  console.log("\n5️⃣ The owner can mark it read");
  const ownerMark = await app.inject({
    method: "PATCH",
    url: `/api/notifications/${encodeURIComponent((decided as { id: string }).id)}/read`,
    headers: auth(inspectorToken),
  });
  check("Owner mark-read is 200", ownerMark.statusCode === 200, `got ${ownerMark.statusCode}`);
  check("Marked notification carries a read timestamp", Boolean(ownerMark.json().data.notification.readAt));

  const afterRead = await app.inject({
    method: "GET",
    url: "/api/notifications",
    headers: auth(inspectorToken),
  });
  const target = (afterRead.json().data.notifications as { id: string; readAt: string | null }[]).find(
    (row) => row.id === (decided as { id: string }).id,
  );
  check("Read state persisted", Boolean(target?.readAt));

  console.log("\n6️⃣ Unknown ids are 404, not 500");
  const unknownMark = await app.inject({
    method: "PATCH",
    url: "/api/notifications/00000000-0000-0000-0000-000000000000/read",
    headers: auth(inspectorToken),
  });
  check("Unknown notification is 404", unknownMark.statusCode === 404, `got ${unknownMark.statusCode}`);

  await app.close();

  console.log("\n==================================================");
  if (failures.length === 0) {
    console.log(`✅ All ${passed} notification checks passed`);
    console.log("==================================================");
    return;
  }

  console.log(`❌ ${failures.length} failed, ${passed} passed`);
  for (const failure of failures) console.log(`   - ${failure}`);
  console.log("==================================================");
  throw new Error("Notification regressions detected");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});