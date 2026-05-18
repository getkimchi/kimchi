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

/**
 * Read an image file from disk, validating extension, size, and readability.
 * Returns `null` if the file is not a supported image, too large, or unreadable.
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
	return { bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), mimeType }
}
