/**
 * Rendered-behavior tests for the /model selector capability table patch
 * (MODEL | PROVIDER | CONTEXT | VISION | DESCRIPTION columns).
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
import { visibleWidth } from "@earendil-works/pi-tui"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { ModelSelectorComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/model-selector.js"
import { MULTI_MODEL_DEPRECATION_LABEL } from "./extensions/auto-model/constants.js"
import { installModelTableRenderer, renderModelTable } from "./model-selector-table.js"

beforeAll(() => {
	initTheme("default")
	installModelTableRenderer()
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
		// pi-tui's Terminal exposes `columns` (the patched selector's fallback
		// chain mirrors this).
		terminal: { columns: options.cols ?? 120, rows: 40 },
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
	// Candidate rows carry a ✓/✗ VISION cell, optionally followed by the
	// DESCRIPTION column (two-space separator + content).
	return lines.filter((l) => /[✓✗](\u0020\u0020.*)?$/.test(l.trimEnd()))
}

describe("/model selector capability table (installed patch)", () => {
	it("budgets Unicode identifiers and descriptions by terminal cells", () => {
		const rows = [
			{
				model: KIMI,
				id: "視覚モデル".repeat(20),
				provider: "提供者".repeat(20),
				selected: true,
				description: "画像認識モデル".repeat(20),
				warning: true,
				annotation: "⚠ compact first",
			},
		]
		for (const width of [8, 20, 34, 50, 80, 120]) {
			for (const vision of [false, true]) {
				const lines = renderModelTable(rows, width, { fg: (_color, text) => text }, vision)
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width)
				if (width >= 20) expect(lines[1]).toContain("⚠")
			}
		}
	})
	it("renders MODEL | PROVIDER | CONTEXT | VISION header and per-row values", () => {
		const { renderPlain } = makeSelector({})
		const lines = renderPlain(100)
		const header = lines.find((l) => l.includes("MODEL") && l.includes("PROVIDER"))
		expect(header).toBeDefined()
		expect(header).toContain("CONTEXT")
		expect(header).toContain("VISION")
		expect(header).toContain("DESCRIPTION")

		const rows = modelRows(lines)
		expect(rows).toHaveLength(3)
		expect(rows.some((r) => r.includes("kimi-k2.6"))).toBe(true)
		expect(rows.some((r) => r.includes("kimchi-dev"))).toBe(true)
		expect(rows.some((r) => r.includes("anthropic"))).toBe(true)
	})

	it("humanizes context windows left-aligned (200k, 128k, 1M)", () => {
		withDescriptions(
			{
				"kimchi-dev/kimi-k2.6": "Flagship vision model.",
				"kimchi-dev/glm-5.3": "Balanced everyday model.",
				"anthropic/claude-sonnet-4-20250514": "Frontier general model.",
			},
			() => {
				const { renderPlain } = makeSelector({})
				const rows = modelRows(renderPlain(120))
				const contextValues = rows.map((r) => r.trimEnd().match(/\b(200k|128k|1M)\b/)?.[1])
				expect(contextValues).toContain("200k")
				expect(contextValues).toContain("128k")
				expect(contextValues).toContain("1M")
				// Aligned: every description starts at the same column, so the
				// context/VISION/description columns line up across rows (the ✓ next to
				// the cursor is the current-model marker, not the VISION cell).
				const descs = ["Flagship vision model.", "Balanced everyday model.", "Frontier general model."]
				const descStarts = new Set(rows.map((r) => descs.map((d) => r.indexOf(d)).find((i) => i >= 0)))
				expect(descStarts.size).toBe(1)
			},
		)
	})

	it("shows ✓ for vision models and ✗ for text-only models", () => {
		withDescriptions(
			{
				"kimchi-dev/kimi-k2.6": "Flagship vision model.",
				"kimchi-dev/glm-5.3": "Balanced everyday model.",
				"anthropic/claude-sonnet-4-20250514": "Frontier general model.",
			},
			() => {
				const { renderPlain } = makeSelector({})
				const rows = modelRows(renderPlain(120))
				const glmRow = rows.find((r) => r.includes("glm-5.3"))
				const kimiRow = rows.find((r) => r.includes("kimi-k2.6"))
				// The VISION cell sits between the context and description columns.
				expect(glmRow).toMatch(/✗ {7}Balanced/)
				expect(kimiRow).toMatch(/✓ {7}Flagship/)
			},
		)
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
		__kimchiModelDescriptions?: Map<string, string>
	}
	const patchedProcess = process as PatchedProcess

	/** Sets the description registry around a test body, restoring it after. */
	function withDescriptions(entries: Record<string, string>, body: () => void): void {
		patchedProcess.__kimchiModelDescriptions = new Map(Object.entries(entries))
		try {
			body()
		} finally {
			patchedProcess.__kimchiModelDescriptions = undefined
		}
	}

	it("the virtual multi-model row inherits its orchestrator's context/vision stats", () => {
		patchedProcess.__kimchiOrchestratorRef = new Map([["mm-session", "kimchi-dev/kimi-k2.6"]])
		patchedProcess.__kimchiMultiModelEnabled = new Map([["mm-session", false]])
		try {
			withDescriptions({ "kimchi-dev/kimi-k2.6": "Flagship vision model." }, () => {
				const { renderPlain } = makeSelector({ sessionId: "mm-session" })
				const rows = modelRows(renderPlain(120))
				const multiRow = rows.find((r) => r.includes("multi-model"))
				expect(multiRow).toBeDefined()
				expect(multiRow).toContain("orchestration")
				// Orchestrator (kimi-k2.6) stats: 200k context, vision ✓. Its
				// description follows the harness-side deprecation label.
				expect(multiRow).toMatch(/✓ {7}\[Deprecated\]/)
				expect(multiRow).toContain("Flagship vision model.")
				expect(multiRow).toContain("200k")
			})
		} finally {
			patchedProcess.__kimchiOrchestratorRef = undefined
			patchedProcess.__kimchiMultiModelEnabled = undefined
		}
	})

	it("labels the virtual multi-model row as deprecated", () => {
		// The deprecation label is harness-side: multi-model does not exist in
		// the platform catalog, so no backend marker can carry it. It outranks
		// the default-model annotation and keeps the orchestrator description.
		//
		// This is THE cross-surface pin: the patch renders a literal it cannot
		// import from harness source, so the row produced by the patched
		// selector is asserted against MULTI_MODEL_DEPRECATION_LABEL itself —
		// any drift between patch literal and constant fails here.
		patchedProcess.__kimchiOrchestratorRef = new Map([["mm-session", "kimchi-dev/kimi-k2.6"]])
		try {
			withDescriptions({ "kimchi-dev/kimi-k2.6": "Flagship vision model." }, () => {
				const { renderPlain } = makeSelector({
					sessionId: "mm-session",
					// The saved default is the orchestrator model — the patch would
					// annotate the multi-model row "Default for new sessions." too.
					defaultModel: { provider: "kimchi-dev", id: "kimi-k2.6" },
				})
				const multiRow = modelRows(renderPlain(120)).find((r) => r.includes("multi-model"))
				expect(multiRow).toBeDefined()
				expect(multiRow).toContain(MULTI_MODEL_DEPRECATION_LABEL)
				expect(multiRow).not.toContain("Default for new sessions.")
				expect(multiRow).toContain("Flagship vision model.")
			})
		} finally {
			patchedProcess.__kimchiOrchestratorRef = undefined
		}
	})

	it("truncates the description column first on narrow terminals", () => {
		withDescriptions(
			{
				"anthropic/claude-sonnet-4-20250514": "Frontier general model for hard problems.",
				"kimchi-dev/kimi-k2.6": "Flagship vision model.",
				"kimchi-dev/glm-5.3": "Balanced everyday model.",
			},
			() => {
				const { renderPlain } = makeSelector({ cols: 50 })
				const rows = modelRows(renderPlain(100))
				const claudeRow = rows.find((r) => r.includes("claude-sonnet"))
				expect(claudeRow).toBeDefined()
				// The description column hides entirely; provider truncates next
				// (anthropic → anthrop…); the model id is kept whole.
				expect(claudeRow).not.toContain("Frontier")
				expect(claudeRow).toContain("an…")
				expect(claudeRow).toContain("claude-sonnet-4-20250514")
				expect(claudeRow).toContain("1M")
			},
		)
	})

	it("DESCRIPTION combines the default annotation with the model description", () => {
		// Default + description → "Default for new sessions. <desc>";
		// description only (not default) → "<desc>".
		withDescriptions(
			{
				"kimchi-dev/kimi-k2.6": "Flagship vision model.",
				"kimchi-dev/glm-5.3": "Balanced everyday model.",
				"anthropic/claude-sonnet-4-20250514": "Frontier general model.",
			},
			() => {
				const { renderPlain } = makeSelector({ defaultModel: { provider: "kimchi-dev", id: "kimi-k2.6" } })
				const rows = modelRows(renderPlain(120))
				const kimiRow = rows.find((r) => r.includes("kimi-k2.6"))
				const glmRow = rows.find((r) => r.includes("glm-5.3"))
				expect(kimiRow).toContain("Default for new sessions. Flagship vision model.")
				expect(glmRow).toContain("Balanced everyday model.")
				expect(glmRow).not.toContain("Default for new sessions.")
			},
		)

		// Default without description → the annotation alone; neither → empty.
		withDescriptions({}, () => {
			const { renderPlain } = makeSelector({ defaultModel: { provider: "kimchi-dev", id: "kimi-k2.6" } })
			const rows = modelRows(renderPlain(120))
			const kimiRow = rows.find((r) => r.includes("kimi-k2.6"))
			const glmRow = rows.find((r) => r.includes("glm-5.3"))
			expect(kimiRow).toContain("Default for new sessions.")
			expect(kimiRow).not.toContain("Default for new sessions. .")
			expect(glmRow).not.toContain("Default for new sessions.")
		})
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
		expect(updateList).toContain("__kimchiRenderModelTable")
		expect(updateList).toContain("__kimchiModelDescriptions")
		expect(updateList).toContain('"Default for new sessions."')
	})
})

// Keep vi referenced for the future use of mocks in this file's helpers.
void vi
