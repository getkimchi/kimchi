/**
 * Local wrapper for upstream's OutputAccumulator.
 *
 * The upstream `@earendil-works/pi-coding-agent/dist/core/tools/output-accumulator.js`
 * is not in the package's `exports` map, so `bun build` (used by `build:binary`)
 * cannot resolve the deep-import path. This wrapper uses `createRequire` to
 * load the real upstream module synchronously at runtime, falling back to a
 * minimal inline accumulator when the module path is unavailable (e.g. in
 * tests where the vitest alias stub is used).
 *
 * This follows the same pattern as `src/utils/clipboard-image.ts`.
 */

export interface TruncationResult {
	truncated: boolean
	originalLines?: number
	originalBytes?: number
	keptLines?: number
	keptBytes?: number
}

export interface OutputSnapshot {
	content: string
	truncation: TruncationResult
	fullOutputPath?: string
}

export interface AccumulatorOptions {
	maxLines?: number
	maxBytes?: number
	tempFilePrefix?: string
}

export interface Accumulator {
	append(data: Buffer): void
	finish(): void
	snapshot(options?: { persistIfTruncated?: boolean }): OutputSnapshot
	closeTempFile(): Promise<void>
	getLastLineBytes(): number
}

/**
 * Create an OutputAccumulator instance synchronously. Uses the upstream
 * module at runtime via `createRequire`; falls back to a minimal inline
 * accumulator when the upstream module is not resolvable (tests).
 */
export function createOutputAccumulator(options?: AccumulatorOptions): Accumulator {
	try {
		// Resolve the package directory directly on the filesystem, bypassing
		// the package's `exports` map (which blocks deep imports). The file
		// exists on disk after `pnpm install` but is not in `exports`.
		const fs = require("node:fs")
		const path = require("node:path")
		const pkgLink = path.resolve("node_modules/@earendil-works/pi-coding-agent")
		const realPath = fs.realpathSync(pkgLink)
		const modPath = path.join(realPath, "dist/core/tools/output-accumulator.js")
		const mod = require(modPath)
		return new mod.OutputAccumulator(options)
	} catch {
		// Fallback: minimal accumulator that keeps all output in memory.
		return new InlineAccumulator(options)
	}
}

/**
 * Minimal inline accumulator used as a fallback when the upstream module
 * is not available (tests, or environments where the deep import fails).
 */
class InlineAccumulator implements Accumulator {
	private chunks: Buffer[] = []
	private readonly maxLines: number
	private readonly maxBytes: number

	constructor(options?: AccumulatorOptions) {
		this.maxLines = options?.maxLines ?? 2000
		this.maxBytes = options?.maxBytes ?? 50_000
	}

	append(data: Buffer): void {
		this.chunks.push(data)
	}

	finish(): void {
		// No-op — all data is already in memory
	}

	snapshot(_options?: { persistIfTruncated?: boolean }): OutputSnapshot {
		const all = Buffer.concat(this.chunks).toString("utf8")
		const lines = all.split("\n")
		const truncated = lines.length > this.maxLines || all.length > this.maxBytes
		if (truncated) {
			const keptLines = lines.slice(-this.maxLines)
			const content = keptLines.join("\n").slice(-this.maxBytes)
			return {
				content,
				truncation: {
					truncated: true,
					originalLines: lines.length,
					originalBytes: all.length,
					keptLines: keptLines.length,
					keptBytes: content.length,
				},
			}
		}
		return { content: all, truncation: { truncated: false } }
	}

	async closeTempFile(): Promise<void> {
		// No-op — no temp file used
	}

	getLastLineBytes(): number {
		return 0
	}
}
