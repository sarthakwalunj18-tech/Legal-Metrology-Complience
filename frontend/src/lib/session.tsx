"use client";

/**
 * Browser-side session context.
 *
 * Identity comes from the BFF (`/api/session`), which reads the httpOnly
 * cookies. No Supabase credential is ever exposed to client JavaScript.
 */
import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  API_PROXY_PREFIX,
  SESSION_ENDPOINT,
  hasPermission,
  roleLabel,
  type ApiEnvelope,
  type PlatformRole,
  type SessionUser,
} from "@/lib/api";

export { API_PROXY_PREFIX, SESSION_ENDPOINT, roleLabel };
export type { PlatformRole, SessionUser };

interface SessionContextValue {
  user: SessionUser | null;
  role: PlatformRole | null;
  loading: boolean;
  error: string | null;
  can: (permission: string) => boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

/**
 * Authenticated fetch against the same-origin BFF proxy. The session cookie is
 * attached automatically by the browser; the proxy swaps it for a bearer token.
 *
 * Pass `json` for JSON payloads or `rawBody` for multipart/form-data.
 */
export interface ApiFetchOptions extends Omit<RequestInit, "body"> {
  json?: unknown;
  rawBody?: BodyInit;
  contentType?: string;
}

export async function apiFetch<T = unknown>(
  path: string,
  init: ApiFetchOptions = {},
): Promise<T> {
  const { json, rawBody, contentType, headers, ...rest } = init;

  const merged = new Headers(headers);
  merged.set("accept", "application/json");

  let payload: BodyInit | undefined;
  if (rawBody !== undefined) {
    payload = rawBody;
    if (contentType) merged.set("content-type", contentType);
  } else if (json !== undefined) {
    payload = JSON.stringify(json);
    merged.set("content-type", "application/json");
  }

  const response = await fetch(`${API_PROXY_PREFIX}${path}`, {
    ...rest,
    headers: merged,
    body: payload,
    credentials: "same-origin",
    cache: "no-store",
  });

  const text = await response.text();
  let parsed: ApiEnvelope<T> | null = null;
  try {
    parsed = text ? (JSON.parse(text) as ApiEnvelope<T>) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    throw new ApiRequestError(
      response.status,
      parsed?.error?.code ?? "UPSTREAM_ERROR",
      parsed?.error?.message ?? `Request failed with HTTP ${response.status}.`,
    );
  }

  return (parsed?.data ?? (parsed as unknown as T)) as T;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(SESSION_ENDPOINT, { cache: "no-store", credentials: "same-origin" });
      const body = (await response.json()) as { data?: { user: SessionUser | null } };
      setUser(body.data?.user ?? null);
      setError(null);
    } catch {
      setUser(null);
      setError("Unable to reach the session service.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const signOut = useCallback(async () => {
    await fetch(SESSION_ENDPOINT, { method: "DELETE", credentials: "same-origin" }).catch(() => undefined);
    setUser(null);
    router.replace("/login");
  }, [router]);

  const value = useMemo<SessionContextValue>(
    () => ({
      user,
      role: user?.role ?? null,
      loading,
      error,
      can: (permission: string) => hasPermission(user, permission),
      refresh: load,
      signOut,
    }),
    [user, loading, error, load, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error("useSession must be used inside <SessionProvider>.");
  return context;
}
