import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TelemetryConfig } from "../../../config.js"
import { logEvents } from "./../otlp-test-utils.js"
import { TelemetryContext } from "./../session-context.js"
import { handleToolDecision, TOOL_DECISION_EVENT } from "./permissions.js"

function makeConfig(): TelemetryConfig {
	return {
		enabled: true,
		endpoint: "http://localhost:4318/v1/logs",
		metricsEndpoint: "http://localhost:4318/v1/metrics",
		headers: {},
		apiKey: "",
	}
}

describe("handleToolDecision", () => {
	let originalFetch: typeof globalThis.fetch

	beforeEach(() => {
		originalFetch = globalThis.fetch
		globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 })
	})

	afterEach(() => {
		globalThis.fetch = originalFetch
	})

	it("emits claude_code.tool_decision with decision attrs, preserving origin source", async () => {
		const ctx = new TelemetryContext(makeConfig())
		handleToolDecision(ctx, {
			toolCallId: "tc-1",
			toolName: "bash",
			decision: "reject",
			source: "user_reject",
			sourceDetail: "deny",
			permissionMode: "default",
		})

		ctx.flushLogBuffer()

		let event: ReturnType<typeof logEvents>[number] | undefined
		await vi.waitFor(() => {
			event = logEvents(globalThis.fetch as ReturnType<typeof vi.fn>).find((e) => e.eventName === TOOL_DECISION_EVENT)
			expect(event).toBeDefined()
		})
		expect(event?.attrs.tool_name).toBe("bash")
		expect(event?.attrs.tool_use_id).toBe("tc-1")
		expect(event?.attrs.decision).toBe("reject")
		expect(event?.attrs.decision_source).toBe("user_reject")
		expect(event?.attrs.source_detail).toBe("deny")
		expect(event?.attrs.permission_mode).toBe("default")
		// Common origin attr must stay "cli" — the decision origin moved to
		// decision_source because emit() spreads origin source after event attrs.
		expect(event?.attrs.source).toBe("cli")
	})

	it("includes file_extension for edit tools only when present", async () => {
		const ctx = new TelemetryContext(makeConfig())
		handleToolDecision(ctx, {
			toolCallId: "tc-2",
			toolName: "write",
			decision: "accept",
			source: "user_temporary",
			sourceDetail: "allow_once",
			permissionMode: "default",
			fileExtension: "ts",
		})

		ctx.flushLogBuffer()

		let event: ReturnType<typeof logEvents>[number] | undefined
		await vi.waitFor(() => {
			event = logEvents(globalThis.fetch as ReturnType<typeof vi.fn>).find((e) => e.eventName === TOOL_DECISION_EVENT)
			expect(event).toBeDefined()
		})
		expect(event?.attrs.file_extension).toBe("ts")
	})

	it("skips malformed payloads instead of emitting partial events", async () => {
		const ctx = new TelemetryContext(makeConfig())
		for (const bad of [
			undefined,
			{},
			{ toolName: "bash" },
			{ toolName: "bash", decision: "accept" },
			{ toolName: "bash", decision: "accept", source: "config" },
			{ toolName: "bash", decision: "accept", source: "config", sourceDetail: "rule" },
		]) {
			handleToolDecision(ctx, bad)
		}

		ctx.flushLogBuffer()

		// Wait for the post-email-resolution flush tick, then assert nothing was sent.
		await new Promise((resolve) => setTimeout(resolve, 0))
		const events = logEvents(globalThis.fetch as ReturnType<typeof vi.fn>)
		expect(events.find((e) => e.eventName === TOOL_DECISION_EVENT)).toBeUndefined()
	})
})
