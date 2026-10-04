import { FastifyReply, FastifyRequest } from "fastify";
import { supabaseClient } from "../db/supabase.js";
import { DBRepo, type UserRecord } from "../db/repo.js";
import { env, isDevAuthEnabled } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { ForbiddenError, NotFoundError, UnauthenticatedError } from "../lib/errors.js";
import { TtlCache } from "../lib/cache.js";

export type UserRole = "INSPECTOR" | "SUPERVISOR" | "ADMIN";

export type Permission =
  | "SCAN_CREATE"
  | "SCAN_VIEW"
  | "SCAN_VIEW_OWN"
  | "SCAN_EDIT"
  | "SCAN_DELETE"
  | "INSPECTION_ANALYZE"
  | "INSPECTION_REVIEW"
  | "INSPECTION_APPROVE"
  | "INSPECTION_REJECT"
  | "INSPECTION_OVERRIDE"
  | "REPORT_VIEW"
  | "REPORT_GENERATE"
  | "REPORT_EXPORT"
  | "RULE_VIEW"
  | "RULE_CREATE"
  | "USER_VIEW"
  | "USER_CREATE"
  | "USER_UPDATE"
  | "USER_SUSPEND"
  | "AUDIT_VIEW"
  | "ANALYTICS_VIEW"
  | "SYSTEM_CONFIGURE"
  | "VIOLATION_VIEW"
  | "VIOLATION_REVIEW";

export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
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

export const ALL_PERMISSIONS: Permission[] = Array.from(
  new Set(Object.values(ROLE_PERMISSIONS).flat()),
).sort();

export function isUserRole(value: unknown): value is UserRole {
  return value === "INSPECTOR" || value === "SUPERVISOR" || value === "ADMIN";
}

export interface AuthUser {
  /** Database user id when the account is provisioned, else the Supabase auth id. */
  id: string;
  supabaseUserId: string | null;
  email: string;
  role: UserRole;
  name: string;
  department?: string;
  permissions: Permission[];
  /** False when the account has no `users` row and therefore no data scope. */
  provisioned: boolean;
  suspended: boolean;
}

/** Development-only identities for offline demos. Never reachable in production. */
export const DEV_USERS: Record<string, Omit<AuthUser, "permissions" | "supabaseUserId" | "provisioned" | "suspended">> = {
  "inspector.sarthak@lm.gov.in": {
    id: "11111111-1111-1111-1111-111111111111",
    email: "inspector.sarthak@lm.gov.in",
    role: "INSPECTOR",
    name: "Sarthak Verma",
    department: "Legal Metrology Zonal Office",
  },
  "supervisor.anita@lm.gov.in": {
    id: "22222222-2222-2222-2222-222222222222",
    email: "supervisor.anita@lm.gov.in",
    role: "SUPERVISOR",
    name: "Anita Rao",
    department: "Legal Metrology Zonal Office",
  },
  "admin.director@lm.gov.in": {
    id: "33333333-3333-3333-3333-333333333333",
    email: "admin.director@lm.gov.in",
    role: "ADMIN",
    name: "Director General",
    department: "Ministry of Consumer Affairs",
  },
};

/**
 * Short-lived cache of the authoritative role lookup.
 *
 * Role changes must therefore either wait out the TTL (default 30s) or be
 * invalidated explicitly via `invalidateUser`. This is deliberately short-lived
 * and *only* used for non-production Supabase logins; demo identities are static.
 */
const ROLE_CACHE_TTL_MS = 30_000;

const roleCache = new TtlCache<UserRecord | null>(ROLE_CACHE_TTL_MS, 500);

/** Resolves the authoritative platform identity for a verified Supabase account. */
export async function resolveProvisionedUser(
  email: string,
  supabaseUserId?: string | null,
): Promise<AuthUser | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;

  const record = await roleCache.remember(normalized, ROLE_CACHE_TTL_MS, () =>
    DBRepo.getProvisionedUserByEmail(normalized),
  );
  if (!record) return null;

  const authUser = buildAuthUser(record, normalized, supabaseUserId ?? null);
  return authUser.suspended ? null : authUser;
}

/** Drops cached authorization state so role changes take effect immediately. */
export function invalidateUserAuthorization(email?: string): void {
  if (email) roleCache.invalidate(email.trim().toLowerCase());
  else roleCache.invalidate();
}

export function hasPermission(user: AuthUser, permission: Permission): boolean {
  return user.permissions.includes(permission);
}

export function hasAnyPermission(user: AuthUser, ...permissions: Permission[]): boolean {
  return permissions.some((permission) => user.permissions.includes(permission));
}

export function hasAllPermissions(user: AuthUser, ...permissions: Permission[]): boolean {
  return permissions.every((permission) => user.permissions.includes(permission));
}

function extractBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;

  const [scheme, ...rest] = header.split(" ");
  const token = rest.join(" ").trim();
  if (!scheme || scheme.toLowerCase() !== "bearer" || !token) return null;
  return token;
}

/**
 * Resolves a seeded demo identity from a `dev-*` token, an email, or a role name.
 * Callers must have already verified `isDevAuthEnabled`.
 */
export async function resolveDemoUser(roleOrEmail: string): Promise<AuthUser | null> {
  const normalized = roleOrEmail.replace(/^dev-/, "").toLowerCase();
  const matched =
    Object.values(DEV_USERS).find((candidate) => candidate.role.toLowerCase() === normalized) ??
    Object.values(DEV_USERS).find((candidate) => candidate.email.toLowerCase() === roleOrEmail.toLowerCase());

  if (!matched) return null;

  // If Postgres is reachable, the database remains the authority for the role.
  try {
    const dbUser = await DBRepo.getUserByEmail(matched.email);
    if (dbUser) {
      return buildAuthUser(dbUser, matched.email, dbUser.id);
    }
  } catch (error) {
    logger.debug("Dev identity role lookup fell back to static map", {
      email: matched.email,
      error,
    });
  }

  return {
    ...matched,
    supabaseUserId: null,
    permissions: ROLE_PERMISSIONS[matched.role] ?? [],
    provisioned: false,
    suspended: false,
  };
}

function buildAuthUser(record: UserRecord, email: string, supabaseUserId: string | null): AuthUser {
  const role: UserRole = isUserRole(record.role) ? record.role : "INSPECTOR";
  return {
    id: record.id,
    supabaseUserId: supabaseUserId ?? record.supabaseUserId ?? null,
    email: record.email ?? email,
    role,
    name: record.name ?? record.email ?? email,
    department: record.department ?? undefined,
    permissions: ROLE_PERMISSIONS[role] ?? [],
    provisioned: true,
    suspended: record.status === "SUSPENDED",
  };
}

/**
 * Authentication pre-handler.
 *
 * Token resolution order:
 *   1. Supabase access token -> authoritative role from the `users` table.
 *   2. `dev-*` demo token -> ONLY when ALLOW_DEV_AUTH is on and NODE_ENV is not
 *      production. Any attempt in production is rejected with 401.
 *
 * `user_metadata.role` is deliberately never trusted for authorization.
 */
export async function authenticate(request: FastifyRequest, _reply: FastifyReply) {
  const token = extractBearerToken(request);

  if (!token) {
    throw new UnauthenticatedError(
      "Authorization header is missing or is not a valid Bearer token.",
      "UNAUTHENTICATED",
    );
  }

  if (token.startsWith("dev-")) {
    if (!isDevAuthEnabled) {
      logger.warn("Rejected demo bearer token", {
        requestId: request.id,
        route: request.routeOptions?.url,
        nodeEnv: env.NODE_ENV,
      });
      throw new UnauthenticatedError(
        "Development demo credentials are disabled on this deployment.",
        "INVALID_TOKEN",
      );
    }

    const devUser = await resolveDemoUser(token);
    if (!devUser) {
      throw new UnauthenticatedError("The supplied bearer token is not recognised.", "INVALID_TOKEN");
    }

    if (devUser.suspended) {
      throw new ForbiddenError("This account has been suspended.", "RESOURCE_FORBIDDEN");
    }

    request.user = devUser;
    return;
  }

  let supabaseUser: { id: string; email?: string } | null = null;

  try {
    const { data, error } = await supabaseClient.auth.getUser(token);
    if (error || !data.user) {
      logger.info("Bearer token rejected by Supabase Auth", { requestId: request.id, reason: error?.message });
      throw new UnauthenticatedError(
        "The access token is invalid or has expired.",
        "INVALID_TOKEN",
      );
    }
    supabaseUser = data.user;
  } catch (error) {
    if (error instanceof UnauthenticatedError) throw error;
    throw new UnauthenticatedError("The access token could not be verified.", "INVALID_TOKEN");
  }

  const email = (supabaseUser.email ?? "").toLowerCase();

  if (!email) {
    throw new UnauthenticatedError("The authenticated account has no email address.", "INVALID_TOKEN");
  }

  const dbUser = await roleCache.remember(email, ROLE_CACHE_TTL_MS, () =>
    DBRepo.getProvisionedUserByEmail(email),
  );

  if (!dbUser) {
    // No `users` row means no assigned role, no data scope and no permissions.
    // We deliberately do NOT fall back to client-controlled user_metadata.
    logger.warn("Authenticated account has no provisioned platform user record", {
      requestId: request.id,
      userId: supabaseUser.id,
    });
    throw new ForbiddenError(
      "This account is authenticated but has not been provisioned on the Legal Metrology platform. Contact an administrator.",
      "RESOURCE_FORBIDDEN",
    );
  }

  const authUser = buildAuthUser(dbUser, email, supabaseUser.id);

  if (authUser.suspended) {
    throw new ForbiddenError("This account has been suspended.", "RESOURCE_FORBIDDEN");
  }

  // Fire-and-forget: best-effort last-login bookkeeping, never blocks the request.
  void DBRepo.touchUserLastLogin(dbUser.id).catch((error) => {
    logger.debug("Failed to record last login", { userId: dbUser.id, error });
  });

  request.user = authUser;
}

/** Role guard. Retained for existing call sites; prefer `requirePermission`. */
export function requireRole(allowedRoles: UserRole[]) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    const user = requireAuthenticatedUser(request);
    if (!allowedRoles.includes(user.role)) {
      throw new ForbiddenError(
        `This action requires one of the following roles: ${allowedRoles.join(", ")}.`,
        "INSUFFICIENT_PERMISSIONS",
      );
    }
  };
}

/** Primary authorization guard: `requirePermission("INSPECTION_APPROVE")`. */
export function requirePermission(requiredPermission: Permission) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    const user = requireAuthenticatedUser(request);
    if (!hasPermission(user, requiredPermission)) {
      throw new ForbiddenError(
        `Missing required permission: ${requiredPermission}.`,
        "INSUFFICIENT_PERMISSIONS",
      );
    }
  };
}

export function requireAnyPermission(...permissions: Permission[]) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    const user = requireAuthenticatedUser(request);
    if (!hasAnyPermission(user, ...permissions)) {
      throw new ForbiddenError(
        `Missing one of the required permissions: ${permissions.join(", ")}.`,
        "INSUFFICIENT_PERMISSIONS",
      );
    }
  };
}

export function requireAllPermissions(...permissions: Permission[]) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    const user = requireAuthenticatedUser(request);
    if (!hasAllPermissions(user, ...permissions)) {
      throw new ForbiddenError(
        `Missing required permissions: ${permissions.join(", ")}.`,
        "INSUFFICIENT_PERMISSIONS",
      );
    }
  };
}

export function requireAuthenticatedUser(request: FastifyRequest): AuthUser {
  if (!request.user) {
    throw new UnauthenticatedError("Authentication is required before authorization can be evaluated.");
  }
  return request.user;
}

// ---------------------------------------------------------------------------
// Resource-level authorization
// ---------------------------------------------------------------------------

export interface OwnedResource {
  id: string;
  inspectorId?: string | null;
  /** Optional department scoping for supervisors. */
  department?: string | null;
}

/**
 * Decides whether a user may read/modify a scan-level resource.
 *
 * INSPECTOR : own records only.
 * SUPERVISOR : every record inside their own department; ADMIN : global.
 *
 * A valid JWT alone never grants access to a record.
 */
export function assertScanAccess(user: AuthUser, scan: OwnedResource | null): void {
  if (!scan) {
    throw new NotFoundError("Inspection record");
  }

  if (user.role === "ADMIN") return;

  if (user.role === "INSPECTOR") {
    if (user.provisioned && scan.inspectorId && scan.inspectorId === user.id) return;
    if (!user.provisioned) {
      // Demo identities are not linked to DB rows; they can only see seeded records.
      if (scan.inspectorId === user.id) return;
    }
    throw new ForbiddenError(
      "This inspection belongs to another officer. Inspectors may only access their own inspections.",
      "RESOURCE_FORBIDDEN",
    );
  }

  // SUPERVISOR: department scope when both sides declare one, otherwise global.
  if (scan.department && user.department && scan.department !== user.department) {
    throw new ForbiddenError(
      "This inspection is outside your department's review scope.",
      "RESOURCE_FORBIDDEN",
    );
  }
}

/** Write guard: only ADMIN may mutate a record they do not own. */
export function assertScanWriteAccess(user: AuthUser, scan: OwnedResource | null): void {
  if (!scan) throw new NotFoundError("Inspection record");
  if (user.role === "ADMIN") return;
  assertScanAccess(user, scan);
  if (user.role === "SUPERVISOR") {
    throw new ForbiddenError(
      "Supervisors may review and override decisions but may not rewrite inspection data.",
      "INSUFFICIENT_PERMISSIONS",
    );
  }
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
}
