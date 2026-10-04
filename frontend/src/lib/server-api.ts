/**
 * Server-only API helpers (route handlers / server components).
 *
 * Imports `next/headers`, so it must never be pulled into a client component.
 */
import { cookies } from "next/headers";
import type { NextResponse } from "next/server";
import {
  ACCESS_TOKEN_COOKIE,
  ApiEnvelope,
  BACKEND_URL,
  REFRESH_TOKEN_COOKIE,
  SESSION_USER_COOKIE,
  SessionUser,
} from "@/lib/api";

/** Supabase access tokens live one hour; refreshed transparently by the BFF. */
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7;

export class BackendError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "BackendError";
  }
}

function cookieBase() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
  };
}

export function accessTokenCookieOptions() {
  return { ...cookieBase(), maxAge: ACCESS_TOKEN_TTL_SECONDS };
}

export function refreshTokenCookieOptions() {
  return { ...cookieBase(), maxAge: REFRESH_TOKEN_TTL_SECONDS };
}

export function sessionUserCookieOptions() {
  return { ...cookieBase(), maxAge: REFRESH_TOKEN_TTL_SECONDS };
}

export interface BackendRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  token?: string | null;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  cache?: RequestCache;
}

export function buildBackendUrl(path: string, query?: BackendRequestOptions["query"]): string {
  const normalised = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${BACKEND_URL}/api${normalised}`);

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
  }

  return url.toString();
}

/** Single choke point for every server -> backend call. */
export async function backendFetch<T>(path: string, options: BackendRequestOptions = {}): Promise<T> {
  const { method = "GET", token, body, query, cache } = options;

  const headers: Record<string, string> = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;

  let payload: BodyInit | undefined;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["content-type"] = "application/json";
  }

  const response = await fetch(buildBackendUrl(path, query), {
    method,
    headers,
    body: payload,
    cache: cache ?? "no-store",
  });

  const text = await response.text();
  let parsed: ApiEnvelope<T> | null = null;
  try {
    parsed = text ? (JSON.parse(text) as ApiEnvelope<T>) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const code = parsed?.error?.code ?? "UPSTREAM_ERROR";
    const message = parsed?.error?.message ?? `Backend responded with HTTP ${response.status}.`;
    throw new BackendError(response.status, code, message, parsed?.error?.requestId);
  }

  return (parsed?.data ?? (parsed as unknown as T)) as T;
}

export async function readAccessToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(ACCESS_TOKEN_COOKIE)?.value ?? null;
}

export async function readRefreshToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(REFRESH_TOKEN_COOKIE)?.value ?? null;
}

export async function readSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const raw = store.get(SESSION_USER_COOKIE)?.value;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionUser;
  } catch {
    return null;
  }
}

/** Payload returned by `POST /auth/login` and `POST /auth/refresh`. */
export interface RefreshedSession {
  token: string;
  refreshToken?: string;
  expiresAt?: number | null;
  user?: SessionUser;
}

/**
 * Exchanges the httpOnly refresh token for a fresh access token.
 *
 * Returns `null` whenever the session can no longer be renewed (missing,
 * expired or revoked refresh token) so callers can fall back to a clean
 * sign-in instead of looping on 401s.
 */
export async function refreshSession(): Promise<RefreshedSession | null> {
  const refreshToken = await readRefreshToken();
  if (!refreshToken) return null;

  try {
    return await backendFetch<RefreshedSession>("/auth/refresh", {
      method: "POST",
      body: { refreshToken },
    });
  } catch (error) {
    if (error instanceof BackendError && error.status === 429) throw error;
    return null;
  }
}

/**
 * Writes a rotated session onto an outgoing Next.js response.
 *
 * Only route handlers may call this — it is the single place that turns a
 * refresh result into browser-visible cookies.
 */
export function applyRefreshedSession(
  response: NextResponse,
  session: RefreshedSession,
): NextResponse {
  response.cookies.set(ACCESS_TOKEN_COOKIE, session.token, accessTokenCookieOptions());
  if (session.refreshToken) {
    response.cookies.set(REFRESH_TOKEN_COOKIE, session.refreshToken, refreshTokenCookieOptions());
  }
  if (session.user) {
    response.cookies.set(SESSION_USER_COOKIE, JSON.stringify(session.user), sessionUserCookieOptions());
  }
  return response;
}

/** Clears every session cookie on an outgoing response. */
export function clearSessionCookies(response: NextResponse): NextResponse {
  response.cookies.set(ACCESS_TOKEN_COOKIE, "", { ...accessTokenCookieOptions(), maxAge: 0 });
  response.cookies.set(REFRESH_TOKEN_COOKIE, "", { ...refreshTokenCookieOptions(), maxAge: 0 });
  response.cookies.set(SESSION_USER_COOKIE, "", { ...sessionUserCookieOptions(), maxAge: 0 });
  return response;
}

export interface SessionFetchResult<T> {
  data: T | null;
  /** Present when the access token was rotated; caller must re-set cookies. */
  refreshed?: RefreshedSession;
  /** True when the caller has no usable session at all. */
  unauthenticated: boolean;
  /** Thrown-through backend failure (403/5xx etc.). */
  error?: BackendError;
}

/**
 * Authenticated fetch with transparent access-token renewal.
 *
 * On a 401 we exchange the refresh token once and replay the request, so an
 * hour-long inspection session survives without forcing a re-login. Only route
 * handlers should use this: they are the only place able to write the rotated
 * cookies back to the browser.
 */
export async function sessionFetch<T>(
  path: string,
  options: Omit<BackendRequestOptions, "token"> = {},
): Promise<SessionFetchResult<T>> {
  const token = await readAccessToken();
  if (!token) {
    const refreshed = await refreshSession();
    if (!refreshed) return { data: null, unauthenticated: true };
    return {
      data: await backendFetch<T>(path, { ...options, token: refreshed.token }),
      refreshed,
      unauthenticated: false,
    };
  }

  try {
    return { data: await backendFetch<T>(path, { ...options, token }), unauthenticated: false };
  } catch (error) {
    if (!(error instanceof BackendError) || error.status !== 401) {
      if (error instanceof BackendError && error.status === 403) {
        return { data: null, unauthenticated: false, error };
      }
      throw error;
    }
  }

  const refreshed = await refreshSession();
  if (!refreshed) return { data: null, unauthenticated: true };

  try {
    return {
      data: await backendFetch<T>(path, { ...options, token: refreshed.token }),
      refreshed,
      unauthenticated: false,
    };
  } catch (error) {
    if (error instanceof BackendError && error.status === 403) {
      return { data: null, unauthenticated: false, error };
    }
    throw error;
  }
}

/**
 * Server-rendered data fetch that transparently uses the caller's session.
 * Returns `null` when the caller is not authenticated so pages can render an
 * empty state instead of leaking an authorization error.
 */
export async function authenticatedFetch<T>(
  path: string,
  options: Omit<BackendRequestOptions, "token"> = {},
): Promise<T | null> {
  const token = await readAccessToken();
  if (!token) return null;
  try {
    return await backendFetch<T>(path, { ...options, token });
  } catch (error) {
    if (error instanceof BackendError && (error.status === 401 || error.status === 403)) return null;
    throw error;
  }
}
