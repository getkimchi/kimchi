import { randomUUID } from "node:crypto"
import { mkdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ImageContent } from "@earendil-works/pi-ai"

const EXT_MAP: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/webp": ".webp",
	"image/gif": ".gif",
	"image/avif": ".avif",
}

const DEFAULT_EXT = ".bin"

/**
 * Persist in-memory images to temp files so they can be passed to a subagent
 * via `attachments`.
 *
 * - Each image is base64-decoded and written to a unique tmp directory.
 * - Filenames use the IANA media type extension (`.png`, `.jpg`, etc.).
 * - The returned `prefix` is a short text annotation for the subagent prompt
 *   when images were truncated or when some of the turn images are otherwise
 *   not forwarded.
 *
 * Call `cleanup()` in a `finally` block to remove the directory and files.
 */
export function writeImagesForSubagent(images: ImageContent[]): {
	paths: string[]
	prefix: string
	cleanup: () => void
} {
	if (images.length === 0) {
		return { paths: [], prefix: "", cleanup: () => {} }
	}

	const dir = join(tmpdir(), `kimchi-subagent-${randomUUID()}`)
	mkdirSync(dir, { recursive: true })

	const paths: string[] = []
	for (let i = 0; i < images.length; i++) {
		const img = images[i]
		const ext = EXT_MAP[img.mimeType] ?? DEFAULT_EXT
		const fileName = `image-${i + 1}${ext}`
		const filePath = join(dir, fileName)
		writeFileSync(filePath, Buffer.from(img.data, "base64"))
		paths.push(filePath)
	}

	return {
		paths,
		prefix: "",
		cleanup: () => {
			for (const p of paths) {
				try {
					unlinkSync(p)
				} catch {
					// ignore
				}
			}
			try {
				rmdirSync(dir)
			} catch {
				// ignore
			}
		},
	}
}
