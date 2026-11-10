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

	it("maps every source detail onto the official decision_source vocabulary", async () => {
		const ctx = new TelemetryContext(makeConfig())
		const cases = [
			["yolo_bypass", "config"],
			["no_ui", "config"],
			["bundled_skill_cli", "config"],
			["bundled_skill_dir_deny", "config"],
			["classifier", "hook"],
			["allow_once", "user_temporary"],
			["allow_remember_wildcard", "user_permanent"],
			["deny_with_feedback", "user_reject"],
			["abort", "user_abort"],
		] as const
		for (const [sourceDetail] of cases) {
			handleToolDecision(ctx, {
				toolCallId: `tc-${sourceDetail}`,
				toolName: "bash",
				decision: "accept",
				sourceDetail,
				permissionMode: "auto",
			})
		}

		ctx.flushLogBuffer()

		await vi.waitFor(() => {
			const events = logEvents(globalThis.fetch as ReturnType<typeof vi.fn>).filter(
				(e) => e.eventName === TOOL_DECISION_EVENT,
			)
			expect(events).toHaveLength(cases.length)
		})
		const events = logEvents(globalThis.fetch as ReturnType<typeof vi.fn>).filter(
			(e) => e.eventName === TOOL_DECISION_EVENT,
		)
		for (const [sourceDetail, decisionSource] of cases) {
			const event = events.find((e) => e.attrs.source_detail === sourceDetail)
			expect(event?.attrs.decision_source).toBe(decisionSource)
		}
	})

	it("reports the requested virtual id for a routed-virtual session", async () => {
		// Under backend routing the assistant message keeps the requested virtual
		// id in `message.model` (the concrete pick lives in `responseModel`), so
		// `currentModel` IS the user's selection — `auto` or `auto-beta` — and the
		// accept-rate record reports it verbatim.
		const ctx = new TelemetryContext(makeConfig())
		ctx.currentModel = "auto-beta"
		handleToolDecision(ctx, {
			toolCallId: "tc-routed",
			toolName: "bash",
			decision: "accept",
			sourceDetail: "allow_once",
			permissionMode: "default",
		})

		ctx.flushLogBuffer()

		let event: ReturnType<typeof logEvents>[number] | undefined
		await vi.waitFor(() => {
			event = logEvents(globalThis.fetch as ReturnType<typeof vi.fn>).find((e) => e.eventName === TOOL_DECISION_EVENT)
			expect(event).toBeDefined()
		})
		expect(event?.attrs.model).toBe("auto-beta")
	})

	it("reports the concrete model for manual selections", async () => {
		const ctx = new TelemetryContext(makeConfig())
		ctx.currentModel = "kimi-k2.6"
		handleToolDecision(ctx, {
			toolCallId: "tc-manual",
			toolName: "bash",
			decision: "accept",
			sourceDetail: "allow_once",
			permissionMode: "default",
		})

		ctx.flushLogBuffer()

		let event: ReturnType<typeof logEvents>[number] | undefined
		await vi.waitFor(() => {
			event = logEvents(globalThis.fetch as ReturnType<typeof vi.fn>).find((e) => e.eventName === TOOL_DECISION_EVENT)
			expect(event).toBeDefined()
		})
		expect(event?.attrs.model).toBe("kimi-k2.6")
	})

	it("forwards mode-flap diagnostics: repeated-source count and a validated, sorted, deduplicated source set", async () => {
		const ctx = new TelemetryContext(makeConfig())
		handleToolDecision(ctx, {
			toolCallId: "tc-flap",
			toolName: "bash",
			decision: "reject",
			sourceDetail: "mode_flap",
			permissionMode: "default",
			modeFlap: {
				// Repeated sources are counted per dismissal (4) but exported as a
				// sorted, deduplicated set bounded by the enum size.
				modeChangeCount: 4,
				modeChangeSources: ["controller", "user_shift_tab", "controller", "questionnaire_promotion"],
			},
		})

		ctx.flushLogBuffer()

		let event: ReturnType<typeof logEvents>[number] | undefined
		await vi.waitFor(() => {
			event = logEvents(globalThis.fetch as ReturnType<typeof vi.fn>).find((e) => e.eventName === TOOL_DECISION_EVENT)
			expect(event).toBeDefined()
		})
		expect(event?.attrs.source_detail).toBe("mode_flap")
		expect(event?.attrs.mode_change_count).toBe("4")
		expect(event?.attrs.mode_change_sources).toBe("controller,questionnaire_promotion,user_shift_tab")
	})

	it("drops out-of-contract mode-change sources instead of exporting them", async () => {
		const ctx = new TelemetryContext(makeConfig())
		handleToolDecision(ctx, {
			toolCallId: "tc-flap-bad",
			toolName: "bash",
			decision: "reject",
			sourceDetail: "mode_flap",
			permissionMode: "default",
			modeFlap: {
				modeChangeCount: 2,
				modeChangeSources: ["controller", "not-a-real-reason"],
			},
		})
		// modeFlap diagnostics on non-mode-flap decisions are not forwarded.
		handleToolDecision(ctx, {
			toolCallId: "tc-flap-other",
			toolName: "bash",
			decision: "reject",
			sourceDetail: "plan_gate",
			permissionMode: "plan",
			modeFlap: { modeChangeCount: 9, modeChangeSources: ["controller"] },
		})

		ctx.flushLogBuffer()

		await vi.waitFor(() => {
			const events = logEvents(globalThis.fetch as ReturnType<typeof vi.fn>).filter(
				(e) => e.eventName === TOOL_DECISION_EVENT,
			)
			expect(events).toHaveLength(2)
		})
		const events = logEvents(globalThis.fetch as ReturnType<typeof vi.fn>).filter(
			(e) => e.eventName === TOOL_DECISION_EVENT,
		)
		const flap = events.find((e) => e.attrs.tool_use_id === "tc-flap-bad")
		expect(flap?.attrs.mode_change_sources).toBe("controller")
		expect(flap?.attrs.mode_change_count).toBe("2")
		const other = events.find((e) => e.attrs.tool_use_id === "tc-flap-other")
		expect(other?.attrs.mode_change_count).toBeUndefined()
		expect(other?.attrs.mode_change_sources).toBeUndefined()
	})

	it("marks nested decisions with nested=true and parent_tool_use_id", async () => {
		const ctx = new TelemetryContext(makeConfig())
		handleToolDecision(ctx, {
			toolCallId: "cm-1/2",
			toolName: "bash",
			decision: "reject",
			sourceDetail: "classifier_no_ui",
			permissionMode: "auto",
			parentToolCallId: "cm-1",
		})

		ctx.flushLogBuffer()

		let event: ReturnType<typeof logEvents>[number] | undefined
		await vi.waitFor(() => {
			event = logEvents(globalThis.fetch as ReturnType<typeof vi.fn>).find((e) => e.eventName === TOOL_DECISION_EVENT)
			expect(event).toBeDefined()
		})
		expect(event?.attrs.nested).toBe("true")
		expect(event?.attrs.parent_tool_use_id).toBe("cm-1")
		expect(event?.attrs.permission_mode).toBe("auto")
	})

	it("omits the nested attrs for direct decisions", async () => {
		const ctx = new TelemetryContext(makeConfig())
		handleToolDecision(ctx, {
			toolCallId: "tc-direct",
			toolName: "bash",
			decision: "accept",
			sourceDetail: "allow_once",
			permissionMode: "default",
		})

		ctx.flushLogBuffer()

		let event: ReturnType<typeof logEvents>[number] | undefined
		await vi.waitFor(() => {
			event = logEvents(globalThis.fetch as ReturnType<typeof vi.fn>).find((e) => e.eventName === TOOL_DECISION_EVENT)
			expect(event).toBeDefined()
		})
		expect(event?.attrs.nested).toBeUndefined()
		expect(event?.attrs.parent_tool_use_id).toBeUndefined()
	})

	it("skips malformed payloads instead of emitting partial events", async () => {
		const ctx = new TelemetryContext(makeConfig())
		const valid = {
			toolCallId: "tc-1",
			toolName: "bash",
			decision: "accept",
			sourceDetail: "rule",
			permissionMode: "default",
		}
		for (const bad of [
			undefined,
			{},
			{ ...valid, toolCallId: undefined },
			{ ...valid, toolCallId: "" },
			{ ...valid, toolName: undefined },
			{ ...valid, decision: undefined },
			{ ...valid, decision: "maybe" },
			{ ...valid, sourceDetail: undefined },
			{ ...valid, sourceDetail: "made_up" },
			{ ...valid, sourceDetail: "toString" },
			{ ...valid, permissionMode: undefined },
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
