import { describe, expect, it } from "vitest"
import { memoryEvidencePrefix, memoryMetadataForText, readMemoryMetadata } from "./metadata.js"

describe("memory lifecycle metadata", () => {
	it("round-trips known provenance, logical validity, confidence, and scoped attributes", () => {
		const metadata = memoryMetadataForText("As of 2026-11-10, use the offline hatch path", {
			episode: "session-a",
			source: "authored",
			confidence: 0.82,
			supportIds: ["evidence-1"],
			attributes: { scope: "documentation", reviewed: true },
		})
		expect(metadata).toMatchObject({
			version: 1,
			kind: "episodic",
			source: "authored",
			validAt: "2026-11-10",
			validOrder: 20261110,
			confidence: 0.82,
			canonical: true,
			episode: "session-a",
			supportIds: ["evidence-1"],
		})
		expect(readMemoryMetadata(metadata, "As of 2026-11-10, use the offline hatch path")).toEqual(metadata)
	})

	it("maps derived and authored prefixes without upgrading inference into observation", () => {
		const derived = memoryMetadataForText("[derived] perhaps the adapter is incompatible", { confidence: 0.4 })
		expect(derived).toMatchObject({ kind: "hypothesis", derived: true, canonical: false, confidence: 0.4 })
		const authored = memoryMetadataForText("[authored] check the current route before retrying")
		expect(authored).toMatchObject({ kind: "semantic", source: "authored", canonical: true })
	})

	it("classifies tentative interpretations without making them verified observations", () => {
		expect(memoryMetadataForText("the adapter probably uses a different endpoint")).toMatchObject({
			kind: "hypothesis",
			canonical: false,
		})
		expect(memoryMetadataForText("the adapter uses the primary endpoint")).toMatchObject({
			kind: "semantic",
			canonical: true,
		})
	})

	it("leaves legacy facts visible as unclassified, with no invented logical order", () => {
		expect(readMemoryMetadata(undefined, "the user prefers pnpm")).toEqual({
			version: 1,
			kind: "unclassified",
			source: "unknown",
			normalizedTextHash: expect.stringMatching(/^[a-f0-9]{64}$/),
		})
		expect(readMemoryMetadata(undefined, "the user prefers pnpm").derived).toBeUndefined()
		expect(readMemoryMetadata(undefined, "the user prefers pnpm").validOrder).toBeUndefined()
	})

	it("normalizes a deterministic text hash", () => {
		expect(readMemoryMetadata(undefined, "  Prefer  PNPM ")?.normalizedTextHash).toBe(
			readMemoryMetadata(undefined, "prefer pnpm")?.normalizedTextHash,
		)
	})

	it("rejects unknown versions without guessing their semantics", () => {
		expect(
			readMemoryMetadata({ version: 99, kind: "semantic", source: "authored", canonical: true }, "a fact"),
		).toMatchObject({
			kind: "unclassified",
			source: "unknown",
		})
	})

	it("filters untrusted fields, invalid dates, and oversized confidence", () => {
		expect(
			readMemoryMetadata(
				{
					kind: "working",
					source: new Date(),
					validOrder: -1,
					validAt: "2026-02-31",
					confidence: 2,
					canonical: true,
					supportIds: ["id-1", 2, "id-1"],
					attributes: { accepted: "yes", invalid: null },
					supersedes: "not-an-array",
				},
				"a fact",
			),
		).toMatchObject({
			kind: "working",
			source: "unknown",
			canonical: true,
			supportIds: ["id-1"],
			attributes: { accepted: "yes" },
		})
		const result = readMemoryMetadata(
			{ validAt: "2026-02-31", validOrder: -1, confidence: 2, supersedes: "bad" },
			"a fact",
		)
		expect(result.validAt).toBeUndefined()
		expect(result.validOrder).toBeUndefined()
		expect(result.confidence).toBeUndefined()
		expect(result.supersedes).toBeUndefined()
	})

	it("renders meaningful provenance without changing legacy text", () => {
		expect(memoryEvidencePrefix("a legacy fact")).toBe("")
		expect(memoryEvidencePrefix("[derived] a prior interpretation")).toBe("")
		expect(
			memoryEvidencePrefix("a new hypothesis", memoryMetadataForText("a new hypothesis", { kind: "hypothesis" })),
		).toBe("[derived] ")
		const current = memoryMetadataForText("current result", { kind: "working", canonical: true, validOrder: 2 })
		expect(memoryEvidencePrefix("current result", current)).toBe("[current working; canonical] ")
	})

	it("maps legacy derived text to derived evidence while preserving its unknown lifecycle kind", () => {
		expect(readMemoryMetadata(undefined, "[derived] a probable interpretation")).toMatchObject({
			kind: "unclassified",
			derived: true,
		})
	})
})
