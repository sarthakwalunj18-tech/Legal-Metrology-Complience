/**
 * Transparent BFF proxy for the Fastify API.
 *
 * `/api/backend/<path>` -> `${BACKEND_URL}/api/<path>` with the session cookie
 * translated into a bearer token. Client components therefore call same-origin
 * URLs only, and no token is ever readable by the browser.
 */
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { ACCESS_TOKEN_COOKIE } from "@/lib/api";
import { BACKEND_URL } from "@/lib/api";
import { refreshSession, applyRefreshedSession } from "@/lib/server-api";

export const dynamic = "force-dynamic";

/** Endpoints reachable without a session (liveness only). */
const PUBLIC_PATHS = new Set(["/health/live"]);

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
]);

type Params = { params: Promise<{ path?: string[] }> };

async function proxy(request: Request, { params }: Params): Promise<Response> {
  const { path = [] } = await params;
  const suffix = path.map((segment) => encodeURIComponent(segment)).join("/");
  const incoming = new URL(request.url);

  // Preserve the caller's query string, including repeatable keys.
  const target = new URL(`${BACKEND_URL}/api/${suffix}`);
  incoming.searchParams.forEach((value, key) => target.searchParams.append(key, value));

  const token = (await cookies()).get(ACCESS_TOKEN_COOKIE)?.value ?? null;
  const isPublic = PUBLIC_PATHS.has(`/${suffix}`);

  if (!token && !isPublic) {
    // The access token may simply have expired while the refresh token is still
    // valid — try to renew before telling the browser to sign in again.
    const renewed = await refreshSession().catch(() => null);
    if (renewed) {
      const retry = await forward(request, target, renewed.token, headersFor(request));
      return applyRefreshedSession(passthrough(retry), renewed);
    }
    return NextResponse.json(
      { error: { code: "UNAUTHENTICATED", message: "Sign in to continue." } },
      { status: 401 },
    );
  }

  const upstream = await forward(request, target, token, headersFor(request));

  if (upstream && upstream.status === 401 && token) {
    const renewed = await refreshSession().catch(() => null);
    if (renewed) {
      const retry = await forward(request, target, renewed.token, headersFor(request));
      if (retry && retry.status !== 401) {
        return applyRefreshedSession(passthrough(retry), renewed);
      }
    }
  }

  return passthrough(upstream);
}

function headersFor(request: Request): Headers {
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) return;
    if (lower === "host" || lower === "cookie") return;
    // Let fetch set the correct boundary/length headers for the new body.
    if (lower === "content-length") return;
    headers.set(lower, value);
  });
  headers.delete("accept-encoding");
  return headers;
}

async function forward(
  request: Request,
  target: URL,
  token: string | null,
  headers: Headers,
): Promise<Response | null> {
  if (token) headers.set("authorization", `Bearer ${token}`);

  const hasBody = !["GET", "HEAD"].includes(request.method);
  const body = hasBody ? await request.arrayBuffer() : undefined;

  try {
    return await fetch(target, {
      method: request.method,
      headers,
      body: body && body.byteLength > 0 ? body : undefined,
      cache: "no-store",
      redirect: "manual",
    });
  } catch {
    return null;
  }
}

function passthrough(upstream: Response | null): NextResponse {
  if (!upstream) {
    return NextResponse.json(
      {
        error: {
          code: "BACKEND_UNAVAILABLE",
          message: "The enforcement API is unreachable. Please retry.",
        },
      },
      { status: 503 },
    );
  }

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === "content-encoding" || lower === "content-length") return;
    responseHeaders.set(lower, value);
  });
  responseHeaders.set("cache-control", "no-store");

  return new NextResponse(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
