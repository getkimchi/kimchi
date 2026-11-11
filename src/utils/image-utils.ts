import { readFileSync } from "node:fs"
import { extname } from "node:path"

/**
 * Maximum size for a pasted image file. 50 MB raw bytes is well above any
 * practical screenshot/photo and below typical provider request-size ceilings
 * even after base64 expansion (~67 MB on the wire).
 */
export const MAX_IMAGE_FILE_BYTES = 50 * 1024 * 1024

/**
 * Mapping from lowercased file extension to IANA media type.
 */
export const IMAGE_EXT_TO_MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
}

/** PNG magic: \x89PNG\r\n\x1a\n */
export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
/** JPEG magic: SOI + first marker byte. */
export const JPEG_SIGNATURE = [0xff, 0xd8, 0xff]
/** GIF magic prefix "GIF8"; 87a/89a differ only in the version byte that follows. */
export const GIF_SIGNATURE = [0x47, 0x49, 0x46, 0x38]
/** RIFF container magic; a WEBP payload carries "WEBP" at offset 8. */
export const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46]
/** WEBP marker bytes "WEBP". */
export const WEBP_SIGNATURE = [0x57, 0x45, 0x42, 0x50]

/**
 * Detect a supported image media type from magic bytes — the same set
 * `IMAGE_EXT_TO_MIME` maps extensions for — or `null` when the bytes are not
 * a decodable image. Content, unlike extension, cannot lie: a renamed or
 * pasteboard-provided PDF is rejected here instead of failing at the provider
 * with an opaque 400.
 */
export function sniffImageMimeType(bytes: Uint8Array): string | null {
	const len = bytes.length
	const starts = (sig: number[], offset = 0) => sig.every((b, i) => bytes[offset + i] === b)
	if (len >= PNG_SIGNATURE.length && starts(PNG_SIGNATURE)) {
		return "image/png"
	}
	if (len >= JPEG_SIGNATURE.length && starts(JPEG_SIGNATURE)) {
		return "image/jpeg"
	}
	if (len >= 6 && starts(GIF_SIGNATURE) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
		return "image/gif"
	}
	if (len >= 12 && starts(RIFF_SIGNATURE) && starts(WEBP_SIGNATURE, 8)) {
		return "image/webp"
	}
	return null
}

/**
 * Tri-state content check for the Finder-copied-file fallback: `true` when
 * the file exists, is readable, has a known image extension, and its content
 * sniffs as a supported image; `false` when it is readable but its content is
 * decidable-and-not-an-image (e.g. a PDF renamed to .png); `null` when
 * undecidable (unreadable, missing, oversize, unknown extension).
 */
export function hasImageFileContent(path: string): boolean | null {
	const mimeType = IMAGE_EXT_TO_MIME[extname(path).toLowerCase()]
	if (!mimeType) return null

	let buf: Buffer
	try {
		buf = readFileSync(path)
	} catch {
		return null
	}
	if (buf.length === 0 || buf.length > MAX_IMAGE_FILE_BYTES) return null
	return sniffImageMimeType(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)) !== null
}

/**
 * Read an image file from disk, validating extension, size, readability, and
 * content. Returns `null` if the file is not a supported image, too large,
 * unreadable, or its bytes are not a decodable image (extension ≠ content:
 * a renamed PDF must not reach the model as a PNG).
 */
export function readImageFileFromDisk(path: string): { bytes: Uint8Array; mimeType: string } | null {
	const mimeType = IMAGE_EXT_TO_MIME[extname(path).toLowerCase()]
	if (!mimeType) return null

	let buf: Buffer
	try {
		buf = readFileSync(path)
	} catch {
		return null
	}
	if (buf.length === 0 || buf.length > MAX_IMAGE_FILE_BYTES) return null
	const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
	const sniffed = sniffImageMimeType(bytes)
	if (!sniffed) return null
	return { bytes, mimeType: sniffed }
}
