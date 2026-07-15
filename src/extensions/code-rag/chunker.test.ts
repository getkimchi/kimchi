import { describe, expect, it } from "vitest"
import { chunkFile, embeddingInputForChunk } from "./chunker.js"

describe("chunkFile", () => {
	it("returns a single chunk for a small file", () => {
		const chunks = chunkFile("src/a.ts", "line1\nline2\nline3")
		expect(chunks).toHaveLength(1)
		expect(chunks[0]).toMatchObject({ file: "src/a.ts", startLine: 1, endLine: 3 })
		expect(chunks[0].text).toBe("line1\nline2\nline3")
	})

	it("skips whitespace-only content", () => {
		expect(chunkFile("src/a.ts", "\n\n  \n")).toHaveLength(0)
	})

	it("produces overlapping windows covering every line", () => {
		const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`)
		const chunks = chunkFile("src/b.ts", lines.join("\n"))
		expect(chunks.length).toBeGreaterThan(1)
		expect(chunks[0].startLine).toBe(1)
		expect(chunks.at(-1)?.endLine).toBe(200)
		// Consecutive chunks overlap: next chunk starts before the previous ends.
		for (let i = 1; i < chunks.length; i++) {
			expect(chunks[i].startLine).toBeLessThanOrEqual(chunks[i - 1].endLine)
		}
		// Every line is covered exactly by walking the windows.
		const covered = new Set<number>()
		for (const chunk of chunks) {
			for (let l = chunk.startLine; l <= chunk.endLine; l++) covered.add(l)
		}
		expect(covered.size).toBe(200)
	})

	it("caps pathological chunks at the char limit", () => {
		const chunks = chunkFile("src/c.ts", "x".repeat(50_000))
		expect(chunks).toHaveLength(1)
		expect(chunks[0].text.length).toBe(6000)
	})
})

describe("embeddingInputForChunk", () => {
	it("prepends the file path and line range", () => {
		const [chunk] = chunkFile("src/a.ts", "const x = 1")
		expect(embeddingInputForChunk(chunk)).toBe("File: src/a.ts (lines 1-1)\nconst x = 1")
	})
})
