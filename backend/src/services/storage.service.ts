import { supabaseAdmin } from "../db/supabase.js";
import { env, publicApiUrl } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { signMediaToken } from "../lib/media-signing.js";
import fs from "fs/promises";
import path from "path";

const BUCKET_NAME = env.SUPABASE_STORAGE_BUCKET;
const LOCAL_STORAGE_DIR = path.resolve(process.cwd(), "uploads");

/**
 * Locally stored evidence lives under `uploads/`. The resolved path must stay
 * inside that directory — this guards against traversal via a crafted filename.
 */
function resolveLocalPath(fileName: string): string {
  const resolved = path.resolve(LOCAL_STORAGE_DIR, path.basename(fileName));
  if (!resolved.startsWith(LOCAL_STORAGE_DIR + path.sep) && resolved !== LOCAL_STORAGE_DIR) {
    throw new Error("Resolved media path escapes the storage root.");
  }
  return resolved;
}

async function ensureLocalDir(): Promise<void> {
  await fs.mkdir(LOCAL_STORAGE_DIR, { recursive: true });
}

export interface UploadResult {
  storagePath: string;
  /** Browser-reachable URL. Expiring + signed; never a raw filesystem path. */
  signedUrl: string;
  storageProvider: "supabase" | "local";
}

function localMediaUrl(storagePath: string, contentType: string): string {
  const token = signMediaToken(storagePath);
  return `${publicApiUrl}/api/media/${encodeURIComponent(contentType)}?token=${encodeURIComponent(token)}`;
}

export class StorageService {
  /**
   * Uploads a buffer to Supabase Storage, falling back to the local filesystem
   * when Supabase is unreachable so offline / sandbox demos keep working.
   */
  static async uploadFile(
    fileBuffer: Buffer,
    fileName: string,
    contentType: string,
    folder: string = "scans",
  ): Promise<UploadResult> {
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120);
    const storagePath = `${folder}/${Date.now()}_${safeName}`;

    try {
      const { data, error } = await supabaseAdmin.storage
        .from(BUCKET_NAME)
        .upload(storagePath, fileBuffer, { contentType, upsert: false });

      if (!error && data) {
        const { data: signedData } = await supabaseAdmin.storage
          .from(BUCKET_NAME)
          .createSignedUrl(storagePath, env.MEDIA_URL_TTL_SECONDS);

        return {
          storagePath,
          signedUrl:
            signedData?.signedUrl ?? `${publicApiUrl}/api/media/redirect?path=${encodeURIComponent(storagePath)}`,
          storageProvider: "supabase",
        };
      }

      logger.warn("Supabase Storage upload failed, using local filesystem", {
        storagePath,
        reason: error?.message,
      });
    } catch (error) {
      logger.warn("Supabase Storage unavailable, using local filesystem", { storagePath, error });
    }

    await ensureLocalDir();
    const localFilePath = resolveLocalPath(path.basename(storagePath));
    await fs.writeFile(localFilePath, fileBuffer);

    const localStoragePath = `local://${path.basename(storagePath)}`;

    return {
      storagePath: localStoragePath,
      signedUrl: localMediaUrl(localStoragePath, contentType),
      storageProvider: "local",
    };
  }

  /**
   * Resolves a storage path into a browser-reachable, expiring URL.
   * Returns an empty string when the object no longer exists.
   */
  static async getSignedUrl(
    storagePath: string,
    contentType = "image/jpeg",
  ): Promise<string> {
    if (!storagePath) return "";

    if (storagePath.startsWith("local://")) {
      const fileName = storagePath.slice("local://".length);
      const localFilePath = resolveLocalPath(fileName);
      try {
        await fs.access(localFilePath);
      } catch {
        return "";
      }
      return localMediaUrl(storagePath, contentType);
    }

    try {
      const { data } = await supabaseAdmin.storage
        .from(BUCKET_NAME)
        .createSignedUrl(storagePath, env.MEDIA_URL_TTL_SECONDS);
      return data?.signedUrl ?? "";
    } catch (error) {
      logger.warn("Failed to create Supabase signed URL", { storagePath, error });
      return "";
    }
  }

  /** Reads a stored object back into memory (used by OCR / report pipelines). */
  static async downloadFile(storagePath: string): Promise<Buffer> {
    if (storagePath.startsWith("local://")) {
      return fs.readFile(resolveLocalPath(storagePath.slice("local://".length)));
    }

    const { data, error } = await supabaseAdmin.storage
      .from(BUCKET_NAME)
      .download(storagePath);

    if (error || !data) {
      throw new Error(`Failed to download stored object (${error?.message ?? "unknown error"}).`);
    }

    return Buffer.from(await data.arrayBuffer());
  }

  /** Streams a stored object to a Fastify reply. */
  static async streamFile(storagePath: string): Promise<{
    buffer: Buffer;
    contentType: string;
    size: number;
  }> {
    const contentType = StorageService.contentTypeFor(storagePath);

    if (storagePath.startsWith("local://")) {
      const buffer = await fs.readFile(resolveLocalPath(storagePath.slice("local://".length)));
      return { buffer, contentType, size: buffer.length };
    }

    const { data, error } = await supabaseAdmin.storage
      .from(BUCKET_NAME)
      .download(storagePath);

    if (error || !data) {
      throw new Error("Stored object is unavailable.");
    }

    const buffer = Buffer.from(await data.arrayBuffer());
    return { buffer, contentType: data.type || contentType, size: buffer.length };
  }

  static contentTypeFor(storagePath: string): string {
    const extension = path.extname(storagePath).toLowerCase();
    switch (extension) {
      case ".png":
        return "image/png";
      case ".webp":
        return "image/webp";
      case ".pdf":
        return "application/pdf";
      case ".csv":
        return "text/csv";
      case ".json":
        return "application/json";
      default:
        return "image/jpeg";
    }
  }

  /**
   * Browser-reachable URL for an already stored object. Supabase objects get a
   * native signed URL; local files get a short-lived HMAC token so the raw
   * filesystem path is never exposed.
   */
  static async signedUrlFor(storagePath: string): Promise<string> {
    if (!storagePath) return "";

    if (!storagePath.startsWith("local://")) {
      try {
        const { data, error } = await supabaseAdmin.storage
          .from(BUCKET_NAME)
          .createSignedUrl(storagePath, env.MEDIA_URL_TTL_SECONDS);

        if (!error && data?.signedUrl) return data.signedUrl;
      } catch (error) {
        logger.warn("Failed to create Supabase signed URL", {
          storagePath,
          error,
        });
      }
    }

    return localMediaUrl(storagePath, StorageService.contentTypeFor(storagePath));
  }

  static async deleteFile(storagePath: string): Promise<void> {
    if (!storagePath) return;

    if (storagePath.startsWith("local://")) {
      await fs.unlink(resolveLocalPath(storagePath.slice("local://".length))).catch(() => undefined);
      return;
    }

    await supabaseAdmin.storage.from(BUCKET_NAME).remove([storagePath]).catch(() => undefined);
  }
}
