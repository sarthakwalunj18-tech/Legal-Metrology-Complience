import { db, checkPostgresConnection } from "./index.js";
import {
  products,
  scans,
  images,
  extractedFields,
  complianceChecks,
  violations,
  reports,
  auditLogs,
  users,
  notifications,
} from "./schema.js";
import { and, asc, count, desc, eq, ilike, inArray, or, sql as drizzleSql, type SQL } from "drizzle-orm";
import { officialLegalMetrologyRules } from "./seed.js";
import { logger } from "../lib/logger.js";
import crypto from "crypto";

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

let liveDbState: boolean | null = null;
let liveDbProbe: Promise<boolean> | null = null;

/**
 * Resolves whether Postgres is usable, probing at most once per process.
 *
 * The platform deliberately degrades to an in-memory store so the demo works in
 * an offline sandbox; production deployments should fail loudly instead, which
 * is why the failure is always logged as a warning.
 */
async function isDatabaseLive(): Promise<boolean> {
  if (liveDbState !== null) return liveDbState;
  if (liveDbProbe) return liveDbProbe;

  liveDbProbe = (async () => {
    const status = await checkPostgresConnection();
    liveDbState = status.connected;
    if (!status.connected) {
      logger.warn(
        "Postgres is unreachable - operating on the in-memory fallback store. Data will not persist across restarts.",
        { reason: status.error },
      );
    } else {
      logger.info("Postgres connection established", { latencyMs: status.latencyMs });
    }
    return liveDbState;
  })();

  return liveDbProbe;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UserRecord {
  id: string;
  email: string;
  supabaseUserId?: string | null;
  name: string;
  role: string;
  department?: string | null;
  status?: string | null;
  lastLoginAt?: Date | null;
  suspendedAt?: Date | null;
  suspendedBy?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface PageParams {
  page?: number;
  pageSize?: number;
}

export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  hasNext: boolean;
  hasPrevious: boolean;
}

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export function normalisePaging(params: PageParams = {}): { page: number; pageSize: number; offset: number } {
  const page = Math.max(1, Math.trunc(params.page ?? 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(params.pageSize ?? DEFAULT_PAGE_SIZE)));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function buildPage<T>(items: T[], total: number, page: number, pageSize: number): PageResult<T> {
  const pageCount = pageSize > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1;
  return {
    items,
    total,
    page,
    pageSize,
    pageCount,
    hasNext: page < pageCount,
    hasPrevious: page > 1,
  };
}

/** Shape used by the in-memory store, where rows have no Drizzle typing. */
interface MemoryRow {
  id: string;
  createdAt: Date;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// In-memory fallback store
// ---------------------------------------------------------------------------

const memoryStore: Record<string, Map<string, MemoryRow>> = {
  products: new Map(),
  scans: new Map(),
  images: new Map(),
  extractedFields: new Map(),
  complianceChecks: new Map(),
  violations: new Map(),
  reports: new Map(),
  auditLogs: new Map(),
  rules: new Map(),
  users: new Map(),
  notifications: new Map(),
};

for (const rule of officialLegalMetrologyRules) {
  memoryStore.rules.set(rule.id, { ...rule, createdAt: new Date() } as unknown as MemoryRow);
}

/**
 * Baseline accounts for offline / first-run demos.
 *
 * These mirror the `dev-*` demo identities in the auth middleware so a
 * provisioned role always exists to attach inspections to.
 */
const baselineUsers: UserRecord[] = [
  {
    id: "11111111-1111-1111-1111-111111111111",
    email: "inspector.sarthak@lm.gov.in",
    name: "Sarthak Verma",
    role: "INSPECTOR",
    department: "Legal Metrology Zonal Office",
    status: "ACTIVE",
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: "22222222-2222-2222-2222-222222222222",
    email: "supervisor.anita@lm.gov.in",
    name: "Anita Rao",
    role: "SUPERVISOR",
    department: "Legal Metrology Zonal Office",
    status: "ACTIVE",
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: "33333333-3333-3333-3333-333333333333",
    email: "admin.director@lm.gov.in",
    name: "Director General",
    role: "ADMIN",
    department: "Ministry of Consumer Affairs",
    status: "ACTIVE",
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

for (const user of baselineUsers) {
  memoryStore.users.set(user.id, user as unknown as MemoryRow);
}

function memoryInsert(collection: keyof typeof memoryStore, data: Record<string, unknown>): MemoryRow {
  const id = (data.id as string) ?? crypto.randomUUID();
  const record = { ...data, id, createdAt: (data.createdAt as Date) ?? new Date() } as MemoryRow;
  memoryStore[collection].set(id, record);
  return record;
}

/** Filters, sorts and slices an already-materialised in-memory row set. */
function paginateMemory(
  rows: MemoryRow[],
  predicate: (row: MemoryRow) => boolean,
  paging: { page: number; pageSize: number; offset: number },
): PageResult<MemoryRow> {
  const matched = rows.filter(predicate);
  matched.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return buildPage(
    matched.slice(paging.offset, paging.offset + paging.pageSize),
    matched.length,
    paging.page,
    paging.pageSize,
  );
}

/** Applies a predicate + slice to the in-memory collection. */
function memoryQuery(
  collection: keyof typeof memoryStore,
  predicate: (row: MemoryRow) => boolean,
  page?: { page: number; pageSize: number; offset: number },
): PageResult<MemoryRow> {
  if (!page) {
    return paginateMemory(Array.from(memoryStore[collection].values()), predicate, {
      page: 1,
      pageSize: Math.max(1, memoryStore[collection].size),
      offset: 0,
    });
  }
  return paginateMemory(Array.from(memoryStore[collection].values()), predicate, page);
}

const toDate = (value: unknown): Date => {
  if (value instanceof Date) return value;
  const parsed = new Date(value as string);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
};

const textMatch = (value: unknown, needle: string): boolean =>
  typeof value === "string" && value.toLowerCase().includes(needle);

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class DBRepo {
  // ------------------------------------------------------------------ users

  static async getUserByEmail(email: string): Promise<UserRecord | null> {
    if (!email) return null;
    const normalized = email.trim().toLowerCase();

    if (await isDatabaseLive()) {
      const [user] = await db.select().from(users).where(eq(sqlLower(users.email), normalized));
      if (user) return user as UserRecord;
    }

    const found = Array.from(memoryStore.users.values()).find(
      (candidate) => (candidate.email as string)?.toLowerCase() === normalized,
    );
    return (found as unknown as UserRecord) ?? null;
  }

  /**
   * Authorization-grade lookup: the `users` table is the ONLY source of truth.
   *
   * Unlike `getUserByEmail` this never consults the in-memory fallback, so a
   * verified JWT can never inherit a role from a seeded demo record. A missing
   * row means "not provisioned", which callers must treat as a hard failure.
   */
  static async getProvisionedUserByEmail(email: string): Promise<UserRecord | null> {
    if (!email || !(await isDatabaseLive())) return null;
    const normalized = email.trim().toLowerCase();
    const [user] = await db.select().from(users).where(eq(sqlLower(users.email), normalized));
    return (user as UserRecord) ?? null;
  }

  static async getUserById(id: string): Promise<UserRecord | null> {
    if (await isDatabaseLive()) {
      const [user] = await db.select().from(users).where(eq(users.id, id));
      if (user) return user as UserRecord;
    }
    const found = memoryStore.users.get(id);
    return (found as unknown as UserRecord) ?? null;
  }

  static async getUserBySupabaseId(supabaseUserId: string): Promise<UserRecord | null> {
    if (!supabaseUserId) return null;
    if (await isDatabaseLive()) {
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.supabaseUserId, supabaseUserId));
      if (user) return user as UserRecord;
    }
    return null;
  }

  /**
   * Creates the platform user for a freshly authenticated Supabase account.
   * Called only by an ADMIN action, never implicitly on first login.
   */
  static async provisionUser(input: {
    email: string;
    name: string;
    role: string;
    department?: string;
    supabaseUserId?: string;
  }): Promise<UserRecord> {
    const payload = {
      email: input.email.trim().toLowerCase(),
      name: input.name,
      role: input.role,
      department: input.department ?? "Legal Metrology Enforcement",
      status: "ACTIVE",
      supabaseUserId: input.supabaseUserId ?? null,
      updatedAt: new Date(),
    };

    if (await isDatabaseLive()) {
      const [created] = await db.insert(users).values(payload).returning();
      if (created) return created as UserRecord;
    }

    return memoryInsert("users", payload) as unknown as UserRecord;
  }

  static async getAllUsers(): Promise<UserRecord[]> {
    if (await isDatabaseLive()) {
      const list = await db.select().from(users).orderBy(asc(users.name));
      if (list.length > 0) return list as UserRecord[];
    }
    return Array.from(memoryStore.users.values())
      .map((row) => row as unknown as UserRecord)
      .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  }

  static async createUser(data: {
    name: string;
    email: string;
    role: string;
    department?: string;
  }): Promise<UserRecord> {
    const payload = {
      name: data.name,
      email: data.email.trim().toLowerCase(),
      role: data.role,
      department: data.department ?? "Legal Metrology Enforcement",
      status: "ACTIVE",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    if (await isDatabaseLive()) {
      const [created] = await db.insert(users).values(payload).returning();
      if (created) return created as UserRecord;
    }

    return memoryInsert("users", payload) as unknown as UserRecord;
  }

  static async updateUser(id: string, data: Record<string, unknown>): Promise<UserRecord | null> {
    const payload = { ...data, updatedAt: new Date() };

    if (await isDatabaseLive()) {
      const [updated] = await db.update(users).set(payload).where(eq(users.id, id)).returning();
      if (updated) return updated as UserRecord;
    }

    const existing = memoryStore.users.get(id);
    if (!existing) return null;
    const merged = { ...existing, ...payload } as unknown as MemoryRow;
    memoryStore.users.set(id, merged);
    return merged as unknown as UserRecord;
  }

  static async setUserStatus(
    id: string,
    status: "ACTIVE" | "SUSPENDED",
    actorId?: string,
  ): Promise<UserRecord | null> {
    return DBRepo.updateUser(id, {
      status,
      suspendedAt: status === "SUSPENDED" ? new Date() : null,
      suspendedBy: status === "SUSPENDED" ? (actorId ?? null) : null,
    });
  }

  static async touchUserLastLogin(id: string): Promise<void> {
    if (await isDatabaseLive()) {
      await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, id));
      return;
    }
    const existing = memoryStore.users.get(id);
    if (existing) memoryStore.users.set(id, { ...existing, lastLoginAt: new Date() });
  }

  /** Soft removal: suspends the account and preserves referential integrity. */
  static async deleteUser(id: string): Promise<boolean> {
    if (await isDatabaseLive()) {
      await db
        .update(users)
        .set({ status: "SUSPENDED", suspendedAt: new Date(), updatedAt: new Date() })
        .where(eq(users.id, id));
      return true;
    }
    return memoryStore.users.delete(id);
  }

  // --------------------------------------------------------------- products

  static async getProduct(id: string) {
    if (await isDatabaseLive()) {
      const [product] = await db.select().from(products).where(eq(products.id, id));
      if (product) return product;
    }
    return (memoryStore.products.get(id) as unknown as Record<string, unknown>) ?? null;
  }

  static async insertProduct(data: {
    name: string;
    brand?: string;
    category: string;
    commodityType?: string;
    manufacturerName?: string;
    manufacturerAddress?: string;
  }) {
    if (await isDatabaseLive()) {
      const [created] = await db.insert(products).values(data).returning();
      if (created) return created;
    }
    return memoryInsert("products", data);
  }

  static async updateProduct(id: string, data: Record<string, unknown>) {
    if (await isDatabaseLive()) {
      await db.update(products).set(data).where(eq(products.id, id));
    }
    const existing = memoryStore.products.get(id);
    if (existing) {
      memoryStore.products.set(id, { ...existing, ...data, updatedAt: new Date() });
    }
  }

  static async getAllProducts() {
    if (await isDatabaseLive()) {
      const list = await db.select().from(products).orderBy(desc(products.createdAt));
      if (list.length > 0) return list;
    }
    return Array.from(memoryStore.products.values()).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
  }

  static async getProductsPage(
    params: PageParams & { search?: string; category?: string } = {},
  ): Promise<PageResult<Record<string, unknown>>> {
    const { page, pageSize, offset } = normalisePaging(params);
    const search = params.search?.trim().toLowerCase();

    if (await isDatabaseLive()) {
      const conditions: SQL[] = [];
      if (search) {
        conditions.push(
          or(
            ilike(products.name, `%${search}%`),
            ilike(products.brand, `%${search}%`),
            ilike(products.category, `%${search}%`),
          )!,
        );
      }
      if (params.category) conditions.push(eq(products.category, params.category));

      const where = conditions.length ? and(...conditions) : undefined;
      const [rows, totals] = await Promise.all([
        db
          .select()
          .from(products)
          .where(where)
          .orderBy(desc(products.createdAt))
          .limit(pageSize)
          .offset(offset),
        db.select({ value: count() }).from(products).where(where),
      ]);

      return buildPage(rows as unknown as Record<string, unknown>[], totals[0]?.value ?? 0, page, pageSize);
    }

    return memoryQuery(
      "products",
      (row) => {
        if (params.category && row.category !== params.category) return false;
        if (!search) return true;
        return (
          textMatch(row.name, search) || textMatch(row.brand, search) || textMatch(row.category, search)
        );
      },
      { page, pageSize, offset },
    );
  }

  // ------------------------------------------------------------------ scans

  static async insertScan(data: {
    productId?: string;
    inspectorId?: string;
    scanNumber: string;
    location?: string;
    status: string;
    complianceStatus?: string;
    complianceScore?: string;
  }) {
    const payload = {
      ...data,
      reviewStatus: "PENDING",
      processingStage: "UPLOADED",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    if (await isDatabaseLive()) {
      const [created] = await db.insert(scans).values(payload).returning();
      if (created) return created;
    }
    return memoryInsert("scans", payload);
  }

  static async updateScan(
    id: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const payload = { ...data, updatedAt: new Date() };

    if (await isDatabaseLive()) {
      const [updated] = await db.update(scans).set(payload).where(eq(scans.id, id)).returning();
      if (updated) return updated;
    }

    const existing = memoryStore.scans.get(id);
    if (existing) {
      const merged = { ...existing, ...payload };
      memoryStore.scans.set(id, merged);
      return merged;
    }
    return null;
  }

  static async getScan(id: string) {
    if (await isDatabaseLive()) {
      const [scan] = await db.select().from(scans).where(eq(scans.id, id));
      if (scan) return scan;
    }
    return memoryStore.scans.get(id) ?? null;
  }

  static async getAllScans() {
    if (await isDatabaseLive()) {
      const all = await db.select().from(scans).orderBy(desc(scans.createdAt));
      if (all.length > 0) return all;
    }
    return Array.from(memoryStore.scans.values()).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
  }

  /**
   * Paginated inspection list with the filters the registry UI actually needs.
   * `scopeInspectorId` restricts an inspector to their own records.
   */
  static async getScansPage(
    params: PageParams & {
      search?: string;
      complianceStatus?: string;
      reviewStatus?: string;
      status?: string;
      severity?: string;
      productId?: string;
      inspectorId?: string;
      /** Department-wide scope: matches any of these officer ids. */
      inspectorIds?: string[];
      location?: string;
      fromDate?: string;
      toDate?: string;
      sort?: "newest" | "oldest" | "score_asc" | "score_desc";
    } = {},
  ): Promise<PageResult<Record<string, unknown>>> {
    const { page, pageSize, offset } = normalisePaging(params);
    const search = params.search?.trim().toLowerCase();

    const order =
      params.sort === "oldest"
        ? asc(scans.createdAt)
        : params.sort === "score_asc"
          ? asc(scans.complianceScore)
          : params.sort === "score_desc"
            ? desc(scans.complianceScore)
            : desc(scans.createdAt);

    if (await isDatabaseLive()) {
      const conditions: SQL[] = [];

      if (search) {
        conditions.push(
          or(
            ilike(scans.scanNumber, `%${search}%`),
            ilike(scans.location, `%${search}%`),
            ilike(drizzleSql`${scans.scanNumber}`, `%${search}%`),
          )!,
        );
      }
      if (params.complianceStatus) conditions.push(eq(scans.complianceStatus, params.complianceStatus));
      if (params.reviewStatus) conditions.push(eq(scans.reviewStatus, params.reviewStatus));
      if (params.status) conditions.push(eq(scans.status, params.status));
      if (params.productId) conditions.push(eq(scans.productId, params.productId));
      if (params.inspectorId) conditions.push(eq(scans.inspectorId, params.inspectorId));
      if (params.inspectorIds && params.inspectorIds.length > 0) {
        conditions.push(inArray(scans.inspectorId, params.inspectorIds));
      }
      if (params.location) conditions.push(ilike(scans.location, `%${params.location}%`));
      if (params.fromDate) conditions.push(drizzleSql`${scans.createdAt} >= ${params.fromDate}`);
      if (params.toDate) conditions.push(drizzleSql`${scans.createdAt} <= ${params.toDate}`);

      const where = conditions.length ? and(...conditions) : undefined;

      const [rows, totals] = await Promise.all([
        db.select().from(scans).where(where).orderBy(order).limit(pageSize).offset(offset),
        db.select({ value: count() }).from(scans).where(where),
      ]);

      return buildPage(rows as unknown as Record<string, unknown>[], totals[0]?.value ?? 0, page, pageSize);
    }

    return memoryQuery(
      "scans",
      (row) => {
        if (params.complianceStatus && row.complianceStatus !== params.complianceStatus) return false;
        if (params.reviewStatus && row.reviewStatus !== params.reviewStatus) return false;
        if (params.status && row.status !== params.status) return false;
        if (params.productId && row.productId !== params.productId) return false;
        if (params.inspectorId && row.inspectorId !== params.inspectorId) return false;
        if (params.inspectorIds && params.inspectorIds.length > 0) {
          if (!row.inspectorId || !params.inspectorIds.includes(String(row.inspectorId))) return false;
        }
        if (params.location && !textMatch(row.location, params.location.toLowerCase())) return false;
        if (params.fromDate && toDate(row.createdAt) < new Date(params.fromDate)) return false;
        if (params.toDate && toDate(row.createdAt) > new Date(`${params.toDate}T23:59:59.999Z`)) return false;
        if (search) {
          return (
            textMatch(row.scanNumber, search) ||
            textMatch(row.location, search) ||
            textMatch(row.complianceStatus, search)
          );
        }
        return true;
      },
      { page, pageSize, offset },
    );
  }

  static async getProductScans(productId: string) {
    if (await isDatabaseLive()) {
      const list = await db
        .select()
        .from(scans)
        .where(eq(scans.productId, productId))
        .orderBy(desc(scans.createdAt));
      if (list.length > 0) return list;
    }
    return Array.from(memoryStore.scans.values())
      .filter((scan) => scan.productId === productId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /** Distinct inspection locations, used by the registry filter and coverage view. */
  static async getDistinctLocations(): Promise<Array<{ location: string; count: number }>> {
    const all = await DBRepo.getAllScans();
    const counts = new Map<string, number>();
    for (const scan of all) {
      const location = typeof scan.location === "string" ? scan.location.trim() : "";
      if (!location) continue;
      counts.set(location, (counts.get(location) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([location, count]) => ({ location, count }))
      .sort((a, b) => b.count - a.count);
  }

  static async getNextScanNumber(): Promise<string> {
    const year = new Date().getFullYear();
    const prefix = `INS-${year}-`;

    if (await isDatabaseLive()) {
      const [row] = await db
        .select({ value: count() })
        .from(scans)
        .where(ilike(scans.scanNumber, `${prefix}%`));
      const next = (row?.value ?? 0) + 1;
      // Re-check for a collision so concurrent uploads never share a number.
      const [collision] = await db
        .select({ id: scans.id })
        .from(scans)
        .where(eq(scans.scanNumber, `${prefix}${String(next).padStart(6, "0")}`))
        .limit(1);
      if (!collision) return `${prefix}${String(next).padStart(6, "0")}`;
    }

    const existing = (await DBRepo.getAllScans()).filter((scan) =>
      String(scan.scanNumber ?? "").startsWith(prefix),
    ).length;

    return `${prefix}${String(existing + 1).padStart(6, "0")}`;
  }

  // ----------------------------------------------------------------- images

  static async insertImage(data: Record<string, unknown>) {
    if (await isDatabaseLive()) {
      const [created] = await db
        .insert(images)
        .values(data as typeof images.$inferInsert)
        .returning();
      if (created) return created;
    }
    return memoryInsert("images", data);
  }

  static async getScanImages(scanId: string) {
    if (await isDatabaseLive()) {
      const list = await db.select().from(images).where(eq(images.scanId, scanId));
      if (list.length > 0) return list;
    }
    return Array.from(memoryStore.images.values()).filter((image) => image.scanId === scanId);
  }

  static async getImageById(scanId: string, imageId: string) {
    if (await isDatabaseLive()) {
      const [image] = await db
        .select()
        .from(images)
        .where(and(eq(images.id, imageId), eq(images.scanId, scanId)));
      if (image) return image;
      return null;
    }
    const image = memoryStore.images.get(imageId);
    return image && image.scanId === scanId ? image : null;
  }

  static async deleteScanImages(scanId: string): Promise<void> {
    const stored = await DBRepo.getScanImages(scanId);
    for (const image of stored) {
      await DBRepo.deleteImageRecord(String(image.id));
    }
  }

  static async deleteImageRecord(imageId: string): Promise<void> {
    if (await isDatabaseLive()) {
      await db.delete(images).where(eq(images.id, imageId));
      return;
    }
    memoryStore.images.delete(imageId);
  }

  // -------------------------------------------------------- extracted fields

  static async insertExtractedField(data: Record<string, unknown>) {
    const payload = { ...data, createdAt: new Date() };
    if (await isDatabaseLive()) {
      const id = (data.id as string) ?? crypto.randomUUID();
      await db.insert(extractedFields).values({ id, ...payload } as typeof extractedFields.$inferInsert);
      memoryStore.extractedFields.set(id, { id, ...payload } as MemoryRow);
      return { id, ...payload };
    }
    return memoryInsert("extractedFields", payload);
  }

  static async getScanExtractedFields(scanId: string) {
    if (await isDatabaseLive()) {
      const list = await db.select().from(extractedFields).where(eq(extractedFields.scanId, scanId));
      if (list.length > 0) return list;
    }
    return Array.from(memoryStore.extractedFields.values()).filter(
      (field) => field.scanId === scanId,
    );
  }

  // ------------------------------------------------------ compliance checks

  static async insertComplianceCheck(data: Record<string, unknown>) {
    const payload = { ...data, createdAt: new Date() };
    if (await isDatabaseLive()) {
      const id = (data.id as string) ?? crypto.randomUUID();
      const [created] = await db
        .insert(complianceChecks)
        .values({ id, ...payload } as typeof complianceChecks.$inferInsert)
        .returning();
      memoryStore.complianceChecks.set(id, { id, ...payload } as MemoryRow);
      return created ?? { id, ...payload };
    }
    return memoryInsert("complianceChecks", payload);
  }

  static async getScanComplianceChecks(scanId: string) {
    if (await isDatabaseLive()) {
      const list = await db
        .select()
        .from(complianceChecks)
        .where(eq(complianceChecks.scanId, scanId));
      if (list.length > 0) return list;
    }
    return Array.from(memoryStore.complianceChecks.values()).filter(
      (check) => check.scanId === scanId,
    );
  }

  // ------------------------------------------------------------- violations

  static async insertViolation(data: Record<string, unknown>) {
    const payload = { ...data, createdAt: new Date() };
    if (await isDatabaseLive()) {
      const id = (data.id as string) ?? crypto.randomUUID();
      await db.insert(violations).values({ id, ...payload } as typeof violations.$inferInsert);
      memoryStore.violations.set(id, { id, ...payload } as MemoryRow);
      return { id, ...payload };
    }
    return memoryInsert("violations", payload);
  }

  static async getScanViolations(scanId: string) {
    if (await isDatabaseLive()) {
      const list = await db.select().from(violations).where(eq(violations.scanId, scanId));
      if (list.length > 0) return list;
    }
    return Array.from(memoryStore.violations.values()).filter(
      (violation) => violation.scanId === scanId,
    );
  }

  static async getAllViolations() {
    if (await isDatabaseLive()) {
      const list = await db.select().from(violations).orderBy(desc(violations.createdAt));
      if (list.length > 0) return list;
    }
    return Array.from(memoryStore.violations.values()).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
  }

  static async getViolationById(id: string) {
    if (await isDatabaseLive()) {
      const [violation] = await db.select().from(violations).where(eq(violations.id, id));
      if (violation) return violation;
      return null;
    }
    return memoryStore.violations.get(id) ?? null;
  }

  static async updateViolation(
    id: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    if (await isDatabaseLive()) {
      const [updated] = await db.update(violations).set(data).where(eq(violations.id, id)).returning();
      if (updated) return updated;
    }
    const existing = memoryStore.violations.get(id);
    if (existing) {
      const merged = { ...existing, ...data };
      memoryStore.violations.set(id, merged);
      return merged;
    }
    return null;
  }

  /**
   * Paginated + filtered violation feed.
   * Joins the parent inspection so the UI can show product / inspector / location
   * without an N+1 follow-up request per row.
   */
  static async getViolationsPage(
    params: PageParams & {
      search?: string;
      severity?: string;
      violationType?: string;
      ruleId?: string;
      category?: string;
      reviewStatus?: string;
      complianceStatus?: string;
      inspectorId?: string;
      location?: string;
      scanId?: string;
      fromDate?: string;
      toDate?: string;
    } = {},
  ): Promise<PageResult<Record<string, unknown>>> {
    const { page, pageSize, offset } = normalisePaging(params);
    const search = params.search?.trim().toLowerCase();

    if (await isDatabaseLive()) {
      const conditions: SQL[] = [];
      if (params.severity) conditions.push(eq(violations.severity, params.severity));
      if (params.ruleId) conditions.push(ilike(violations.ruleId, `%${params.ruleId}%`));
      if (params.violationType) conditions.push(ilike(violations.violationType, `%${params.violationType}%`));
      if (params.reviewStatus) conditions.push(eq(violations.reviewStatus, params.reviewStatus));
      if (params.scanId) conditions.push(eq(violations.scanId, params.scanId));
      if (params.fromDate) conditions.push(drizzleSql`${violations.createdAt} >= ${params.fromDate}`);
      if (params.toDate) conditions.push(drizzleSql`${violations.createdAt} <= ${params.toDate}`);
      if (search) {
        conditions.push(
          or(
            ilike(violations.title, `%${search}%`),
            ilike(violations.description, `%${search}%`),
            ilike(violations.extractedEvidence, `%${search}%`),
          )!,
        );
      }

      let where = conditions.length ? and(...conditions) : undefined;

      if (params.inspectorId || params.location || params.complianceStatus || params.category) {
        const scanConditions: SQL[] = [];
        if (params.inspectorId) scanConditions.push(eq(scans.inspectorId, params.inspectorId));
        if (params.location) scanConditions.push(ilike(scans.location, `%${params.location}%`));
        if (params.complianceStatus) {
          scanConditions.push(eq(scans.complianceStatus, params.complianceStatus));
        }
        if (params.category) scanConditions.push(eq(products.category, params.category));

        const scanFilter = and(...scanConditions);
        where = where ? and(where, inArray(violations.scanId, db.select({ id: scans.id }).from(scans).where(scanFilter))) : where;
      }

      const [rows, totals] = await Promise.all([
        db
          .select({
            violation: violations,
            scanNumber: scans.scanNumber,
            scanComplianceStatus: scans.complianceStatus,
            scanLocation: scans.location,
            scanInspectorId: scans.inspectorId,
            scanCreatedAt: scans.createdAt,
            productName: products.name,
            productCategory: products.category,
            productBrand: products.brand,
          })
          .from(violations)
          .leftJoin(scans, eq(violations.scanId, scans.id))
          .leftJoin(products, eq(scans.productId, products.id))
          .where(where)
          .orderBy(desc(violations.createdAt))
          .limit(pageSize)
          .offset(offset),
        db.select({ value: count() }).from(violations).where(where),
      ]);

      return buildPage(
        rows.map((row) => ({
          ...(row.violation as unknown as Record<string, unknown>),
          scanNumber: row.scanNumber,
          scanComplianceStatus: row.scanComplianceStatus,
          location: row.scanLocation,
          inspectorId: row.scanInspectorId,
          inspectedAt: row.scanCreatedAt,
          productName: row.productName,
          productCategory: row.productCategory,
          productBrand: row.productBrand,
        })),
        totals[0]?.value ?? 0,
        page,
        pageSize,
      );
    }

    const [allViolations, allScans, allProducts] = await Promise.all([
      DBRepo.getAllViolations(),
      DBRepo.getAllScans(),
      DBRepo.getAllProducts(),
    ]);

    const scanById = new Map(allScans.map((scan) => [String(scan.id), scan]));
    const productById = new Map(allProducts.map((product) => [String(product.id), product]));

    const enriched = allViolations.map((violation) => {
      const scan = scanById.get(String(violation.scanId));
      const product = scan?.productId ? productById.get(String(scan.productId)) : undefined;
      return {
        ...violation,
        createdAt: violation.createdAt ?? new Date(0),
        scanNumber: scan?.scanNumber,
        scanComplianceStatus: scan?.complianceStatus,
        location: scan?.location,
        inspectorId: scan?.inspectorId,
        inspectedAt: scan?.createdAt,
        productName: product?.name,
        productCategory: product?.category,
        productBrand: product?.brand,
      } as MemoryRow;
    });

    return paginateMemory(
      enriched,
      (row) => {
        if (params.severity && row.severity !== params.severity) return false;
        if (params.ruleId && !textMatch(row.ruleId, params.ruleId.toLowerCase())) return false;
        if (params.violationType && !textMatch(row.violationType, params.violationType.toLowerCase())) return false;
        if (params.reviewStatus && row.reviewStatus !== params.reviewStatus) return false;
        if (params.scanId && row.scanId !== params.scanId) return false;
        if (params.inspectorId && row.inspectorId !== params.inspectorId) return false;
        if (params.complianceStatus && row.scanComplianceStatus !== params.complianceStatus) return false;
        if (params.category && row.productCategory !== params.category) return false;
        if (params.location && !textMatch(row.location, params.location.toLowerCase())) return false;
        if (params.fromDate && toDate(row.createdAt) < new Date(params.fromDate)) return false;
        if (params.toDate && toDate(row.createdAt) > new Date(`${params.toDate}T23:59:59.999Z`)) return false;
        if (search) {
          return (
            textMatch(row.title, search) ||
            textMatch(row.description, search) ||
            textMatch(row.extractedEvidence, search) ||
            textMatch(row.ruleId, search)
          );
        }
        return true;
      },
      { page, pageSize, offset },
    );
  }

  // ---------------------------------------------------------------- reports

  static async insertReport(data: Record<string, unknown>) {
    const payload = { ...data, generatedAt: new Date() };
    if (await isDatabaseLive()) {
      const [created] = await db
        .insert(reports)
        .values(payload as typeof reports.$inferInsert)
        .returning();
      if (created) return created;
    }
    return memoryInsert("reports", payload);
  }

  static async getReportById(id: string) {
    if (await isDatabaseLive()) {
      const [report] = await db.select().from(reports).where(eq(reports.id, id));
      return report ?? null;
    }
    return memoryStore.reports.get(id) ?? null;
  }

  static async getScanReports(scanId: string) {
    if (await isDatabaseLive()) {
      const list = await db
        .select()
        .from(reports)
        .where(eq(reports.scanId, scanId))
        .orderBy(desc(reports.generatedAt));
      if (list.length > 0) return list;
    }
    return Array.from(memoryStore.reports.values())
      .filter((report) => report.scanId === scanId)
      .sort((a, b) => toDate(b.generatedAt).getTime() - toDate(a.generatedAt).getTime());
  }

  static async getReportsPage(
    params: PageParams & {
      search?: string;
      format?: string;
      /**
       * Restricts results to reports whose parent scan belongs to one of these
       * inspectors. Must be applied by the database so that totals and paging
       * describe the authorised subset, not the whole table.
       */
      inspectorIds?: string[];
    } = {},
  ): Promise<PageResult<Record<string, unknown>>> {
    const { page, pageSize, offset } = normalisePaging(params);
    const search = params.search?.trim().toLowerCase();
    const inspectorIds = params.inspectorIds?.filter((id) => typeof id === "string" && id.length > 0);

    if (await isDatabaseLive()) {
      const conditions: SQL[] = [];
      if (params.format) conditions.push(eq(reports.format, params.format));
      if (inspectorIds && inspectorIds.length > 0) {
        conditions.push(inArray(scans.inspectorId, inspectorIds));
      } else if (inspectorIds && inspectorIds.length === 0) {
        // An explicitly empty scope must return nothing rather than everything.
        return buildPage([], 0, page, pageSize);
      }
      if (search) {
        conditions.push(
          or(
            ilike(reports.reportNumber, `%${search}%`),
            ilike(scans.scanNumber, `%${search}%`),
            ilike(products.name, `%${search}%`),
          )!,
        );
      }
      const where = conditions.length ? and(...conditions) : undefined;

      const [rows, totals] = await Promise.all([
        db
          .select({
            report: reports,
            scanNumber: scans.scanNumber,
            complianceStatus: scans.complianceStatus,
            location: scans.location,
            productName: products.name,
          })
          .from(reports)
          .leftJoin(scans, eq(reports.scanId, scans.id))
          .leftJoin(products, eq(scans.productId, products.id))
          .where(where)
          .orderBy(desc(reports.generatedAt))
          .limit(pageSize)
          .offset(offset),
        db.select({ value: count() }).from(reports).where(where),
      ]);

      return buildPage(
        rows.map((row) => ({
          ...(row.report as unknown as Record<string, unknown>),
          scanNumber: row.scanNumber,
          complianceStatus: row.complianceStatus,
          location: row.location,
          productName: row.productName,
        })),
        totals[0]?.value ?? 0,
        page,
        pageSize,
      );
    }

    const [allReports, allScans, allProducts] = await Promise.all([
      Promise.resolve(Array.from(memoryStore.reports.values())),
      DBRepo.getAllScans(),
      DBRepo.getAllProducts(),
    ]);
    const scanById = new Map(allScans.map((scan) => [String(scan.id), scan]));
    const productById = new Map(allProducts.map((product) => [String(product.id), product]));

    const enriched = allReports.map((report) => {
      const scan = scanById.get(String(report.scanId));
      const product = scan?.productId ? productById.get(String(scan.productId)) : undefined;
      return {
        ...report,
        // Reports are ordered by generation time, not creation time.
        createdAt: toDate(report.generatedAt ?? report.createdAt),
        inspectorId: scan?.inspectorId,
        scanNumber: scan?.scanNumber,
        complianceStatus: scan?.complianceStatus,
        location: scan?.location,
        productName: product?.name,
      } as MemoryRow;
    });

    const inspectorScope =
      inspectorIds === undefined
        ? null
        : new Set(inspectorIds.map((id) => String(id)));

    return paginateMemory(
      enriched,
      (row) => {
        if (params.format && row.format !== params.format) return false;
        if (inspectorScope && !inspectorScope.has(String(row.inspectorId))) return false;
        if (search) {
          return (
            textMatch(row.reportNumber, search) ||
            textMatch(row.scanNumber, search) ||
            textMatch(row.productName, search)
          );
        }
        return true;
      },
      { page, pageSize, offset },
    );
  }

  // ------------------------------------------------------------ audit trail

  static async insertAuditLog(data: Record<string, unknown>) {
    const payload = { ...data, timestamp: new Date() };
    if (await isDatabaseLive()) {
      const id = (data.id as string) ?? crypto.randomUUID();
      try {
        await db.insert(auditLogs).values({ id, ...payload } as typeof auditLogs.$inferInsert);
      } catch (error) {
        logger.error("Failed to persist audit log", { action: data.action, resourceId: data.resourceId, error });
      }
      memoryStore.auditLogs.set(id, { ...payload, id } as unknown as MemoryRow);
      return { id, ...payload };
    }
    return memoryInsert("auditLogs", payload);
  }

  static async getAllAuditLogs() {
    if (await isDatabaseLive()) {
      const list = await db.select().from(auditLogs).orderBy(desc(auditLogs.timestamp));
      if (list.length > 0) return list;
    }
    return Array.from(memoryStore.auditLogs.values()).sort(
      (a, b) => toDate(b.timestamp).getTime() - toDate(a.timestamp).getTime(),
    );
  }

  // -------------------------------------------------------------------------
  // Notifications
  // -------------------------------------------------------------------------

  /**
   * Files an in-app notification for one officer.
   *
   * Notification failures must never break the workflow that triggered them, so a
   * missing table or a write error degrades to the in-memory store instead of
   * propagating. An officer missing an inbox hint is a smaller problem than an
   * inspection that cannot be signed off.
   */
  static async insertNotification(data: {
    userId: string;
    type: string;
    title: string;
    body?: string | null;
    resourceType?: string | null;
    resourceId?: string | null;
    href?: string | null;
  }) {
    const payload = { ...data, createdAt: new Date(), readAt: null };

    if (await isDatabaseLive()) {
      const id = crypto.randomUUID();
      try {
        await db.insert(notifications).values({ id, ...payload } as typeof notifications.$inferInsert);
        return { id, ...payload };
      } catch (error) {
        logger.warn("Failed to persist notification; keeping it in memory", {
          type: data.type,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      memoryStore.notifications.set(id, { ...payload, id } as unknown as MemoryRow);
      return { id, ...payload };
    }

    return memoryInsert("notifications", payload);
  }

  /**
   * An officer's inbox, newest first.
   *
   * Scoped by `userId` in the query itself rather than filtered afterwards: a
   * notification inbox is personal, so it is never assembled from a shared list.
   */
  static async getNotifications(userId: string, limit = 20) {
    const capped = Math.min(100, Math.max(1, limit));

    if (await isDatabaseLive()) {
      try {
        const rows = await db
          .select()
          .from(notifications)
          .where(eq(notifications.userId, userId))
          .orderBy(desc(notifications.createdAt))
          .limit(capped);
        if (rows.length > 0) return rows;
      } catch (error) {
        logger.warn("Failed to read notifications from the database; using memory", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return Array.from(memoryStore.notifications.values())
      .filter((row) => String(row.userId) === String(userId))
      .sort((a, b) => toDate(b.createdAt).getTime() - toDate(a.createdAt).getTime())
      .slice(0, capped);
  }

  /** Marks one notification read, but only for the officer it belongs to. */
  static async markNotificationRead(id: string, userId: string) {
    const readAt = new Date();

    if (await isDatabaseLive()) {
      try {
        const updated = await db
          .update(notifications)
          .set({ readAt })
          .where(and(eq(notifications.id, id), eq(notifications.userId, userId)))
          .returning();
        if (updated.length > 0) return updated[0];
      } catch (error) {
        logger.warn("Failed to mark notification read in the database", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const existing = memoryStore.notifications.get(id);
    // Ownership check is not optional: without it any officer could mark (and by
    // extension read the existence of) another officer's notifications.
    if (!existing || String(existing.userId) !== String(userId)) return null;

    const updated = { ...existing, readAt };
    memoryStore.notifications.set(id, updated);
    return updated;
  }

  /** Unread count for the bell badge. */
  static async countUnreadNotifications(userId: string) {
    const rows = await DBRepo.getNotifications(userId, 100);
    return rows.filter((row) => !row.readAt).length;
  }

  static async getAuditLogsPage(
    params: PageParams & {
      search?: string;
      action?: string;
      resourceType?: string;
      resourceId?: string;
      userId?: string;
      fromDate?: string;
      toDate?: string;
    } = {},
  ): Promise<PageResult<Record<string, unknown>>> {
    const { page, pageSize, offset } = normalisePaging(params);
    const search = params.search?.trim().toLowerCase();

    if (await isDatabaseLive()) {
      const conditions: SQL[] = [];
      if (params.action) conditions.push(ilike(auditLogs.action, `%${params.action}%`));
      if (params.resourceType) conditions.push(eq(auditLogs.resourceType, params.resourceType));
      if (params.resourceId) conditions.push(ilike(auditLogs.resourceId, `%${params.resourceId}%`));
      if (params.userId) conditions.push(eq(auditLogs.userId, params.userId));
      if (params.fromDate) conditions.push(drizzleSql`${auditLogs.timestamp} >= ${params.fromDate}`);
      if (params.toDate) conditions.push(drizzleSql`${auditLogs.timestamp} <= ${params.toDate}`);
      if (search) {
        conditions.push(
          or(
            ilike(auditLogs.action, `%${search}%`),
            ilike(auditLogs.userEmail, `%${search}%`),
            ilike(auditLogs.resourceId, `%${search}%`),
          )!,
        );
      }
      const where = conditions.length ? and(...conditions) : undefined;

      const [rows, totals] = await Promise.all([
        db.select().from(auditLogs).where(where).orderBy(desc(auditLogs.timestamp)).limit(pageSize).offset(offset),
        db.select({ value: count() }).from(auditLogs).where(where),
      ]);

      return buildPage(rows as unknown as Record<string, unknown>[], totals[0]?.value ?? 0, page, pageSize);
    }

    // Audit rows are ordered by event time, so normalise that onto `createdAt`
    // for the shared in-memory sorter.
    const rows = Array.from(memoryStore.auditLogs.values()).map(
      (row) => ({ ...row, createdAt: toDate(row.timestamp ?? row.createdAt) }) as MemoryRow,
    );

    return paginateMemory(
      rows,
      (row) => {
        if (params.action && !textMatch(row.action, params.action.toLowerCase())) return false;
        if (params.resourceType && row.resourceType !== params.resourceType) return false;
        if (params.resourceId && !textMatch(row.resourceId, params.resourceId.toLowerCase())) return false;
        if (params.userId && row.userId !== params.userId) return false;
        if (params.fromDate && toDate(row.timestamp) < new Date(params.fromDate)) return false;
        if (params.toDate && toDate(row.timestamp) > new Date(`${params.toDate}T23:59:59.999Z`)) return false;
        if (search) {
          return (
            textMatch(row.action, search) ||
            textMatch(row.userEmail, search) ||
            textMatch(row.resourceId, search)
          );
        }
        return true;
      },
      { page, pageSize, offset },
    );
  }

  /** Distinct audit action names, used to populate the filter dropdown. */
  static async getAuditActions(): Promise<string[]> {
    const logs = await DBRepo.getAllAuditLogs();
    return Array.from(new Set(logs.map((log) => String(log.action)))).sort();
  }

  // -------------------------------------------------------- review workflow

  /**
   * Inspections awaiting a human determination.
   * Includes both never-reviewed records and those the engine flagged for review.
   */
  static async getPendingReviews() {
    const allScans = await DBRepo.getAllScans();
    return allScans.filter(
      (scan) =>
        scan.reviewStatus === "PENDING" ||
        (scan.complianceStatus === "REQUIRES_REVIEW" && scan.reviewStatus === "PENDING"),
    );
  }

  static async getReviewsPage(
    params: PageParams & {
      reviewStatus?: string;
      complianceStatus?: string;
      search?: string;
      inspectorId?: string;
      severity?: string;
    } = {},
  ): Promise<PageResult<Record<string, unknown>>> {
    const { page, pageSize, offset } = normalisePaging(params);
    const search = params.search?.trim().toLowerCase();

    const [scanPage, allViolations, allProducts] = await Promise.all([
      DBRepo.getScansPage({
        page,
        pageSize,
        reviewStatus: params.reviewStatus ?? "PENDING",
        complianceStatus: params.complianceStatus,
        search: params.search,
        inspectorId: params.inspectorId,
      }),
      DBRepo.getAllViolations(),
      DBRepo.getAllProducts(),
    ]);

    const violationCountByScan = new Map<string, number>();
    const severityByScan = new Map<string, string>();
    for (const violation of allViolations) {
      const scanId = String(violation.scanId);
      violationCountByScan.set(scanId, (violationCountByScan.get(scanId) ?? 0) + 1);
      if (!severityByScan.has(scanId)) severityByScan.set(scanId, String(violation.severity));
    }
    const productById = new Map(allProducts.map((product) => [String(product.id), product]));

    let items: Array<Record<string, unknown>> = scanPage.items.map((scan) => {
      const id = String(scan.id);
      const product = scan.productId ? productById.get(String(scan.productId)) : undefined;
      return {
        ...scan,
        productName: product?.name,
        productCategory: product?.category,
        productBrand: product?.brand,
        violationCount: violationCountByScan.get(id) ?? 0,
        topSeverity: severityByScan.get(id) ?? null,
      };
    });

    if (params.severity) {
      items = items.filter((item) => item.topSeverity === params.severity);
    }
    if (search) {
      const needle = search.toLowerCase();
      items = items.filter(
        (item) =>
          textMatch(item.scanNumber, needle) ||
          textMatch(item.productName, needle) ||
          textMatch(item.location, needle),
      );
    }

    const total = scanPage.total;
    return { ...scanPage, items, total, page: scanPage.page, pageSize: scanPage.pageSize };
  }

  // ------------------------------------------------------- dashboard metrics

  /**
   * Aggregated operational dashboard metrics, computed from real rows only.
   * No illustrative fallbacks: an empty database reports zeros.
   */
  static async getDashboardSummary(scope?: {
    /**
     * Restricts every aggregate to inspections owned by these officers.
     * Omit for the organisation-wide view; an empty array means "no records".
     */
    inspectorIds?: string[];
  }): Promise<{
    metrics: {
      totalInspections: number;
      compliant: number;
      nonCompliant: number;
      requiresReview: number;
      pendingReview: number;
      processing: number;
      failed: number;
      totalViolations: number;
      complianceRatePercentage: number;
      averageComplianceScore: number | null;
      averageConfidence: number | null;
      averageProcessingTimeSeconds: number | null;
    };
    severityBreakdown: Array<{ severity: string; count: number; percentage: number }>;
    violationTypeBreakdown: Array<{ name: string; count: number; percentage: number }>;
    statusBreakdown: Array<{ name: string; count: number; percentage: number }>;
    reviewStatusBreakdown: Array<{ name: string; count: number; percentage: number }>;
    confidenceDistribution: Array<{ bucket: string; count: number }>;
    complianceTrend: Array<{ period: string; label: string; total: number; compliant: number; nonCompliant: number; requiresReview: number }>;
    topCategories: Array<{ name: string; total: number; compliant: number; rate: number }>;
    recentInspections: Array<Record<string, unknown>>;
    topLocations: Array<{ location: string; total: number; violations: number }>;
  }> {
    const [allScans, allViolations, allProducts] = await Promise.all([
      DBRepo.getAllScans(),
      DBRepo.getAllViolations(),
      DBRepo.getAllProducts(),
    ]);

    // Apply the caller's data scope before any aggregate is derived, so totals,
    // trends and breakdowns can never leak another officer's activity.
    const inspectorScope =
      scope?.inspectorIds === undefined
        ? null
        : new Set(scope.inspectorIds.map((id) => String(id)));
    const scopedScans = inspectorScope
      ? allScans.filter((scan) => inspectorScope.has(String(scan.inspectorId)))
      : allScans;
    const scopedScanIds = new Set(scopedScans.map((scan) => String(scan.id)));
    const scopedViolations = inspectorScope
      ? allViolations.filter((violation) => scopedScanIds.has(String(violation.scanId)))
      : allViolations;
    const scopedProducts = inspectorScope
      ? allProducts.filter((product) =>
          scopedScans.some((scan) => String(scan.productId) === String(product.id)),
        )
      : allProducts;
    const productById = new Map(scopedProducts.map((product) => [String(product.id), product]));

    const total = scopedScans.length;
    const compliant = scopedScans.filter((scan) => scan.complianceStatus === "COMPLIANT").length;
    const nonCompliant = scopedScans.filter((scan) => scan.complianceStatus === "NON_COMPLIANT").length;
    const requiresReview = scopedScans.filter((scan) => scan.complianceStatus === "REQUIRES_REVIEW").length;
    const processing = scopedScans.filter((scan) => scan.status === "PROCESSING" || scan.status === "PENDING").length;
    const failed = scopedScans.filter((scan) => scan.status === "FAILED").length;
    const pendingReview = scopedScans.filter((scan) => scan.reviewStatus === "PENDING").length;

    const scores = scopedScans
      .map((scan) => Number(scan.complianceScore))
      .filter((value) => Number.isFinite(value));
    const averageComplianceScore = scores.length
      ? Math.round((scores.reduce((sum, value) => sum + value, 0) / scores.length) * 10) / 10
      : null;

    const confidences = scopedViolations
      .map((violation) => Number(violation.confidence))
      .filter((value) => Number.isFinite(value));
    const averageConfidence = confidences.length
      ? Math.round((confidences.reduce((sum, value) => sum + value, 0) / confidences.length) * 1000) / 1000
      : null;

    const timings = scopedScans
      .map((scan) => Number((scan.processingTimings as { totalMs?: number } | undefined)?.totalMs))
      .filter((value) => Number.isFinite(value) && value > 0);
    const averageProcessingTimeSeconds = timings.length
      ? Math.round((timings.reduce((sum, value) => sum + value, 0) / timings.length / 1000) * 100) / 100
      : null;

    const severityCounts = new Map<string, number>();
    const typeCounts = new Map<string, number>();
    for (const violation of scopedViolations) {
      severityCounts.set(String(violation.severity), (severityCounts.get(String(violation.severity)) ?? 0) + 1);
      const type = String(violation.violationType || violation.title || "Unclassified");
      typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
    }

    const toBreakdown = (
      counts: Map<string, number>,
      totalCount: number,
    ): Array<{ name: string; count: number; percentage: number }> =>
      Array.from(counts.entries())
        .map(([name, count]) => ({
          name,
          count,
          percentage: totalCount ? Math.round((count / totalCount) * 1000) / 10 : 0,
        }))
        .sort((a, b) => b.count - a.count);

    const statusBreakdown = toBreakdown(
      new Map([
        ["COMPLIANT", compliant],
        ["NON_COMPLIANT", nonCompliant],
        ["REQUIRES_REVIEW", requiresReview],
      ].filter(([, count]) => (count as number) > 0) as Array<[string, number]>),
      total,
    );

    const reviewCounts = new Map<string, number>();
    for (const scan of scopedScans) {
      const key = String(scan.reviewStatus || "PENDING");
      reviewCounts.set(key, (reviewCounts.get(key) ?? 0) + 1);
    }

    const confidenceBuckets: Array<{ label: string; min: number; max: number }> = [
      { label: "< 70%", min: 0, max: 0.7 },
      { label: "70-84%", min: 0.7, max: 0.85 },
      { label: "85-94%", min: 0.85, max: 0.95 },
      { label: "95%+", min: 0.95, max: 1.01 },
    ];
    const confidenceDistribution = confidenceBuckets.map((bucket) => ({
      bucket: bucket.label,
      count: confidences.filter((value) => value >= bucket.min && value < bucket.max).length,
    }));

    // 8 most recent ISO weeks, oldest first.
    const complianceTrend = Array.from({ length: 8 }, (_, index) => {
      const weekStart = startOfIsoWeek(new Date(Date.now() - (7 - index) * 7 * 86_400_000));
      const weekEnd = new Date(weekStart.getTime() + 7 * 86_400_000);
      const inWeek = scopedScans.filter((scan) => {
        const created = toDate(scan.createdAt);
        return created >= weekStart && created < weekEnd;
      });
      return {
        period: weekStart.toISOString().slice(0, 10),
        label: weekStart.toLocaleDateString("en-IN", { day: "2-digit", month: "short" }),
        total: inWeek.length,
        compliant: inWeek.filter((scan) => scan.complianceStatus === "COMPLIANT").length,
        nonCompliant: inWeek.filter((scan) => scan.complianceStatus === "NON_COMPLIANT").length,
        requiresReview: inWeek.filter((scan) => scan.complianceStatus === "REQUIRES_REVIEW").length,
      };
    });

    const categoryStats = new Map<string, { total: number; compliant: number }>();
    for (const scan of scopedScans) {
      const product = scan.productId ? productById.get(String(scan.productId)) : undefined;
      const category = String(product?.category || "Uncategorised");
      const entry = categoryStats.get(category) ?? { total: 0, compliant: 0 };
      entry.total += 1;
      if (scan.complianceStatus === "COMPLIANT") entry.compliant += 1;
      categoryStats.set(category, entry);
    }

    const topCategories = Array.from(categoryStats.entries())
      .map(([name, stats]) => ({
        name,
        total: stats.total,
        compliant: stats.compliant,
        rate: stats.total ? Math.round((stats.compliant / stats.total) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 8);

    const violationCountByScan = new Map<string, number>();
    for (const violation of scopedViolations) {
      const key = String(violation.scanId);
      violationCountByScan.set(key, (violationCountByScan.get(key) ?? 0) + 1);
    }

    const recentInspections = scopedScans.slice(0, 8).map((scan) => {
      const product = scan.productId ? productById.get(String(scan.productId)) : undefined;
      return {
        id: scan.id,
        scanNumber: scan.scanNumber,
        productName: product?.name ?? "Unnamed commodity",
        productBrand: product?.brand ?? null,
        productCategory: product?.category ?? null,
        location: scan.location ?? null,
        inspectorId: scan.inspectorId ?? null,
        createdAt: scan.createdAt,
        status: scan.status,
        complianceStatus: scan.complianceStatus,
        aiDecisionStatus: scan.aiDecisionStatus ?? scan.complianceStatus,
        complianceScore: scan.complianceScore,
        reviewStatus: scan.reviewStatus,
        violationCount: violationCountByScan.get(String(scan.id)) ?? 0,
      };
    });

    const locationStats = new Map<string, { total: number; violations: number }>();
    for (const scan of scopedScans) {
      const location = String(scan.location ?? "").trim();
      if (!location) continue;
      const entry = locationStats.get(location) ?? { total: 0, violations: 0 };
      entry.total += 1;
      entry.violations += violationCountByScan.get(String(scan.id)) ?? 0;
      locationStats.set(location, entry);
    }

    return {
      metrics: {
        totalInspections: total,
        compliant,
        nonCompliant,
        requiresReview,
        pendingReview,
        processing,
        failed,
        totalViolations: scopedViolations.length,
        complianceRatePercentage: total ? Math.round((compliant / total) * 1000) / 10 : 0,
        averageComplianceScore,
        averageConfidence,
        averageProcessingTimeSeconds,
      },
      severityBreakdown: toBreakdown(severityCounts, scopedViolations.length).map((entry) => ({
        severity: entry.name,
        count: entry.count,
        percentage: entry.percentage,
      })),
      violationTypeBreakdown: toBreakdown(typeCounts, scopedViolations.length),
      statusBreakdown,
      reviewStatusBreakdown: toBreakdown(reviewCounts, total),
      confidenceDistribution,
      complianceTrend,
      topCategories,
      recentInspections,
      topLocations: Array.from(locationStats.entries())
        .map(([location, stats]) => ({ location, total: stats.total, violations: stats.violations }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 8),
    };
  }

  /**
   * Cross-inspection analytics, including the AI vs human agreement metric that
   * quantifies how much the automated decision was trusted.
   */
  static async getAnalyticsData() {
    const [allScans, allViolations, allProducts, allChecks] = await Promise.all([
      DBRepo.getAllScans(),
      DBRepo.getAllViolations(),
      DBRepo.getAllProducts(),
      Promise.resolve([] as Record<string, unknown>[]),
    ]);
    void allChecks;

    const total = allScans.length;
    const compliant = allScans.filter((scan) => scan.complianceStatus === "COMPLIANT").length;
    const nonCompliant = allScans.filter((scan) => scan.complianceStatus === "NON_COMPLIANT").length;
    const requiresReview = allScans.filter((scan) => scan.complianceStatus === "REQUIRES_REVIEW").length;

    const reviewed = allScans.filter((scan) => scan.reviewStatus && scan.reviewStatus !== "PENDING");
    const accepted = reviewed.filter((scan) => scan.reviewStatus === "ACCEPTED").length;
    const rejected = reviewed.filter((scan) => scan.reviewStatus === "REJECTED").length;
    const overridden = reviewed.filter((scan) => scan.reviewStatus === "OVERRIDDEN").length;
    const reinspection = reviewed.filter((scan) => scan.reviewStatus === "REINSPECTION_REQUIRED").length;

    const agreed = reviewed.filter((scan) => {
      const aiDecision = String(scan.aiDecisionStatus ?? scan.complianceStatus);
      if (scan.reviewStatus === "ACCEPTED") return true;
      if (scan.reviewStatus === "OVERRIDDEN") return aiDecision !== scan.complianceStatus;
      return false;
    }).length;

    const severityCount = {
      CRITICAL: allViolations.filter((violation) => violation.severity === "CRITICAL").length,
      HIGH: allViolations.filter((violation) => violation.severity === "HIGH").length,
      MEDIUM: allViolations.filter((violation) => violation.severity === "MEDIUM").length,
      LOW: allViolations.filter((violation) => violation.severity === "LOW").length,
    };

    const typeCounts = new Map<string, number>();
    for (const violation of allViolations) {
      const type = String(violation.violationType || violation.title || "Unclassified");
      typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
    }

    const productById = new Map(allProducts.map((product) => [String(product.id), product]));
    const categoryMap = new Map<string, { total: number; compliant: number }>();
    for (const scan of allScans) {
      const product = scan.productId ? productById.get(String(scan.productId)) : undefined;
      const category = String(product?.category || "Uncategorised");
      const entry = categoryMap.get(category) ?? { total: 0, compliant: 0 };
      entry.total += 1;
      if (scan.complianceStatus === "COMPLIANT") entry.compliant += 1;
      categoryMap.set(category, entry);
    }

    const confidences = allViolations
      .map((violation) => Number(violation.confidence))
      .filter((value) => Number.isFinite(value));

    const timings = allScans
      .map((scan) => Number((scan.processingTimings as { totalMs?: number } | undefined)?.totalMs))
      .filter((value) => Number.isFinite(value) && value > 0);

    return {
      kpi: {
        totalInspections: total,
        compliant,
        nonCompliant,
        requiresReview,
        complianceRatePercentage: total ? Math.round((compliant / total) * 1000) / 10 : 0,
        violationRatePercentage: total ? Math.round((nonCompliant / total) * 1000) / 10 : 0,
        totalViolations: allViolations.length,
        violationsPerInspection: total ? Math.round((allViolations.length / total) * 100) / 100 : 0,
        pendingReviews: allScans.filter((scan) => scan.reviewStatus === "PENDING").length,
        averageConfidence: confidences.length
          ? Math.round((confidences.reduce((sum, value) => sum + value, 0) / confidences.length) * 1000) / 1000
          : null,
        averageProcessingTimeSeconds: timings.length
          ? Math.round((timings.reduce((sum, value) => sum + value, 0) / timings.length / 1000) * 100) / 100
          : null,
      },
      agreement: {
        totalReviewed: reviewed.length,
        aiAccepted: accepted,
        aiOverridden: overridden,
        rejectedForReinspection: rejected + reinspection,
        humanAgreementCount: agreed,
        /** Share of human determinations that confirmed the automated decision. */
        agreementRatePercentage: reviewed.length ? Math.round((agreed / reviewed.length) * 1000) / 10 : null,
        overrideRatePercentage: reviewed.length
          ? Math.round((overridden / reviewed.length) * 1000) / 10
          : null,
      },
      severity: severityCount,
      topViolationTypes: Array.from(typeCounts.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
      categories: Array.from(categoryMap.entries())
        .map(([name, stats]) => ({
          name,
          total: stats.total,
          compliant: stats.compliant,
          rate: stats.total ? Math.round((stats.compliant / stats.total) * 1000) / 10 : 0,
        }))
        .sort((a, b) => b.total - a.total),
      statusCounts: { compliant, nonCompliant, requiresReview },
    };
  }

  // ------------------------------------------------------------------ search

  /**
   * Cross-entity global search.
   *
   * Results are permission scoped by the caller (it passes an optional
   * inspectorId for inspectors) so search never becomes a data-exfiltration
   * path around the list endpoints' authorization.
   */
  static async globalSearch(
    query: string,
    options: { limitPerGroup?: number; inspectorId?: string; inspectorIds?: string[] } = {},
  ): Promise<{
    inspections: Array<Record<string, unknown>>;
    products: Array<Record<string, unknown>>;
    rules: Array<Record<string, unknown>>;
    violations: Array<Record<string, unknown>>;
  }> {
    const trimmed = query?.trim();
    if (!trimmed) return { inspections: [], products: [], rules: [], violations: [] };

    const q = trimmed.toLowerCase();
    const limit = options.limitPerGroup ?? 5;

    // Single-id option is the degenerate case of the scope list.
    const scopeIds = options.inspectorIds ?? (options.inspectorId ? [options.inspectorId] : undefined);
    const scopeSet = scopeIds ? new Set(scopeIds.map(String)) : null;

    const [scansPage, productsPage, violationsPage, allScans] = await Promise.all([
      DBRepo.getScansPage({
        search: q,
        pageSize: limit,
        inspectorId: scopeSet?.size === 1 ? [...scopeSet][0] : undefined,
        ...(scopeSet && scopeSet.size > 1 ? { inspectorIds: [...scopeSet] } : {}),
      }),
      DBRepo.getProductsPage({ search: q, pageSize: limit }),
      DBRepo.getViolationsPage({
        search: q,
        pageSize: limit,
        ...(scopeSet?.size === 1 ? { inspectorId: [...scopeSet][0] } : {}),
      }),
      DBRepo.getAllScans(),
    ]);

    const scanById = new Map(allScans.map((scan) => [String(scan.id), scan]));

    // getViolationsPage only accepts a single inspectorId, so a department-wide
    // scope is enforced here against the owning inspection.
    const scopedViolations =
      scopeSet && scopeSet.size > 1
        ? violationsPage.items.filter((violation) => {
            const owner = scanById.get(String(violation.scanId))?.inspectorId;
            return owner ? scopeSet.has(String(owner)) : false;
          })
        : violationsPage.items;

    // Likewise, only surface products this officer has actually inspected.
    const scopedProducts = scopeSet
      ? productsPage.items.filter((product) =>
          allScans.some(
            (scan) =>
              String(scan.productId) === String(product.id) &&
              scan.inspectorId &&
              scopeSet.has(String(scan.inspectorId)),
          ),
        )
      : productsPage.items;

    const productById = new Map(
      (await DBRepo.getAllProducts()).map((product) => [String(product.id), product]),
    );

    const rules = Array.from(memoryStore.rules.values())
      .filter(
        (rule) =>
          textMatch(rule.ruleNumber, q) ||
          textMatch(rule.title, q) ||
          textMatch(rule.requirement, q) ||
          textMatch(rule.id, q) ||
          textMatch(rule.category, q),
      )
      .slice(0, limit)
      .map((rule) => ({
        id: rule.id,
        ruleNumber: rule.ruleNumber,
        title: rule.title,
        category: rule.category,
        severity: rule.severity,
        requirement: rule.requirement,
      }));

    const inspections = scansPage.items.map((scan) => {
      const product = scan.productId ? productById.get(String(scan.productId)) : undefined;
      return {
        id: scan.id,
        scanNumber: scan.scanNumber,
        productName: product?.name ?? null,
        location: scan.location ?? null,
        complianceStatus: scan.complianceStatus,
        reviewStatus: scan.reviewStatus,
        createdAt: scan.createdAt,
      };
    });

    const violations = scopedViolations.map((violation) => {
      const scan = scanById.get(String(violation.scanId));
      return {
        id: violation.id,
        title: violation.title,
        ruleId: violation.ruleId,
        severity: violation.severity,
        scanId: violation.scanId,
        scanNumber: scan?.scanNumber ?? null,
      };
    });

    return { inspections, products: scopedProducts, rules, violations };
  }
}

// Lower-cased email comparison helper (kept local to avoid importing sql twice).
function sqlLower(column: unknown) {
  return drizzleSql`lower(${column})`;
}

function startOfIsoWeek(date: Date): Date {
  const copy = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = copy.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  copy.setUTCDate(copy.getUTCDate() + diff);
  return copy;
}
