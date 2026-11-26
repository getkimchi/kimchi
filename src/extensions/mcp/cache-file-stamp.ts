import { statSync } from "node:fs"
import { getMetadataCachePath } from "pi-mcp-adapter/metadata-cache"

export interface CacheFileStamp {
	dev: bigint
	ino: bigint
	size: bigint
	mtimeNs: bigint
	ctimeNs: bigint
}

const MISSING_FILE_STAMP: CacheFileStamp = { dev: 0n, ino: 0n, size: -1n, mtimeNs: 0n, ctimeNs: 0n }

/** null means the stamp is unknown; callers must not reuse anything keyed on it. */
export function statMetadataCacheFile(): CacheFileStamp | null {
	try {
		const stats = statSync(getMetadataCachePath(), { bigint: true, throwIfNoEntry: false })
		if (stats === undefined) return MISSING_FILE_STAMP
		return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeNs: stats.mtimeNs, ctimeNs: stats.ctimeNs }
	} catch {
		return null
	}
}

export function sameCacheFileStamp(a: CacheFileStamp, b: CacheFileStamp): boolean {
	return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
}
