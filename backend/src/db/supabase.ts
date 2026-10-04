import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { env, supabaseAnonKey, supabaseServiceRoleKey } from "../config/env.js";

// Client for anonymous or forwarded user JWT operations
export const supabaseClient: SupabaseClient = createClient(
  env.SUPABASE_URL,
  supabaseAnonKey,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  }
);

// Admin client for backend operations requiring service role privileges
export const supabaseAdmin: SupabaseClient = createClient(
  env.SUPABASE_URL,
  supabaseServiceRoleKey,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  }
);

export interface DatabaseStatus {
  connected: boolean;
  latencyMs: number;
  error?: string;
}

/** Fails a probe quickly instead of letting a dead endpoint stall the request. */
async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`probe timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Validates connectivity to the Supabase endpoint.
 */
export async function checkSupabaseConnection(timeoutMs = 3000): Promise<DatabaseStatus> {
  const start = Date.now();
  try {
    // Ping Supabase storage to verify connection & credentials.
    const { error } = await withTimeout(supabaseAdmin.storage.listBuckets(), timeoutMs);
    const latencyMs = Date.now() - start;

    if (error) {
      return {
        connected: false,
        latencyMs,
        error: error.message,
      };
    }

    return {
      connected: true,
      latencyMs,
    };
  } catch (err: any) {
    return {
      connected: false,
      latencyMs: Date.now() - start,
      error: err.message || "Unknown error connecting to Supabase",
    };
  }
}
