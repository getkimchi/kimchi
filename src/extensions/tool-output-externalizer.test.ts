import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { handleToolResult, hydrateMarkers, type ToolOutputExternalizerState } from "./tool-output-externalizer.js"
import { createToolOutputStore, parseMarker, TOOL_OUTPUT_EXTERNALIZE_BYTES } from "./tool-output-store.js"

const ENV_KEYS = ["KIMCHI_TOOL_OUTPUT_STORE", "KIMCHI_TOOL_OUTPUT_EXTERNALIZE_BYTES"]
const below = "s".repeat(1024)
const above = "b".repeat(TOOL_OUTPUT_EXTERNALIZE_BYTES + 1)

function resultEvent(toolCallId: string, content: unknown[]): ToolResultEvent {
	return { type: "tool_result", toolCallId, input: {}, content, isError: false } as ToolResultEvent
}

describe("tool-output-externalizer", () => {
	let dir: string
	let state: ToolOutputExternalizerState

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "tool-output-externalizer-"))
		delete process.env.KIMCHI_TOOL_OUTPUT_STORE
		process.env.KIMCHI_TOOL_OUTPUT_EXTERNALIZE_BYTES = String(TOOL_OUTPUT_EXTERNALIZE_BYTES)
		state = { store: createToolOutputStore(dir), handlesByToolCallId: new Map() }
	})
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true })
		for (const key of ENV_KEYS) delete process.env[key]
	})

	it("externalizes oversized pure-text tool results with a marker replacement", () => {
		const event = resultEvent("call_1", [{ type: "text", text: above }])
		const result = handleToolResult(event, state)
		expect(result).toBeDefined()
		const marker = result?.content[0].text ?? ""
		const handle = parseMarker(marker)
		expect(handle).toBeDefined()
		expect(handle ? state.store.read(handle) : undefined).toBe(above)
		expect(state.handlesByToolCallId.get("call_1")).toEqual(handle)
	})

	it("leaves below-threshold results untouched", () => {
		const event = resultEvent("call_small", [{ type: "text", text: below }])
		expect(handleToolResult(event, state)).toBeUndefined()
		expect(state.handlesByToolCallId.size).toBe(0)
	})

	it("does not externalize mixed content (text + image blocks)", () => {
		const event = resultEvent("call_mixed", [
			{ type: "text", text: above },
			{ type: "image", image: { mediumType: "image/png", data: "AAAA" } },
		])
		expect(handleToolResult(event, state)).toBeUndefined()
	})

	it("round-trips exact bytes through marker hydration in request payloads", () => {
		const event = resultEvent("call_1", [{ type: "text", text: above }])
		const result = handleToolResult(event, state)
		if (!result) throw new Error("expected externalization")
		const marker = result.content[0].text

		const messages: Array<{
			role: string
			toolCallId?: string
			content: string | Array<{ type: string; text: string }>
		}> = [
			{ role: "toolResult", toolCallId: "call_1", content: [{ type: "text", text: marker }] },
			{ role: "user", content: "plain prompt" },
			{ role: "assistant", content: [{ type: "text", text: marker }] },
		]
		expect(hydrateMarkers(messages, state)).toBe(true)
		const blocks0 = messages[0].content as Array<{ type: string; text: string }>
		const blocks2 = messages[2].content as Array<{ type: string; text: string }>
		expect(blocks0[0].text).toBe(above)
		expect(blocks2[0].text).toBe(above)
	})

	it("does not hydrate markers embedded mid-text (exact-placeholder contract)", () => {
		const event = resultEvent("call_1", [{ type: "text", text: above }])
		const marker = handleToolResult(event, state)?.content[0].text ?? ""
		const message = { role: "user", content: `prefix ${marker} suffix` }
		const messages: Array<{ role: string; content: string | Array<{ type: string; text: string }> }> = [message]
		expect(hydrateMarkers(messages, state)).toBe(false)
		expect(message.content).toBe(`prefix ${marker} suffix`)
	})

	it("hydrates string-shaped message content too", () => {
		const event = resultEvent("call_x", [{ type: "text", text: above }])
		const marker = handleToolResult(event, state)?.content[0].text ?? ""
		const messages = [{ role: "user", content: marker }]
		expect(hydrateMarkers(messages, state)).toBe(true)
		expect(messages[0].content).toBe(above)
	})

	it("returns false and leaves markers when the mirror is gone (log fallback path)", () => {
		const event = resultEvent("call_1", [{ type: "text", text: above }])
		const marker = handleToolResult(event, state)?.content[0].text ?? ""
		// Corrupt the mirror handle on disk by removing the file.
		const handle = parseMarker(marker)
		if (!handle) throw new Error("expected valid marker")
		rmSync(handle.file, { force: true })
		const messages = [{ role: "toolResult", toolCallId: "call_1", content: [{ type: "text", text: marker }] }]
		expect(hydrateMarkers(messages, state)).toBe(false)
		expect(messages[0].content[0].text).toBe(marker)
	})

	describe("error branches and the escape hatch", () => {
		it("leaves the tool result unchanged when the mirror write fails", () => {
			const state = {
				store: {
					record: () => {
						throw new Error("disk full")
					},
				} as never,
				handlesByToolCallId: new Map(),
			}
			const error = vi.spyOn(console, "error").mockImplementation(() => {})
			const event = resultEvent("call_fail", [{ type: "text", text: above }])
			const result = handleToolResult(event, state as never)
			expect(result).toBeUndefined()
			expect(error).toHaveBeenCalledWith("[tool-output-externalizer] mirror write failed:", expect.any(Error))
			error.mockRestore()
		})

		it("KIMCHI_TOOL_OUTPUT_STORE=off disables externalization at the factory seam", async () => {
			process.env.KIMCHI_TOOL_OUTPUT_STORE = "off"
			const mod = await import("./tool-output-externalizer.js")
			const factory = (mod as { createToolOutputExternalizer: () => unknown }).createToolOutputExternalizer
			expect(factory()).toBeUndefined()
			delete process.env.KIMCHI_TOOL_OUTPUT_STORE
		})
	})

	it("handles non-marker text and malformed shapes without mutation", () => {
		const event = resultEvent("call_small", [{ type: "text", text: below }])
		handleToolResult(event, state)
		const messages = [
			{ role: "user", content: "ordinary" },
			{ role: "assistant", content: "another" },
			{ role: "toolResult", content: [{ type: "text", text: below }] },
		]
		const snapshot = JSON.stringify(messages)
		expect(hydrateMarkers(messages, state)).toBe(false)
		expect(JSON.stringify(messages)).toBe(snapshot)
	})
})
