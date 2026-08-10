import type { Context } from "@earendil-works/pi-ai"
import { expect, vi } from "vitest"
import { applyCouncilPreset, DEFAULT_COUNCIL_CONFIG } from "./config.js"
import { type CouncilRuntimeDependencies, createCouncilStream as createCouncilRuntimeStream } from "./coordinator.js"
import { createModelRegistryMock, physicalModel } from "./council-test-harness.js"
import type { CompletePhysicalModel } from "./physical-invoker.js"
import type { CouncilConfig, CouncilProgressEvent } from "./schemas.js"

// A plain `import {...}; export {...}` pair for names re-exported from `council-test-harness.js` comes
// back `undefined` in this file: with a `vi.mock` present, Vitest's hoisting transform captures the
// re-export before the underlying import settles. `export ... from` (a genuine re-export declaration)
// does not have this problem, so it's used here instead of the more common two-statement form.
export { councilModel, redactObjectStringsMock, response } from "./council-test-harness.js"

// Self-hoisting registration for the shared redactor spy: see the comment on `redactObjectStringsMock`
// in `council-test-harness.js` for why this file needs its own `vi.mock` rather than relying on the
// import above.
vi.mock("../pii-redaction/redactor.js", async () => {
	const { redactObjectStringsMock } = await import("./council-test-harness.js")
	return { redactObjectStrings: redactObjectStringsMock }
})

export const COUNCIL_FAILURE = {
	content: [],
	stopReason: "error",
	errorMessage: "Council could not validate the lead response.",
}

function normalizeStructuredText(text: string, context: Context): string {
	if (!context.systemPrompt?.match(/Council (solver|analyst)|Council lead|Repair the supplied object/)) return text
	try {
		const value: unknown = JSON.parse(text)
		return value && typeof value === "object" && !Array.isArray(value) ? JSON.stringify(value) : text
	} catch {
		return text
	}
}

/** Wraps a `completeModel` fixture so any structured-stage reply it returns is minified JSON. */
export function withStrictCouncilFixtures(completeModel: CompletePhysicalModel): CompletePhysicalModel {
	return async (model, context, options, onTextDelta) => {
		const message = await completeModel(model, context, options, onTextDelta)
		return {
			...message,
			content: message.content.map((block) =>
				block.type === "text" ? { ...block, text: normalizeStructuredText(block.text, context) } : block,
			),
		}
	}
}

export function createAlwaysReviewCouncilStream(dependencies: CouncilRuntimeDependencies) {
	return createCouncilRuntimeStream({
		...dependencies,
		shouldReviewTurn: dependencies.shouldReviewTurn ?? (() => true),
		completeModel: dependencies.completeModel ? withStrictCouncilFixtures(dependencies.completeModel) : undefined,
	})
}

export function createNaturalCouncilStream(dependencies: CouncilRuntimeDependencies) {
	return createCouncilRuntimeStream({
		...dependencies,
		completeModel: dependencies.completeModel ? withStrictCouncilFixtures(dependencies.completeModel) : undefined,
	})
}

export const TEST_COUNCIL_CONFIG: CouncilConfig = {
	...applyCouncilPreset(DEFAULT_COUNCIL_CONFIG, "normal"),
	lead: { primary: DEFAULT_COUNCIL_CONFIG.lead.primary, fallbacks: [] },
	panel: DEFAULT_COUNCIL_CONFIG.panel.map((pool) => ({ primary: pool.primary, fallbacks: [] })),
	analyst: { primary: DEFAULT_COUNCIL_CONFIG.analyst.primary, fallbacks: [] },
	budget: { ...applyCouncilPreset(DEFAULT_COUNCIL_CONFIG, "normal").budget, maxRetriesPerCall: 0 },
}

/** Overrides the first `models.length` panel primaries and shrinks the active panel to that size. */
export function panelConfig(models: string[]): Pick<CouncilConfig, "panel" | "panelSize"> {
	const panel = structuredClone(TEST_COUNCIL_CONFIG.panel)
	for (const [index, primary] of models.entries()) {
		if (!panel[index]) throw new Error(`Missing panel slot for ${primary}`)
		panel[index] = { primary, fallbacks: [] }
	}
	return { panel, panelSize: models.length }
}

export function progressSignature(event: CouncilProgressEvent): string {
	if (event.type === "run_started") return event.type
	if (event.type === "run_completed") return `${event.type}:${event.outcome}`
	if (event.type === "run_failed" || event.type === "run_aborted") return `${event.type}:${event.reason}`
	if (event.type === "transaction_progress") return `${event.type}:${event.phase}`
	if ("role" in event) return `${event.type}:${event.role}${event.type === "stage_failed" ? `:${event.reason}` : ""}`
	throw new Error("Unknown Council progress event")
}

export function expectValidProgressLifecycle(events: CouncilProgressEvent[]): void {
	expect(events[0]?.type).toBe("run_started")
	expect(events.at(-1)?.type).toMatch(/^run_(completed|failed|aborted)$/)
	const runId = events[0]?.runId
	expect(events.every((event) => event.runId === runId)).toBe(true)
	expect(events.filter((event) => /^run_(completed|failed|aborted)$/.test(event.type))).toHaveLength(1)
	const starts = events.filter((event) => event.type === "stage_started")
	const terminals = events.filter((event) => event.type === "stage_completed" || event.type === "stage_failed")
	expect(new Set(starts.map(({ stageId }) => stageId)).size).toBe(starts.length)
	expect(terminals).toHaveLength(starts.length)
	expect(new Set(terminals.map(({ stageId }) => stageId)).size).toBe(terminals.length)
	for (const start of starts) {
		const terminalIndex = events.findIndex(
			(event) => (event.type === "stage_completed" || event.type === "stage_failed") && event.stageId === start.stageId,
		)
		expect(terminalIndex).toBeGreaterThan(events.indexOf(start))
	}
	for (const event of events) {
		if ("durationMs" in event) expect(event.durationMs).toBeGreaterThanOrEqual(0)
		if (event.type === "run_completed" && event.estimatedCostUsd !== undefined) {
			expect(event.estimatedCostUsd).toBeGreaterThan(0)
		}
	}
}

export const models = new Map(
	["kimi-k2.7", "glm-5.2-fp8", "deepseek-v4-flash", "minimax-m3"].map((id) => [
		id,
		physicalModel(id, { provider: "kimchi-dev", baseUrl: "https://llm.kimchi.dev/openai/v1", reasoning: true }),
	]),
)

export const modelRegistry = createModelRegistryMock(
	models,
	"kimchi-dev",
	vi.fn(async () => ({
		ok: true as const,
		apiKey: "test-key",
		headers: { "x-test": "1" },
		env: { PHYSICAL_SCOPE: "physical" },
	})),
)
