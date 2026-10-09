import { describe, expect, it } from "vitest"
import { type DocumentTelemetryEvent, emitDocumentEvent, setDocumentTelemetrySink, sizeRangeOf } from "./telemetry.js"

describe("document telemetry", () => {
	it("routes events through the injected sink", () => {
		const seen: DocumentTelemetryEvent[] = []
		setDocumentTelemetrySink((e) => seen.push(e))
		emitDocumentEvent({ tool: "read_document", format: "pdf", sizeRange: "lt1mb", units: 3, durationMs: 12 })
		expect(seen).toHaveLength(1)
		expect(seen[0]).toMatchObject({ tool: "read_document", format: "pdf", units: 3 })
		setDocumentTelemetrySink(() => {})
	})
	it("never throws when the sink throws", () => {
		setDocumentTelemetrySink(() => {
			throw new Error("boom")
		})
		expect(() => emitDocumentEvent({ tool: "read" })).not.toThrow()
		setDocumentTelemetrySink(() => {})
	})
	it("buckets sizes without exact bytes", () => {
		expect(sizeRangeOf(500)).toBe("lt1mb")
		expect(sizeRangeOf(2 * 1024 * 1024)).toBe("1-5mb")
		expect(sizeRangeOf(10 * 1024 * 1024)).toBe("5-20mb")
		expect(sizeRangeOf(21 * 1024 * 1024)).toBe("gt20mb")
	})
})
