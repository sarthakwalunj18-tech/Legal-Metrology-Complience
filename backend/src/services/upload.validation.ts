import { env } from "../config/env.js";
import { PayloadTooLargeError, UnsupportedMediaTypeError, ValidationError } from "../lib/errors.js";

export type SupportedImageFormat = "jpeg" | "png" | "webp";

export interface DetectedImageType {
  format: SupportedImageFormat;
  mimeType: string;
}

const MIME_BY_FORMAT: Record<SupportedImageFormat, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

const EXTENSION_BY_FORMAT: Record<SupportedImageFormat, string[]> = {
  jpeg: ["jpg", "jpeg"],
  png: ["png"],
  webp: ["webp"],
};

const ALLOWED_MIME_TYPES = new Set<string>(Object.values(MIME_BY_FORMAT));

/**
 * Identifies an image by its *actual* leading bytes.
 *
 * The multipart `Content-Type` supplied by a browser is attacker controlled, so
 * it is never used as the sole decision. This walks the magic-number signatures
 * for the three formats the OCR pipeline supports.
 */
export function detectImageType(buffer: Buffer): DetectedImageType | null {
  if (buffer.length < 12) return null;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { format: "jpeg", mimeType: MIME_BY_FORMAT.jpeg };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { format: "png", mimeType: MIME_BY_FORMAT.png };
  }

  // WebP: "RIFF" .... "WEBP"
  if (
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return { format: "webp", mimeType: MIME_BY_FORMAT.webp };
  }

  return null;
}

export function getExtension(fileName: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(fileName.trim());
  return match ? match[1].toLowerCase() : "";
}

export interface ValidatedUpload {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  format: SupportedImageFormat;
  sizeBytes: number;
}

export interface ValidateUploadOptions {
  declaredMimeType?: string;
  declaredFileName?: string;
  maxBytes?: number;
  minDimensionPx?: number;
  maxDimensionPx?: number;
}

/**
 * Full upload validation: size, real file signature, extension agreement,
 * declared MIME agreement and pixel dimensions (read via sharp metadata only,
 * no decode of the full image required here).
 */
export async function validateImageUpload(
  buffer: Buffer,
  options: ValidateUploadOptions = {},
): Promise<ValidatedUpload> {
  const maxBytes = options.maxBytes ?? env.UPLOAD_MAX_BYTES;

  if (!buffer || buffer.length === 0) {
    throw new ValidationError("The uploaded file is empty.");
  }

  if (buffer.length > maxBytes) {
    throw new PayloadTooLargeError(
      `The uploaded file exceeds the maximum allowed size of ${Math.floor(maxBytes / (1024 * 1024))} MB.`,
    );
  }

  const detected = detectImageType(buffer);

  if (!detected) {
    throw new UnsupportedMediaTypeError(
      "Unsupported image format. Only JPEG, PNG and WebP package photographs are accepted.",
    );
  }

  const extension = options.declaredFileName ? getExtension(options.declaredFileName) : "";
  if (extension && !EXTENSION_BY_FORMAT[detected.format].includes(extension)) {
    throw new UnsupportedMediaTypeError(
      `File extension '.${extension}' does not match the detected ${detected.format.toUpperCase()} content.`,
    );
  }

  const declaredMime = options.declaredMimeType?.trim().toLowerCase();
  if (declaredMime && declaredMime !== "application/octet-stream" && !ALLOWED_MIME_TYPES.has(declaredMime)) {
    throw new UnsupportedMediaTypeError(`Unsupported Content-Type '${declaredMime}'.`);
  }

  const metadata = await readImageDimensions(buffer);

  if (!metadata) {
    throw new UnsupportedMediaTypeError(
      "The uploaded file is not a readable image. It may be corrupt or truncated.",
    );
  }

  const minDimension = options.minDimensionPx ?? 200;
  const maxDimension = options.maxDimensionPx ?? 12_000;

  if (metadata.width < minDimension || metadata.height < minDimension) {
    throw new ValidationError(
      `Image resolution ${metadata.width}×${metadata.height}px is too low. Provide at least ${minDimension}px on each side so declaration text is legible.`,
    );
  }

  if (metadata.width > maxDimension || metadata.height > maxDimension) {
    throw new ValidationError(
      `Image resolution ${metadata.width}×${metadata.height}px exceeds the ${maxDimension}px limit.`,
    );
  }

  const safeBaseName = (options.declaredFileName || `package.${detected.format}`)
    .replace(/\.[^.]+$/, "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 60);

  return {
    buffer,
    fileName: `${safeBaseName || "package"}.${detected.format}`,
    mimeType: detected.mimeType,
    format: detected.format,
    sizeBytes: buffer.length,
  };
}

interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Reads pixel dimensions using sharp's header parser.
 * Kept in its own module so `validateImageUpload` stays testable without sharp.
 */
async function readImageDimensions(buffer: Buffer): Promise<ImageDimensions | null> {
  try {
    const { default: sharp } = await import("sharp");
    const metadata = await sharp(buffer, { limitInputPixels: 100_000_000 }).metadata();
    if (!metadata.width || !metadata.height) return null;
    return { width: metadata.width, height: metadata.height };
  } catch {
    return null;
  }
}
