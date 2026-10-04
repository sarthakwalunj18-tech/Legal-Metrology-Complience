/**
 * Session BFF.
 *
 * POST   /api/session  { email, password } | { role }  -> sets httpOnly cookies
 * GET    /api/session                                   -> current identity
 * DELETE /api/session                                   -> clears cookies
 *
 * Tokens never reach client JavaScript.
 */
import { NextResponse } from "next/server";
import { SESSION_USER_COOKIE, type SessionUser } from "@/lib/api";
import {
  BackendError,
  applyRefreshedSession,
  backendFetch,
  clearSessionCookies,
  readAccessToken,
  readSessionUser,
  refreshSession,
  sessionUserCookieOptions,
} from "@/lib/server-api";

export const dynamic = "force-dynamic";

interface LoginResponse {
  mode: "demo" | "supabase";
  token: string;
  refreshToken?: string;
  expiresAt?: number | null;
  user: SessionUser;
}

function applySessionCookies(response: NextResponse, session: LoginResponse): NextResponse {
  return applyRefreshedSession(response, session);
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const payload = body as { email?: string; password?: string; role?: string };

  try {
    const session = await backendFetch<LoginResponse>("/auth/login", {
      method: "POST",
      body: {
        email: payload.email,
        password: payload.password,
        role: payload.role,
      },
    });

    const response = NextResponse.json({
      success: true,
      data: { user: session.user, mode: session.mode },
    });
    return applySessionCookies(response, session);
  } catch (error) {
    if (error instanceof BackendError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: { code: "BACKEND_UNAVAILABLE", message: "The enforcement API is unreachable." } },
      { status: 503 },
    );
  }
}

export async function GET() {
  const cached = await readSessionUser();

  try {
    const me = await backendFetch<{ user: SessionUser }>("/auth/me", { token: await readAccessToken() });
    const response = NextResponse.json({ data: { user: me.user } });
    // Refresh the cached identity so role changes take effect on next render.
    response.cookies.set(SESSION_USER_COOKIE, JSON.stringify(me.user), sessionUserCookieOptions());
    return response;
  } catch (error) {
    if (error instanceof BackendError && error.status === 401) {
      // Access token expired mid-session: renew silently instead of signing out.
      const renewed = await refreshSession().catch(() => null);
      if (renewed) {
        try {
          const me = await backendFetch<{ user: SessionUser }>("/auth/me", { token: renewed.token });
          const response = NextResponse.json({ data: { user: me.user } });
          return applyRefreshedSession(response, { ...renewed, user: me.user });
        } catch (retryError) {
          if (retryError instanceof BackendError && retryError.status !== 401 && retryError.status !== 403) {
            throw retryError;
          }
        }
      }
      return clearSessionCookies(NextResponse.json({ data: { user: null } }, { status: 200 }));
    }

    if (cached) {
      return NextResponse.json({ data: { user: cached } });
    }
    return NextResponse.json(
      { error: { code: "BACKEND_UNAVAILABLE", message: "The enforcement API is unreachable." } },
      { status: 503 },
    );
  }
}

export async function DELETE() {
  const token = await readAccessToken();
  if (token) {
    // Best effort; logout is stateless server-side either way.
    await backendFetch("/auth/logout", { method: "POST", token }).catch(() => undefined);
  }
  return clearSessionCookies(NextResponse.json({ success: true, data: { signedOut: true } }));
}
