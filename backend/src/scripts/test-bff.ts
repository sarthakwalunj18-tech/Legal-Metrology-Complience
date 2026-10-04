/**
 * Live integration probe for the frontend BFF.
 *
 * Boots the real Fastify backend and the real Next.js production server as
 * child processes, then drives the full browser-equivalent flow over HTTP:
 *   login -> session cookies -> proxied reads -> permission denial -> logout.
 *
 * Run with: npx tsx src/scripts/test-bff.ts
 */
import { spawn, ChildProcess } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.resolve(__dirname, "../..");
const FRONTEND_DIR = path.resolve(__dirname, "../../../frontend");

const API_PORT = 8123;
const WEB_PORT = 3123;
const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;
const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;
const REQUEST_TIMEOUT_MS = 20_000;

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`   OK   ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed += 1;
    console.error(`   FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function httpJson(
  url: string,
  options: { method?: string; body?: unknown; cookie?: string } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload =
      options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));

    const headers: Record<string, string> = { accept: "application/json" };
    if (payload) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(payload.byteLength);
    }
    if (options.cookie) headers.cookie = options.cookie;

    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: options.method ?? "GET",
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: unknown = null;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            body = text;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
      },
    );

    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`timeout: ${url}`)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitFor(url: string, label: string, attempts = 90): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await httpJson(url);
      if (res.status > 0) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${label} never became reachable at ${url}`);
}

function startProcess(label: string, cwd: string, command: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  const tail = (stream: NodeJS.ReadableStream | null, isError: boolean) => {
    if (!stream) return;
    let buffer = "";
    stream.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (/error|fatal|unhandled|EADDRINUSE/i.test(line) && isError) {
          console.error(`   [${label}] ${line.trim()}`);
        }
      }
    });
  };

  tail(child.stdout, false);
  tail(child.stderr, true);
  return child;
}

function stopProcess(child: ChildProcess | undefined): void {
  if (!child || child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", shell: true });
  } else {
    child.kill("SIGTERM");
  }
}

function lmCookieHeader(setCookie: string[] | undefined): string {
  return (setCookie ?? [])
    .map((entry) => entry.split(";")[0])
    .filter((pair) => pair.startsWith("lm_"))
    .join("; ");
}

function hasCookie(setCookie: string[] | undefined, name: string): boolean {
  return (setCookie ?? []).some((entry) => entry.startsWith(`${name}=`) && !entry.endsWith("="));
}

async function main(): Promise<void> {
  console.log("\n=== BFF / SESSION INTEGRATION TEST =====================================\n");

  let backend: ChildProcess | undefined;
  let frontend: ChildProcess | undefined;

  const watchdog = setTimeout(() => {
    console.error("\nBFF integration test exceeded its global time budget.");
    stopProcess(backend);
    stopProcess(frontend);
    process.exit(1);
  }, 300_000);
  watchdog.unref();

  try {
    backend = startProcess("backend", BACKEND_DIR, "npx", ["tsx", "src/server.ts"], {
      PORT: String(API_PORT),
      HOST: "127.0.0.1",
      NODE_ENV: "development",
    });
    await waitFor(`${API_ORIGIN}/api/health/live`, "Fastify backend");
    console.log("[1] Fastify backend is live");

    frontend = startProcess(
      "frontend",
      FRONTEND_DIR,
      "npx",
      ["next", "start", "-p", String(WEB_PORT), "-H", "127.0.0.1"],
      { BACKEND_URL: API_ORIGIN, NODE_ENV: "production" },
    );
    await waitFor(`${WEB_ORIGIN}/login`, "Next.js frontend");
    console.log("[2] Next.js frontend is live\n");

    console.log("[3] Unauthenticated access is refused");
    const anon = await httpJson(`${WEB_ORIGIN}/api/backend/dashboard/stats`);
    check("proxied API call without a session is 401", anon.status === 401, `got ${anon.status}`);

    console.log("\n[4] Demo sign-in through the BFF");
    const login = await httpJson(`${WEB_ORIGIN}/api/session`, {
      method: "POST",
      body: { role: "INSPECTOR" },
    });
    check("login succeeds", login.status === 200, `got ${login.status}`);
    check("login response omits the access token", login.body?.data?.token === undefined);

    const setCookies = login.headers["set-cookie"] as unknown as string[] | undefined;
    const inspectorCookie = lmCookieHeader(setCookies);
    check("access token stored in a cookie", hasCookie(setCookies, "lm_access_token"));
    check(
      "access cookie is HttpOnly",
      (setCookies ?? []).some((e) => e.startsWith("lm_access_token=") && /HttpOnly/i.test(e)),
    );
    check("access cookie is SameSite protected", (setCookies ?? []).some((e) => /SameSite/i.test(e)));
    check("session identity cookie set", hasCookie(setCookies, "lm_session_user"));
    check("role resolved from backend", login.body?.data?.user?.role === "INSPECTOR");
    check(
      "authoritative department returned",
      login.body?.data?.user?.department === "Legal Metrology Zonal Office",
    );

    console.log("\n[5] Proxied reads use the cookie transparently");
    const me = await httpJson(`${WEB_ORIGIN}/api/backend/auth/me`, { cookie: inspectorCookie });
    check(
      "/auth/me via proxy",
      me.status === 200 && me.body?.data?.user?.email === "inspector.sarthak@lm.gov.in",
    );

    const dashboard = await httpJson(`${WEB_ORIGIN}/api/backend/dashboard/stats`, { cookie: inspectorCookie });
    check("dashboard via proxy", dashboard.status === 200, `got ${dashboard.status}`);
    check("inspector receives own-scope metrics", dashboard.body?.data?.scope === "own");

    const liveness = await httpJson(`${WEB_ORIGIN}/api/backend/health/live`);
    check("liveness reachable without a session", liveness.status === 200);

    const rules = await httpJson(`${WEB_ORIGIN}/api/backend/rules`, { cookie: inspectorCookie });
    check(
      "statutory rule library readable",
      rules.status === 200 && (rules.body?.data?.total ?? 0) > 0,
      `${rules.body?.data?.total ?? 0} rules`,
    );

    const reports = await httpJson(`${WEB_ORIGIN}/api/backend/reports`, { cookie: inspectorCookie });
    check("reports list readable", reports.status === 200, `total=${reports.body?.data?.total}`);

    console.log("\n[6] Permission boundaries are enforced server-side");
    const analytics = await httpJson(`${WEB_ORIGIN}/api/backend/analytics`, { cookie: inspectorCookie });
    check("inspector denied analytics (403)", analytics.status === 403, `got ${analytics.status}`);

    const audit = await httpJson(`${WEB_ORIGIN}/api/backend/audit-logs`, { cookie: inspectorCookie });
    check("inspector denied audit logs (403)", audit.status === 403, `got ${audit.status}`);

    const system = await httpJson(`${WEB_ORIGIN}/api/backend/system/status`, { cookie: inspectorCookie });
    check("inspector denied system status (403)", system.status === 403, `got ${system.status}`);

    const ruleEdit = await httpJson(`${WEB_ORIGIN}/api/backend/rules/1`, {
      method: "PUT",
      cookie: inspectorCookie,
      body: { packType: "tampered" },
    });
    check(
      "rule library is read-only through the BFF",
      ruleEdit.status === 404 || ruleEdit.status === 405,
      `got ${ruleEdit.status}`,
    );

    console.log("\n[7] Administrator session sees the wider surface");
    const adminLogin = await httpJson(`${WEB_ORIGIN}/api/session`, {
      method: "POST",
      body: { role: "ADMIN" },
    });
    const adminCookie = lmCookieHeader(adminLogin.headers["set-cookie"] as unknown as string[] | undefined);
    check("admin sign-in succeeds", adminLogin.status === 200, `got ${adminLogin.status}`);

    const adminAnalytics = await httpJson(`${WEB_ORIGIN}/api/backend/analytics`, { cookie: adminCookie });
    check("admin analytics allowed", adminAnalytics.status === 200, `got ${adminAnalytics.status}`);

    const adminSystem = await httpJson(`${WEB_ORIGIN}/api/backend/system/status`, { cookie: adminCookie });
    check("admin system status allowed", adminSystem.status === 200, `got ${adminSystem.status}`);
    check(
      "system status reports environment",
      typeof adminSystem.body?.environment === "string",
      String(adminSystem.body?.environment),
    );
    check(
      "system status never leaks secrets",
      !JSON.stringify(adminSystem.body ?? {}).match(/service_role|sk-|SUPABASE_SERVICE/i),
    );

    console.log("\n[8] Logout clears the browser session");
    const logout = await httpJson(`${WEB_ORIGIN}/api/session`, { method: "DELETE", cookie: adminCookie });
    check("logout succeeds", logout.status === 200, `got ${logout.status}`);

    const cleared = logout.headers["set-cookie"] as unknown as string[] | undefined;
    check(
      "logout expires the access cookie",
      (cleared ?? []).some((e) => e.startsWith("lm_access_token=") && /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(e)),
    );
    check(
      "logout expires the identity cookie",
      (cleared ?? []).some((e) => e.startsWith("lm_session_user=") && /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(e)),
    );

    const freshSession = await httpJson(`${WEB_ORIGIN}/api/session`);
    check("no session is established after logout", freshSession.body?.data?.user == null);

    console.log("\n[9] Public health endpoint leaks no diagnostics");
    const publicHealth = await httpJson(`${API_ORIGIN}/api/health`);
    check("health responds", publicHealth.status === 200 || publicHealth.status === 503);
    check("health hides dependency details", publicHealth.body?.dependencies === undefined);
    check("health hides environment", publicHealth.body?.environment === undefined);
    check("health hides feature flags", publicHealth.body?.features === undefined);

    console.log("\n[10] Tampered or stale credentials are rejected");
    const forged = await httpJson(`${WEB_ORIGIN}/api/backend/dashboard/stats`, {
      cookie: "lm_access_token=forged.jwt.value",
    });
    check(
      "forged access token is refused without a crash",
      forged.status === 401 && typeof forged.body?.error?.code === "string",
      `got ${forged.status} / ${forged.body?.error?.code}`,
    );

    const directAnonymous = await httpJson(`${API_ORIGIN}/api/dashboard/stats`);
    check("backend refuses a request with no bearer token", directAnonymous.status === 401, `got ${directAnonymous.status}`);

    const sessionProbe = await httpJson(`${WEB_ORIGIN}/api/session`, {
      cookie: "lm_access_token=forged.jwt.value",
    });
    check(
      "session probe reports no user for an invalid token",
      sessionProbe.status === 200 && sessionProbe.body?.data?.user == null,
      `got ${sessionProbe.status}`,
    );

    console.log("\n[11] Media links are signed, not guessable");
    const unsignedMedia = await httpJson(`${API_ORIGIN}/api/media/image%2Fjpeg`);
    check("media route without a token is refused", unsignedMedia.status === 401, `got ${unsignedMedia.status}`);

    const tamperedMedia = await httpJson(
      `${API_ORIGIN}/api/media/image%2Fjpeg?token=eyJwYXRoIjoiYS5qcGciLCJleHAiOjk5OTk5OTk5OTl9.forged`,
    );
    check("media route with a forged signature is refused", tamperedMedia.status === 401, `got ${tamperedMedia.status}`);
  } finally {
    stopProcess(frontend);
    stopProcess(backend);
    clearTimeout(watchdog);
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ====================================\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error("\nBFF integration test crashed:", error);
  process.exitCode = 1;
});