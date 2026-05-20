/**
 * End-to-end integration test: runScopingFlow → propose_ferment_scoping → planned.
 *
 * Exercises the full single-input scoping handshake:
 *   1. runScopingFlow(ferment, pi, ctx) with a mocked ctx.ui.input returning intent.
 *   2. Agent calls propose_ferment_scoping via the registered tool with a full payload.
 *   3. ctx.ui.select returns "Continue with recommendations".
 *   4. Assert ferment.status === "planned", phases populated, pendingScope cleared.
 */

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FermentEventStore } from "../../ferment/event-store.js"
import { clearFermentCache } from "../../ferment/store.js"
import { type FermentRuntime, createDefaultFermentRuntime } from "./runtime.js"
import { clearAllPendingScopes, getPendingScope, runScopingFlow } from "./scoping.js"
import { clearAllScopingGates, clearAllStepStarts, setActive } from "./state.js"
import { registerLifecycleTools } from "./tools/lifecycle.js"

// ─── Harness ─────────────────────────────────────────────────────────────────

interface RegisteredTool {
	name: string
	// biome-ignore lint/suspicious/noExplicitAny: mock harness
	execute: (toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any, ctx?: any) => Promise<any>
}

interface ToolResult {
	content: { type: string; text: string }[]
	isError?: boolean
}

function createHarness() {
	const tempDir = mkdtempSync(join(tmpdir(), "ferment-scoping-flow-int-test-"))
	const eventStorage = new FermentEventStore(tempDir)
	const runtime: FermentRuntime = { ...createDefaultFermentRuntime(), getStorage: () => eventStorage }
	const tools = new Map<string, RegisteredTool>()

	const pi = {
		registerTool: (tool: RegisteredTool) => {
			tools.set(tool.name, tool)
		},
		sendMessage: vi.fn(),
		sendUserMessage: vi.fn(),
		appendEntry: vi.fn(),
		getActiveTools: vi.fn(() => []),
		getAllTools: vi.fn(() => []),
		setActiveTools: vi.fn(),
		getFlag: vi.fn(() => undefined),
	} as unknown as ExtensionAPI

	registerLifecycleTools(pi, runtime)

	const callTool = async (toolName: string, params: unknown, ctx?: unknown): Promise<ToolResult> => {
		const tool = tools.get(toolName)
		if (!tool) throw new Error(`Tool not found: ${toolName}`)
		return tool.execute("test-call-id", params, undefined, undefined, ctx) as Promise<ToolResult>
	}

	return { eventStorage, runtime, pi, callTool }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

let h: ReturnType<typeof createHarness>

beforeEach(() => {
	h = createHarness()
	clearFermentCache()
	clearAllStepStarts()
	clearAllScopingGates()
	clearAllPendingScopes()
	setActive(undefined)
})

afterEach(() => {
	clearFermentCache()
	clearAllStepStarts()
	clearAllScopingGates()
	clearAllPendingScopes()
	setActive(undefined)
})

const passingPlanGates = () => [
	{ id: "P1", verdict: "pass" as const, rationale: "ok", evidence: "n/a" },
	{ id: "P2", verdict: "pass" as const, rationale: "ok", evidence: "n/a" },
	{ id: "P3", verdict: "pass" as const, rationale: "ok", evidence: "n/a" },
]

describe("runScopingFlow → propose_ferment_scoping end-to-end", () => {
	it("single input → sendMessage with intent; propose_ferment_scoping → planned with 3 phases", async () => {
		// Setup
		const ferment = h.eventStorage.create("OAuth Integration")
		h.runtime.setActive(ferment)

		const selectMock = vi.fn().mockResolvedValue("Continue with recommendations")
		const ctx = {
			hasUI: true,
			ui: {
				notify: vi.fn(),
				input: vi.fn().mockResolvedValue("I want to add Google OAuth"),
				select: selectMock,
			},
		} as unknown as ExtensionCommandContext

		// Step 1: invoke runScopingFlow
		await runScopingFlow(ferment, h.pi, ctx, h.runtime)

		// Assert the breadcrumb + visible request echo + hidden planning nudge all fire.
		expect(h.pi.sendMessage).toHaveBeenCalledTimes(3)
		const requestCall = (h.pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls.find(
			(call) => (call[0] as { customType?: string }).customType === "ferment_request",
		)
		expect(requestCall?.[0]).toMatchObject({
			customType: "ferment_request",
			display: true,
			details: { intent: "I want to add Google OAuth" },
		})
		const nudgeCall = (h.pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls.find(
			(call) => (call[0] as { customType?: string }).customType === "ferment_created_nudge",
		)
		if (!nudgeCall) throw new Error("missing ferment_created_nudge call")
		const [msgArg, optArg] = nudgeCall
		expect(msgArg.customType).toBe("ferment_created_nudge")
		expect(optArg?.triggerTurn).toBe(true)
		const contentText: string = Array.isArray(msgArg.content)
			? msgArg.content.map((c: { text?: string }) => c.text ?? "").join("")
			: String(msgArg.content)
		expect(contentText).toContain("I want to add Google OAuth")
		expect(contentText).toContain(`ferment_id "${ferment.id}"`)
		expect(contentText).toContain("Do NOT call create_ferment")

		// Pending scope seeded
		expect(getPendingScope(ferment.id)).toBeDefined()

		// Step 2: simulate agent calling propose_ferment_scoping with full payload
		const proposeScopingPayload = {
			ferment_id: ferment.id,
			goal: "Users can sign in with Google OAuth",
			success_criteria: "E2E test passes for OAuth login flow",
			constraints: ["No external auth libraries beyond Google SDK"],
			assumptions: "Google API credentials are already provisioned",
			phases: [
				{ name: "Setup", goal: "Configure OAuth credentials", steps: [{ description: "Add Google SDK" }] },
				{ name: "Implement", goal: "Build login endpoint", steps: [{ description: "Create /auth/google route" }] },
				{ name: "Test", goal: "Verify end-to-end flow", steps: [{ description: "Write E2E test" }] },
			],
			questions: [
				{
					id: "q1",
					text: "Which OAuth library?",
					options: [
						{ id: "google-sdk", label: "Official Google SDK", recommended: true },
						{ id: "passport", label: "Passport.js" },
					],
				},
			],
			gates: passingPlanGates(),
		}

		const toolCtx = { ui: { select: selectMock, input: vi.fn() } }
		const result = await h.callTool("propose_ferment_scoping", proposeScopingPayload, toolCtx)

		// Tool should succeed (not error)
		if (result.isError) {
			throw new Error(`propose_ferment_scoping returned error: ${result.content[0]?.text}`)
		}

		// Step 3: assert ferment is now planned
		clearFermentCache()
		const planned = h.eventStorage.get(ferment.id)
		if (!planned) throw new Error("Ferment not found after propose_ferment_scoping")

		expect(planned.status).toBe("planned")
		expect(planned.phases).toHaveLength(3)
		expect(planned.scoping.assumptions?.answer).toBe("Google API credentials are already provisioned")

		// Pending scope should be cleared
		expect(getPendingScope(ferment.id)).toBeUndefined()
	})
})
