/**
 * Local wrapper for upstream's OutputAccumulator.
 *
 * The upstream `@earendil-works/pi-coding-agent/dist/core/tools/output-accumulator.js`
 * is not in the package's `exports` map, so `bun build` (used by `build:binary`)
 * cannot resolve the deep-import path. This wrapper uses `require` to load the
 * real upstream module synchronously at runtime, falling back to a minimal
 * inline accumulator when the module is not resolvable (tests, or environments
 * where `require` is unavailable).
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
 * Create an OutputAccumulator instance synchronously. Tries the upstream
 * module first; falls back to an inline accumulator.
 */
export function createOutputAccumulator(options?: AccumulatorOptions): Accumulator {
	// In test environments (vitest), use the inline fallback to avoid
	// deep-import resolution issues and keep tests deterministic.
	if (process.env.VITEST) {
		return new InlineAccumulator(options)
	}
	try {
		const fs = require("node:fs")
		const path = require("node:path")
		const pkgLink = path.resolve("node_modules/@earendil-works/pi-coding-agent")
		const realPath = fs.realpathSync(pkgLink)
		const modPath = path.join(realPath, "dist/core/tools/output-accumulator.js")
		const mod = require(modPath)
		return new mod.OutputAccumulator(options)
	} catch {
		return new InlineAccumulator(options)
	}
}

/**
 * Minimal inline accumulator used as a fallback.
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
		// No-op
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
		// No-op
	}

	getLastLineBytes(): number {
		return 0
	}
}
