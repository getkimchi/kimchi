// Stub for @earendil-works/pi-coding-agent/dist/core/tools/output-accumulator.js
// Used by vitest alias so the deep-import path resolves in tests.
// The real module is used at runtime (Node resolves it via filesystem).

export interface OutputSnapshot {
	content: string
	truncation?: {
		truncated: boolean
		originalLines?: number
		originalBytes?: number
		keptLines?: number
		keptBytes?: number
	}
	fullOutputPath?: string
}

export class OutputAccumulator {
	private chunks: Buffer[] = []

	constructor(_options?: { maxLines?: number; maxBytes?: number; tempFilePrefix?: string }) {}

	append(data: Buffer): void {
		this.chunks.push(data)
	}

	finish(): void {
		// No-op in tests
	}

	snapshot(_options?: { persistIfTruncated?: boolean }): OutputSnapshot {
		const content = Buffer.concat(this.chunks).toString("utf8")
		return { content, truncation: { truncated: false } }
	}

	async closeTempFile(): Promise<void> {
		// No-op in tests
	}

	getLastLineBytes(): number {
		return 0
	}
}
