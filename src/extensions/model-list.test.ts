import type { Api, Model } from "@earendil-works/pi-ai"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "./__mocks__/context.js"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import { AUTO_MODEL_DESCRIPTION, AUTO_MODEL_PI_NAME } from "./auto-model/constants.js"
import { clearAutoRoutingState, setAutoRoutingState } from "./auto-model/state.js"
import modelListExtension, {
	formatCurrentModelLine,
	formatModelListingLine,
	MODEL_LISTING_HEADER,
	modelRefFromModel,
	resolveModelDescription,
} from "./model-list.js"
import type { ModelCapabilities } from "./orchestration/model-registry/types.js"

type ModelEntry = {
	id: string
	provider: string
	name: string
	input?: ("text" | "image")[]
	contextWindow?: number
	reasoning?: boolean
}

// Fixture ids are deliberately outside MODEL_CAPABILITIES (and described only
// via the name " — " sentinel) so the listing output is deterministic without
// depending on a populated description registry.
const MODELS: ModelEntry[] = [
	{
		id: "gemini-3-pro",
		provider: "google",
		name: "Gemini 3 Pro",
		input: ["text", "image"],
		contextWindow: 1_000_000,
		reasoning: false,
	},
	{
		id: "auto",
		provider: "kimchi-dev",
		name: AUTO_MODEL_PI_NAME,
		input: ["text"],
		contextWindow: 200_000,
		reasoning: true,
	},
	{
		id: "kimi-k9",
		provider: "kimchi-dev",
		name: "Kimi K9",
		input: ["text", "image"],
		contextWindow: 400_000,
		reasoning: true,
	},
]

function toModel(entry: ModelEntry): Model<Api> {
	return {
		provider: entry.provider,
		id: entry.id,
		name: entry.name,
		input: entry.input ?? ["text"],
		contextWindow: entry.contextWindow ?? 100_000,
		reasoning: entry.reasoning ?? true,
	} as unknown as Model<Api>
}

type ToolResult = { content: Array<{ type: string; text: string }>; details: unknown }

function createHarness(models: ModelEntry[], currentModel?: ModelEntry) {
	const { api, getRegisteredTool } = createExtensionApi()
	modelListExtension(api)
	const tool = getRegisteredTool("list_models")
	const ctx = createContext({
		modelRegistry: { getAvailable: () => models.map(toModel) },
		model: currentModel ? toModel(currentModel) : undefined,
	})
	const exec = async (): Promise<ToolResult> =>
		(await tool.execute("test-call-id", {}, undefined, undefined, ctx)) as unknown as ToolResult
	return { exec }
}

function textOf(result: ToolResult): string {
	return result.content.map((c) => c.text).join("\n")
}

// Routing state is module-global and keyed by session; createContext always
// uses "test-session", so reset it between tests to keep formatCurrentModelLine
// deterministic.
beforeEach(() => {
	clearAutoRoutingState("test-session")
})

const caps = (description: string): ModelCapabilities =>
	({ vision: true, reasoning: true, tier: "standard", description }) as ModelCapabilities

describe("modelListExtension", () => {
	it("registers a single list_models tool with the documented metadata", () => {
		const { api, getRegisteredTool } = createExtensionApi()
		modelListExtension(api)
		const tool = getRegisteredTool("list_models")
		expect(tool.name).toBe("list_models")
		expect(tool.label).toBe("List Models")
		expect(tool.description).toContain("ref")
		expect(tool.description).toContain("set_model")
		expect(tool.parameters).toBeDefined()
	})

	it("renders a header row plus one line per available model, sorted by ref, with the current model header", async () => {
		const { exec } = createHarness(MODELS, MODELS[2])
		const result = await exec()

		expect(textOf(result)).toBe(
			[
				"Current model: kimchi-dev/kimi-k9",
				"",
				MODEL_LISTING_HEADER,
				"google/gemini-3-pro | 1000000 | yes | no",
				`kimchi-dev/auto | 200000 | no | yes | ${AUTO_MODEL_DESCRIPTION}`,
				"kimchi-dev/kimi-k9 | 400000 | yes | yes",
			].join("\n"),
		)
		expect(result.details).toBeNull()
	})

	it("treats auto as any other model: registry values only, no resolved/routed model shown", async () => {
		const { exec } = createHarness([MODELS[1]])
		const result = await exec()
		const text = textOf(result)

		expect(text).toContain(`kimchi-dev/auto | 200000 | no | yes | ${AUTO_MODEL_DESCRIPTION}`)
		// The conservative catalog-floor characteristics, not the routed pick.
		expect(text).not.toContain("routed to")
		expect(text).not.toContain("resolved")
	})

	it("shows the resolved model in the Current model line when the active model is auto", async () => {
		setAutoRoutingState("test-session", {
			status: "resolved",
			requestedId: "auto",
			model: toModel({ id: "kimi-k3", provider: "kimchi-dev", name: "Kimi K3" }),
		})
		const { exec } = createHarness([MODELS[1]], MODELS[1])
		const result = await exec()
		const text = textOf(result)

		expect(text).toContain("Current model: kimchi-dev/auto (routed to: kimchi-dev/kimi-k3)")
		// The auto row itself stays plain — routing info lives only in the header.
		expect(text).toContain(`kimchi-dev/auto | 200000 | no | yes | ${AUTO_MODEL_DESCRIPTION}`)
	})

	it("omits the current model header when the session has no model", async () => {
		const { exec } = createHarness(MODELS)
		const result = await exec()
		expect(textOf(result)).not.toContain("Current model:")
	})

	it("returns a message when the registry is empty", async () => {
		const { exec } = createHarness([])
		const result = await exec()
		expect(textOf(result)).toBe("No models available.")
	})

	describe("resolveModelDescription", () => {
		const model = toModel(MODELS[0])

		it("prefers the selector description registry over the capability knowledge base", () => {
			const registered = vi.fn(() => "backend description")
			expect(resolveModelDescription(model, registered, new Map([["gemini-3-pro", caps("kb description")]]))).toBe(
				"backend description",
			)
			expect(registered).toHaveBeenCalledWith("google/gemini-3-pro")
		})

		it("falls back to the capability knowledge base when no backend description exists", () => {
			const registered = vi.fn(() => undefined)
			const kb = new Map([["gemini-3-pro", caps("kb description")]])
			expect(resolveModelDescription(model, registered, kb)).toBe("kb description")
		})

		it('skips "ignored" capability entries and falls through to the name suffix', () => {
			const registered = vi.fn(() => undefined)
			const kb = new Map<string, ModelCapabilities | "ignored">([["gemini-3-pro", "ignored"]])
			const suffixed = toModel({ ...MODELS[1] }) // name carries " — description"
			expect(resolveModelDescription(suffixed, registered, kb)).toBe(AUTO_MODEL_DESCRIPTION)
		})

		it('uses the " — " name suffix when nothing else describes the model', () => {
			const registered = vi.fn(() => undefined)
			const suffixed = toModel({ ...MODELS[1] })
			expect(resolveModelDescription(suffixed, registered, new Map())).toBe(AUTO_MODEL_DESCRIPTION)
		})

		it("returns undefined when no description source matches", () => {
			const registered = vi.fn(() => undefined)
			expect(resolveModelDescription(model, registered, new Map())).toBeUndefined()
		})
	})

	describe("formatModelListingLine", () => {
		it("omits the description segment when none is available", () => {
			const line = formatModelListingLine(toModel({ id: "m1", provider: "p", name: "M1" }))
			expect(line).toBe("p/m1 | 100000 | no | yes")
		})

		it("collapses whitespace and truncates over-long descriptions to one line", () => {
			const long = `line one\nline two   \n${"word ".repeat(50)}`
			const described = toModel(MODELS[0])
			const line = formatModelListingLine(described, long)

			expect(line.startsWith("google/gemini-3-pro | 1000000 | yes | no | line one line two ")).toBe(true)
			expect(line.endsWith("…")).toBe(true)
			expect(line).not.toContain("\n")
			expect(line.split(" | ")[4]?.length).toBe(160)
		})

		it("lists the model column labels in the header row", () => {
			expect(MODEL_LISTING_HEADER).toBe("model | context | vision | reasoning | description")
		})
	})

	describe("formatCurrentModelLine", () => {
		it("is bare for non-auto models", () => {
			expect(formatCurrentModelLine(toModel(MODELS[0]), "test-session")).toBe("Current model: google/gemini-3-pro")
		})

		it("is bare for auto when no routing state is resolved", () => {
			expect(formatCurrentModelLine(toModel(MODELS[1]), "test-session")).toBe("Current model: kimchi-dev/auto")
		})

		it("includes the resolved model for a resolved auto session", () => {
			setAutoRoutingState("test-session", {
				status: "resolved",
				requestedId: "auto",
				model: toModel({ id: "kimi-k3", provider: "kimchi-dev", name: "Kimi K3" }),
			})
			expect(formatCurrentModelLine(toModel(MODELS[1]), "test-session")).toBe(
				"Current model: kimchi-dev/auto (routed to: kimchi-dev/kimi-k3)",
			)
		})
	})

	it("modelRefFromModel builds the provider/id ref", () => {
		expect(modelRefFromModel(toModel({ id: "auto", provider: "kimchi-dev", name: "Auto" }))).toBe("kimchi-dev/auto")
	})
})
