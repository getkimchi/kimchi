/**
 * Rendered-behavior tests for the /model selector capability table patch
 * (MODEL | PROVIDER | CONTEXT | IMG columns).
 *
 * The tests exercise the INSTALLED, patched selector component — the package's
 * exports map covers neither deep dist paths, so the component is imported
 * through its node_modules file path directly (same pattern as
 * src/extensions/stale-ctx.test.ts). Assertions run against rendered text so a
 * patch that compiles but renders wrong still fails; the source-level hunk
 * location is additionally cross-checked so a rebase that relocates the hunk
 * onto the wrong method fails fast (see src/login-selector-scope.test.ts for
 * the precedent of a silently-misplaced hunk).
 */

import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { Api, Model } from "@earendil-works/pi-ai"
import { initTheme } from "@earendil-works/pi-coding-agent"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { ModelSelectorComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/model-selector.js"

beforeAll(() => {
	initTheme("default")
})

// biome-ignore lint/suspicious/noControlCharactersInRegex: test-only helper
const ANSI_RE = /\x1b\[[0-9;]*m/g
const stripAnsi = (s: string): string => s.replace(ANSI_RE, "")

function makeModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		provider: "kimchi-dev",
		id: "model",
		name: "Model",
		api: "openai-completions",
		contextWindow: 200_000,
		maxTokens: 16_384,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...overrides,
	} as Model<Api>
}

const KIMI = makeModel({ id: "kimi-k2.6", contextWindow: 200_000 })
const GLM = makeModel({ id: "glm-5.3", contextWindow: 128_000, input: ["text"] })
const CLAUDE = makeModel({
	provider: "anthropic",
	id: "claude-sonnet-4-20250514",
	name: "Claude",
	contextWindow: 1_000_000,
})

interface Harness {
	component: ModelSelectorComponent
	renderPlain: (width?: number) => string[]
}

function makeSelector(options: {
	models?: Model<Api>[]
	current?: Model<Api>
	scopedModels?: Model<Api>[]
	cols?: number
	defaultModel?: { provider: string; id: string }
	sessionId?: string
}): Harness {
	const models = options.models ?? [KIMI, GLM, CLAUDE]
	const current = options.current ?? KIMI
	const runtime = {
		getAvailableSnapshot: () => models,
		getModel: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
		getError: () => null,
		// Never settles: keeps the constructor's background refresh inert.
		refresh: () => new Promise(() => {}),
	}
	const tui = {
		requestRender: () => {},
		terminal: { cols: options.cols ?? 120, rows: 40 },
	}
	const scopedModels = (options.scopedModels ?? []).map((model) => ({ model }))
	// The sessionId parameter is a kimchi-patch addition the package's .d.ts
	// does not declare, so the patched constructor is invoked untyped.
	const SelectorCtor = ModelSelectorComponent as unknown as new (...args: unknown[]) => ModelSelectorComponent
	const component = new SelectorCtor(
		tui,
		current,
		runtime,
		scopedModels,
		() => {},
		() => {},
		undefined,
		() => {},
		options.defaultModel,
		options.sessionId ?? "test-session",
	)
	return {
		component,
		renderPlain: (width = 100) => component.render(width).map(stripAnsi),
	}
}

function modelRows(lines: string[]): string[] {
	// Candidate rows carry a ✓/✗ IMG cell; the header labels MODEL.
	return lines.filter((l) => /[✓✗]\s*(· default)?\s*$/.test(l.trimEnd()))
}

describe("/model selector capability table (installed patch)", () => {
	it("renders MODEL | PROVIDER | CONTEXT | IMG header and per-row values", () => {
		const { renderPlain } = makeSelector({})
		const lines = renderPlain(100)
		const header = lines.find((l) => l.includes("MODEL") && l.includes("PROVIDER"))
		expect(header).toBeDefined()
		expect(header).toContain("CONTEXT")
		expect(header).toContain("IMG")

		const rows = modelRows(lines)
		expect(rows).toHaveLength(3)
		expect(rows.some((r) => r.includes("kimi-k2.6"))).toBe(true)
		expect(rows.some((r) => r.includes("kimchi-dev"))).toBe(true)
		expect(rows.some((r) => r.includes("anthropic"))).toBe(true)
	})

	it("humanizes context windows right-aligned (200k, 128k, 1M)", () => {
		const { renderPlain } = makeSelector({})
		const rows = modelRows(renderPlain(100))
		const contextValues = rows.map((r) => r.trimEnd().match(/\b(200k|128k|1M)\b/)?.[1])
		expect(contextValues).toContain("200k")
		expect(contextValues).toContain("128k")
		expect(contextValues).toContain("1M")
		// Right-aligned: every row (badge-stripped) ends at the same column,
		// so the IMG cell and the context column line up across rows.
		const lengths = new Set(rows.map((r) => r.replace(/ · default$/, "").trimEnd().length))
		expect(lengths.size).toBe(1)
	})

	it("shows ✓ for vision models and ✗ for text-only models", () => {
		const { renderPlain } = makeSelector({})
		const rows = modelRows(renderPlain(100))
		const glmRow = rows.find((r) => r.includes("glm-5.3"))
		const kimiRow = rows.find((r) => r.includes("kimi-k2.6"))
		expect(glmRow?.trimEnd().endsWith("✗")).toBe(true)
		expect(kimiRow?.trimEnd().endsWith("✓")).toBe(true)
	})

	it("colors the ✗ marker in the warn color", () => {
		const { component } = makeSelector({})
		const raw = component.render(100)
		const glmRaw = raw.find((l) => l.includes("glm-5.3"))
		expect(glmRaw).toBeDefined()
		// The ✗ is wrapped in a color escape; the ✓ rows are unstyled.
		// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting the warn-color ANSI wrapper
		expect(glmRaw).toMatch(/\x1b\[[0-9;]*m✗/)
	})

	it("renders the same table for the scoped scope", () => {
		const { renderPlain } = makeSelector({
			scopedModels: [KIMI, GLM],
			current: GLM,
		})
		const lines = renderPlain(100)
		const header = lines.find((l) => l.includes("MODEL") && l.includes("PROVIDER"))
		expect(header).toBeDefined()
		const rows = modelRows(lines)
		expect(rows).toHaveLength(2)
		expect(rows.some((r) => r.includes("kimi-k2.6"))).toBe(true)
		expect(rows.some((r) => r.includes("glm-5.3"))).toBe(true)
	})

	type PatchedProcess = NodeJS.Process & {
		__kimchiOrchestratorRef?: Map<string, string>
		__kimchiMultiModelEnabled?: Map<string, boolean>
	}
	const patchedProcess = process as PatchedProcess

	it("the virtual multi-model row inherits its orchestrator's context/vision stats", () => {
		patchedProcess.__kimchiOrchestratorRef = new Map([["mm-session", "kimchi-dev/kimi-k2.6"]])
		patchedProcess.__kimchiMultiModelEnabled = new Map([["mm-session", false]])
		try {
			const { renderPlain } = makeSelector({ sessionId: "mm-session" })
			const rows = modelRows(renderPlain(100))
			const multiRow = rows.find((r) => r.includes("multi-model"))
			expect(multiRow).toBeDefined()
			expect(multiRow).toContain("orchestration")
			// Orchestrator (kimi-k2.6) stats: 200k context, vision ✓.
			expect(multiRow?.trimEnd().endsWith("✓")).toBe(true)
			expect(multiRow).toContain("200k")
		} finally {
			patchedProcess.__kimchiOrchestratorRef = undefined
			patchedProcess.__kimchiMultiModelEnabled = undefined
		}
	})

	it("truncates the provider column first and the model id last on narrow terminals", () => {
		const { renderPlain } = makeSelector({ cols: 50 })
		const rows = modelRows(renderPlain(100))
		const claudeRow = rows.find((r) => r.includes("claude-sonnet"))
		expect(claudeRow).toBeDefined()
		// Provider truncated (anthropic → anthrop…), model id kept whole.
		expect(claudeRow).toContain("anthrop…")
		expect(claudeRow).toContain("claude-sonnet-4-20250514")
		expect(claudeRow).toContain("1M")
	})

	it("keeps the default badge on the default model row", () => {
		const { renderPlain } = makeSelector({ defaultModel: { provider: "kimchi-dev", id: "kimi-k2.6" } })
		const rows = modelRows(renderPlain(100))
		const defaultRow = rows.find((r) => r.includes("· default"))
		expect(defaultRow).toContain("kimi-k2.6")
	})

	it("still renders the footer-only empty state when nothing matches", () => {
		const { component, renderPlain } = makeSelector({})
		component.handleInput("z")
		component.handleInput("z")
		component.handleInput("z")
		const lines = renderPlain(100)
		expect(lines.some((l) => l.includes("No matching models"))).toBe(true)
	})

	it("applies the patch hunk inside updateList of the installed dist (source cross-check)", () => {
		const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
		const distFile = resolve(
			projectRoot,
			"node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/model-selector.js",
		)
		const source = readFileSync(distFile, "utf-8")
		const updateList = source.slice(source.indexOf("updateList() {"), source.indexOf("handleSelect(model) {"))
		expect(source).toContain('import { formatTokens } from "./footer.js"')
		expect(updateList).toContain("formatTokens(item.model.contextWindow ?? 0)")
		expect(updateList).toContain("'MODEL'.padEnd(modelW)")
		expect(updateList).toContain("imgOf(item) === '✓'")
	})
})

// Keep vi referenced for the future use of mocks in this file's helpers.
void vi
