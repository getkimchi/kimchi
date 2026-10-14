import { gunzipSync, gzipSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import { redactText } from "../extensions/pii-redaction/redactor.js"
import { enrichReplayDetails } from "./details.js"
import type { Recording } from "./recorder.js"

function marker(step: number, values: Record<string, unknown> = {}) {
	return {
		type: "kimchi.trace",
		version: 1,
		step,
		kind: "response",
		title: "Model response",
		detail: "Live text",
		messageTimestamp: 100,
		responseId: "response-a",
		frame: true,
		delayMs: 5,
		...values,
	}
}

function recording(markers: ReturnType<typeof marker>[], sessionId = "session"): Recording {
	const cast = [
		{ version: 3, term: { cols: 120, rows: 40 } },
		[0, "o", "Recorded screen"],
		...markers.map((step) => [0.1, "m", JSON.stringify(step)]),
	]
	const text = `${cast.map((line) => JSON.stringify(line)).join("\n")}\n`
	return {
		gzip: gzipSync(text).toString("base64"),
		metadata: {
			version: 1,
			id: "recording",
			sessionId,
			pid: 0,
			startedAt: "2026-10-13T10:00:00Z",
			status: "complete",
			cols: 120,
			rows: 40,
			chunks: 1,
			rawBytes: Buffer.byteLength(text),
			compressedBytes: 120,
			duration: 0.1,
			queueHighWaterBytes: 200,
		},
	}
}

function entry(id: string, message: Record<string, unknown>, parentId: string | null = null) {
	return { type: "message", id, parentId, timestamp: "2026-10-13T10:00:01Z", message }
}

function assistant(values: Record<string, unknown> = {}) {
	return {
		role: "assistant",
		timestamp: 100,
		responseId: "response-a",
		model: "glm-5.3-flash",
		provider: "test",
		api: "openai-completions",
		stopReason: "stop",
		rawStopReason: "end_turn",
		content: [{ type: "text", text: "Saved redacted response" }],
		usage: {
			input: 128,
			output: 24,
			cacheRead: 64,
			cacheWrite: 8,
			reasoning: 6,
			totalTokens: 224,
			cost: { total: 0 },
		},
		...values,
	}
}

function custom(id: string, parentId: string, customType: string, data: unknown) {
	return { type: "custom", id, parentId, timestamp: "2026-10-13T10:00:00Z", customType, data }
}

function html(entries: unknown[], sessionId = "session") {
	const payload = Buffer.from(JSON.stringify({ header: { id: sessionId }, entries, leafId: "active-branch" })).toString(
		"base64",
	)
	return `<body><script type="application/json" id="session-data">${payload}</script></body>`
}

describe("saved details in terminal replay", () => {
	it("joins exact role/time/response identity and keeps saved data separate from live markers", async () => {
		const response = { ...entry("saved-response", assistant()), traceIds: ["trace-a", "trace-b"] }
		const prompt = entry("saved-prompt", { role: "user", timestamp: 5, content: "Saved redacted prompt" })
		const original = recording([marker(1), marker(2, { kind: "prompt", messageTimestamp: 5, responseId: undefined })])
		const [result] = await enrichReplayDetails(html([prompt, response]), [original])
		expect(result.traceDetails?.["1"]).toMatchObject({
			fields: {
				"Entry ID": "saved-response",
				"Entry time": "2026-10-13T10:00:01Z",
				Model: "glm-5.3-flash",
				Provider: "test",
				API: "openai-completions",
				"Stop reason": "stop",
				"Raw stop reason": "end_turn",
				"Response ID": "response-a",
				"Trace IDs": "trace-a\ntrace-b",
				"Input tokens": "128",
				"Output tokens": "24",
				"Cache read tokens": "64",
				"Cache write tokens": "8",
				"Reasoning tokens": "6",
				"Total tokens": "224",
				"Reported cost (USD)": "0",
			},
			content: "Saved redacted response",
		})
		expect(result.traceDetails?.["2"]?.content).toBe("Saved redacted prompt")
		expect(result.gzip).toBe(original.gzip)
		expect(gunzipSync(Buffer.from(result.gzip, "base64")).toString()).toContain("Live text")
		expect(original).not.toHaveProperty("traceDetails")
	})

	it("rejects ambiguous role/time joins unless an exact response ID disambiguates them", async () => {
		const entries = [
			entry("a", assistant()),
			entry("b", assistant({ responseId: "response-b" })),
			entry("u1", { role: "user", timestamp: 100, content: "first" }),
			entry("u2", { role: "user", timestamp: 100, content: "second" }),
		]
		const [result] = await enrichReplayDetails(html(entries), [
			recording([
				marker(1),
				marker(2, { responseId: undefined }),
				marker(3, { responseId: "missing" }),
				marker(4, { kind: "prompt", responseId: undefined }),
				marker(5, { messageTimestamp: 101 }),
				marker(6, { messageTimestamp: undefined }),
			]),
		])
		expect(Object.keys(result.traceDetails ?? {})).toEqual(["1"])
		expect(result.traceDetails?.["1"]?.fields["Entry ID"]).toBe("a")
		expect(result.traceDetailsOmitted).toBeUndefined()
		const [duplicate] = await enrichReplayDetails(html([...entries, entry("same", assistant())]), [
			recording([marker(1)]),
		])
		expect(duplicate.traceDetails).toBeUndefined()
	})

	it("joins old tool markers by unique call ID without changing the recorded live result", async () => {
		const entries = [
			entry(
				"call-entry",
				assistant({ content: [{ type: "toolCall", id: "call-a", name: "read", arguments: { path: "safe.txt" } }] }),
			),
			entry("result-entry", {
				role: "toolResult",
				toolCallId: "call-a",
				toolName: "read",
				timestamp: 200,
				isError: false,
				content: [{ type: "text", text: "Saved replacement" }],
				details: { error: "tool_error", mcpResult: { isError: true }, text: "</script><img src=x onerror=alert(1)>" },
			}),
		]
		const original = recording([
			marker(1, { kind: "tool_call", toolCallId: "call-a", messageTimestamp: undefined, responseId: undefined }),
			marker(2, {
				kind: "tool_result",
				toolCallId: "call-a",
				messageTimestamp: undefined,
				responseId: undefined,
				error: true,
				detail: "Live failure",
				frame: false,
			}),
		])
		const [result] = await enrichReplayDetails(html(entries), [original])
		expect(result.traceDetails?.["1"]).toMatchObject({ fields: { Tool: "read", "Tool call ID": "call-a" } })
		expect(result.traceDetails?.["1"]?.content).toContain('"path": "safe.txt"')
		expect(result.traceDetails?.["2"]).toMatchObject({
			fields: { "Saved result": "success" },
			content: "Saved replacement",
		})
		expect(result.traceDetails?.["2"]?.diagnostics).toContain("tool_result details")
		expect(result.traceDetails?.["2"]?.diagnostics).toContain('"isError": true')
		expect(result.traceDetails?.["2"]?.diagnostics).toContain("onerror=alert(1)")
		expect(result.gzip).toBe(original.gzip)
		const [ambiguous] = await enrichReplayDetails(
			html([...entries, ...entries.map((value) => ({ ...value, id: `branch-${value.id}` }))]),
			[original],
		)
		expect(ambiguous.traceDetails).toBeUndefined()
	})

	it("joins a unique timestamp when export redaction changed the saved response ID", async () => {
		const responseId = "5572836de081468eb35b2a211c354678"
		const redactedId = await redactText(responseId)
		expect(redactedId).toBe("55728[REDACTED-CRYPTO]")
		const original = recording([marker(1, { responseId })])
		const entries = [
			entry("saved", assistant({ responseId: redactedId })),
			entry("user-at-same-time", { role: "user", timestamp: 100, content: "Another role" }),
		]
		const [result] = await enrichReplayDetails(html(entries), [original])
		expect(result.traceDetails?.["1"]).toMatchObject({
			fields: { "Entry ID": "saved", "Response ID": redactedId },
			content: "Saved redacted response",
		})
		expect(JSON.stringify(result.traceDetails)).not.toContain(responseId)
		expect(result.gzip).toBe(original.gzip)
	})

	it("does not weaken response identity for ambiguous, missing or conflicting intact IDs", async () => {
		const original = recording([marker(1)])
		for (const entries of [
			[entry("a", assistant({ responseId: "[REDACTED-CRYPTO]" })), entry("b", assistant({ responseId: "different" }))],
			[
				entry("a", assistant({ responseId: "[REDACTED-CRYPTO]" })),
				entry("b", assistant({ responseId: "[REDACTED-CRYPTO]" })),
			],
			[entry("a", assistant({ responseId: "different" }))],
			[entry("a", assistant({ responseId: undefined }))],
			[entry("a", assistant({ responseId: "[REDACTED-]" }))],
		]) {
			const [result] = await enrichReplayDetails(html(entries), [original])
			expect(result.traceDetails).toBeUndefined()
		}
	})

	it("searches all branches but follows only the matched assistant's diagnostic parent chain", async () => {
		const entries = [
			entry("user", { role: "user", timestamp: 1, content: "prompt" }, "earlier"),
			custom("earlier", "user", "request_diagnostics", { requestId: "PREVIOUS-TURN" }),
			custom("r1", "user", "request_diagnostics", { requestId: "first-request", durationMs: 12 }),
			custom("cache", "r1", "cache_summary", { secret: "UNRELATED-CACHE" }),
			custom("r2", "cache", "request_diagnostics", { requestId: "second-request", durationMs: 20 }),
			custom("debug", "r2", "llm_response_debug", { model: "glm", stopReason: "stop" }),
			custom("duration", "debug", "turn_duration", { durationMs: 250 }),
			custom("classification", "duration", "kimchi_error_classification", { retryable: true }),
			custom("trace", "classification", "trace_ids", { traceIds: ["UNRELATED-TRACE"] }),
			entry("inactive-response", assistant(), "trace"),
			custom("other-branch", "user", "request_diagnostics", { requestId: "WRONG-BRANCH" }),
			entry("active-branch", assistant({ timestamp: 101 }), "other-branch"),
		]
		const [result] = await enrichReplayDetails(html(entries), [recording([marker(1)])])
		const detail = result.traceDetails?.["1"]
		expect(detail?.fields["Entry ID"]).toBe("inactive-response")
		expect(detail?.diagnostics).toContain("request_diagnostics")
		expect(detail?.diagnostics).toContain("llm_response_debug")
		expect(detail?.diagnostics).toContain("turn_duration")
		expect(detail?.diagnostics).toContain("kimchi_error_classification")
		expect(detail?.diagnostics?.indexOf("first-request")).toBeLessThan(
			detail?.diagnostics?.indexOf("second-request") ?? 0,
		)
		expect(detail?.diagnostics).not.toMatch(/PREVIOUS-TURN|WRONG-BRANCH|UNRELATED-CACHE|UNRELATED-TRACE/)
	})

	it("stops diagnostic cycles, missing parents and ambiguous parent IDs", async () => {
		const entries = [
			custom("cycle-a", "cycle-b", "request_diagnostics", { requestId: "once-a" }),
			custom("cycle-b", "cycle-a", "request_diagnostics", { requestId: "once-b" }),
			entry("a", assistant(), "cycle-a"),
			entry("b", assistant({ timestamp: 200 }), "missing"),
			custom("duplicate", "missing", "request_diagnostics", { requestId: "WRONG" }),
			custom("duplicate", "missing", "request_diagnostics", { requestId: "ALSO-WRONG" }),
			entry("c", assistant({ timestamp: 300 }), "duplicate"),
		]
		const [result] = await enrichReplayDetails(html(entries), [
			recording([marker(1), marker(2, { messageTimestamp: 200 }), marker(3, { messageTimestamp: 300 })]),
		])
		expect(result.traceDetails?.["1"]?.diagnostics?.match(/once-a/g)).toHaveLength(1)
		expect(result.traceDetails?.["1"]?.diagnostics?.match(/once-b/g)).toHaveLength(1)
		expect(result.traceDetails?.["2"]?.diagnostics).toBeUndefined()
		expect(result.traceDetails?.["3"]?.diagnostics).toBeUndefined()
	})

	it("leaves playback intact for missing data, a different session or a damaged cast", async () => {
		const original = recording([marker(1)])
		for (const document of [
			"<body>old export</body>",
			html([entry("a", assistant())], "other-session"),
			'<script id="session-data" type="application/json">broken</script>',
		]) {
			expect(await enrichReplayDetails(document, [original])).toEqual([original])
		}
		const broken = { ...original, gzip: "invalid gzip" }
		expect(await enrichReplayDetails(html([entry("a", assistant())]), [broken])).toEqual([broken])
		const [old] = await enrichReplayDetails(html([entry("a", assistant())]), [
			recording([marker(1, { messageTimestamp: undefined, responseId: undefined })]),
		])
		expect(old.traceDetails).toBeUndefined()
	})

	it("keeps hostile text inert and excludes image payloads and hidden thinking", async () => {
		const hostile = '</script><img src=x onerror="alert(1)">'
		const response = entry(
			"a",
			assistant({
				content: [
					{ type: "thinking", thinking: "PRIVATE-THINKING" },
					{ type: "image", data: "PRIVATE-IMAGE" },
					{ type: "text", text: hostile },
					{
						type: "toolCall",
						id: "safe-call",
						name: "read",
						arguments: { path: hostile, image: { type: "image", data: "PRIVATE-ARGUMENT-IMAGE" } },
					},
				],
			}),
			"debug",
		)
		const diagnostic = custom("debug", "missing", "llm_response_debug", {
			path: hostile,
			thinking: { type: "thinking", thinking: "PRIVATE-DIAGNOSTIC" },
		})
		const [result] = await enrichReplayDetails(html([diagnostic, response]), [
			recording([marker(1), marker(2, { kind: "tool_call", toolCallId: "safe-call" })]),
		])
		expect(result.traceDetails?.["1"]?.content).toBe(hostile)
		expect(JSON.stringify(result.traceDetails)).not.toMatch(/PRIVATE-/)
		expect(result.traceDetails?.["2"]?.content).toContain("onerror")
	})

	it("bounds escaped Unicode content and diagnostics per step and counts part-budget omissions", async () => {
		const huge = '\u0000"🦊<'.repeat(100_000)
		const entries: unknown[] = [custom("debug", "missing", "llm_response_debug", { huge })]
		const markers = []
		for (let index = 1; index <= 40; index++) {
			entries.push(
				entry(
					`a-${index}`,
					assistant({ timestamp: index, model: huge, content: [{ type: "text", text: huge }] }),
					"debug",
				),
			)
			markers.push(marker(index, { messageTimestamp: index }))
		}
		const [result] = await enrichReplayDetails(html(entries), [recording(markers)])
		const details = Object.values(result.traceDetails ?? {})
		expect(details.length).toBeGreaterThan(0)
		expect(details.length).toBeLessThan(40)
		for (const detail of details) {
			expect(Buffer.byteLength(JSON.stringify(detail).replaceAll("<", "\\u003c"))).toBeLessThanOrEqual(64 * 1024)
			expect(detail.truncated).toBe(true)
		}
		expect(result.traceDetailsOmitted).toBe(40 - details.length)
		expect(
			Buffer.byteLength(
				JSON.stringify({
					traceDetails: result.traceDetails,
					traceDetailsOmitted: result.traceDetailsOmitted,
				}).replaceAll("<", "\\u003c"),
			),
		).toBeLessThanOrEqual(1024 * 1024)
	})

	it("retains only the marker details in each independently downloadable part", async () => {
		const parts = [recording([marker(1)]), recording([marker(2, { messageTimestamp: 200 })])]
		const result = await enrichReplayDetails(
			html([entry("a", assistant()), entry("b", assistant({ timestamp: 200 }))]),
			parts,
		)
		expect(Object.keys(result[0].traceDetails ?? {})).toEqual(["1"])
		expect(Object.keys(result[1].traceDetails ?? {})).toEqual(["2"])
		expect(result.map((part) => part.gzip)).toEqual(parts.map((part) => part.gzip))
	})

	it("does not associate duplicate marker steps or duplicate saved entry IDs", async () => {
		const duplicateSteps = recording([marker(1), marker(1, { messageTimestamp: 200 }), marker(2)])
		const entries = [entry("a", assistant()), entry("b", assistant({ timestamp: 200 }))]
		const [result] = await enrichReplayDetails(html(entries), [duplicateSteps])
		expect(Object.keys(result.traceDetails ?? {})).toEqual(["2"])
		const [duplicateEntries] = await enrichReplayDetails(html([entries[0], { ...entries[1], id: "a" }]), [
			recording([marker(1)]),
		])
		expect(duplicateEntries.traceDetails).toBeUndefined()
	})

	it("marks a bounded diagnostic walk as incomplete and preserves the saved model error", async () => {
		const entries: unknown[] = [custom("0", "missing", "request_diagnostics", { requestId: "BEYOND-LIMIT" })]
		for (let index = 1; index <= 512; index++)
			entries.push(custom(String(index), String(index - 1), "cache_summary", {}))
		entries.push(entry("a", assistant({ stopReason: "error", errorMessage: "Saved provider failure" }), "512"))
		const [result] = await enrichReplayDetails(html(entries), [recording([marker(1, { kind: "error" })])])
		expect(result.traceDetails?.["1"]).toMatchObject({ fields: { Error: "Saved provider failure" }, truncated: true })
		expect(result.traceDetails?.["1"]?.diagnostics).toBeUndefined()
	})
})
