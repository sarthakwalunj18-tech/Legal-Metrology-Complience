import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/**
 * Route protection.
 *
 * Only the presence of a session cookie is checked here; the API performs the
 * real authorization on every request, so this is a UX redirect rather than a
 * security boundary.
 */
const SESSION_COOKIE = "lm_access_token";

export async function middleware(request: Request) {
  const { pathname } = new URL(request.url);

  const store = await cookies();
  const hasSession = Boolean(store.get(SESSION_COOKIE)?.value);
  const isLogin = pathname === "/login";

  if (!hasSession && !isLogin) {
    const target = new URL("/login", request.url);
    if (pathname !== "/") target.searchParams.set("next", pathname);
    return NextResponse.redirect(target);
  }

  if (hasSession && isLogin) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
