/**
 * Shared, client-safe API contract.
 *
 * IMPORTANT: this module must stay free of `next/headers` so it can be imported
 * from client components. Server-only helpers live in `@/lib/server-api`.
 */

/** Backend origin used by server-side code (BFF route handlers). */
export const BACKEND_URL = (
  process.env.BACKEND_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:8000"
).replace(/\/+$/, "");

/**
 * Same-origin prefix of the BFF proxy. Client components always call this,
 * never the Fastify origin directly.
 */
export const API_PROXY_PREFIX = "/api/backend";

export const SESSION_ENDPOINT = "/api/session";

export const ACCESS_TOKEN_COOKIE = "lm_access_token";
export const REFRESH_TOKEN_COOKIE = "lm_refresh_token";
export const SESSION_USER_COOKIE = "lm_session_user";

export type PlatformRole = "INSPECTOR" | "SUPERVISOR" | "ADMIN";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: PlatformRole;
  department?: string;
  permissions: string[];
  provisioned: boolean;
  suspended: boolean;
}

export interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; statusCode?: number; requestId?: string };
}

export interface PagedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  hasNext: boolean;
  hasPrevious: boolean;
}

/** Mirrors the backend role map; used to hide UI the API would reject. */
export const ROLE_PERMISSIONS: Record<PlatformRole, string[]> = {
  INSPECTOR: [
    "SCAN_CREATE",
    "SCAN_VIEW",
    "SCAN_VIEW_OWN",
    "INSPECTION_ANALYZE",
    "REPORT_VIEW",
    "REPORT_GENERATE",
    "RULE_VIEW",
    "VIOLATION_VIEW",
  ],
  SUPERVISOR: [
    "SCAN_CREATE",
    "SCAN_VIEW",
    "INSPECTION_ANALYZE",
    "INSPECTION_REVIEW",
    "INSPECTION_APPROVE",
    "INSPECTION_REJECT",
    "INSPECTION_OVERRIDE",
    "REPORT_VIEW",
    "REPORT_GENERATE",
    "REPORT_EXPORT",
    "RULE_VIEW",
    "AUDIT_VIEW",
    "ANALYTICS_VIEW",
    "VIOLATION_VIEW",
    "VIOLATION_REVIEW",
  ],
  ADMIN: [
    "SCAN_CREATE",
    "SCAN_VIEW",
    "SCAN_VIEW_OWN",
    "SCAN_EDIT",
    "SCAN_DELETE",
    "INSPECTION_ANALYZE",
    "INSPECTION_REVIEW",
    "INSPECTION_APPROVE",
    "INSPECTION_REJECT",
    "INSPECTION_OVERRIDE",
    "REPORT_VIEW",
    "REPORT_GENERATE",
    "REPORT_EXPORT",
    "RULE_VIEW",
    "RULE_CREATE",
    "USER_VIEW",
    "USER_CREATE",
    "USER_UPDATE",
    "USER_SUSPEND",
    "AUDIT_VIEW",
    "ANALYTICS_VIEW",
    "SYSTEM_CONFIGURE",
    "VIOLATION_VIEW",
    "VIOLATION_REVIEW",
  ],
};

export function roleLabel(role: PlatformRole | null | undefined): string {
  switch (role) {
    case "INSPECTOR":
      return "Inspecting Officer";
    case "SUPERVISOR":
      return "Supervising Officer";
    case "ADMIN":
      return "Platform Administrator";
    default:
      return "Unauthenticated";
  }
}

export function hasPermission(
  user: Pick<SessionUser, "role" | "permissions"> | null | undefined,
  permission: string,
): boolean {
  if (!user) return false;
  if (Array.isArray(user.permissions) && user.permissions.includes(permission)) return true;
  return ROLE_PERMISSIONS[user.role]?.includes(permission) ?? false;
}
