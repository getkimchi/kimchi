import type { AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui"
import { describe, expect, it, vi } from "vitest"
import {
	createMcpPromptAutocompleteProvider,
	type McpPromptAutocompleteState,
} from "../../../node_modules/pi-mcp-adapter/prompt-autocomplete.ts"

// A compiled-adapter contract test: these helpers stay internal to that package
// and have no public export map entry. The adapter's dist/input sources can change,
// so this path is deliberately re-verified during adapter upgrades.
const COMMAND_NAME = "mcp__fixture__hello-world"

function createState(options: { configured?: boolean; disabled?: boolean } = {}): McpPromptAutocompleteState {
	const { configured = true, disabled = false } = options
	return {
		config: {
			mcpServers: configured ? { fixture: { command: "fixture", disabled } } : {},
		},
		promptMetadata: new Map([
			[
				"fixture",
				[
					{
						serverName: "fixture",
						originalName: "hello-world",
						commandName: COMMAND_NAME,
						description: "Greet a topic",
						arguments: [{ name: "topic", description: "Topic" }],
					},
				],
			],
		]),
	}
}

function createProvider(
	state: McpPromptAutocompleteState,
	options: {
		resolveInvocation?: (commandName: string) => string | null
		baseSuggestions?: AutocompleteSuggestions | null
	} = {},
) {
	const { resolveInvocation = (commandName) => commandName, baseSuggestions = null } = options
	const base: AutocompleteProvider = {
		getSuggestions: vi.fn(async () => baseSuggestions),
		applyCompletion: vi.fn(() => ({ lines: ["accepted"], cursorLine: 0, cursorCol: 0 })),
	}
	const provider = createMcpPromptAutocompleteProvider(() => state, base, resolveInvocation)
	return { base, provider }
}

async function completions(provider: AutocompleteProvider, input: string) {
	return provider.getSuggestions([input], 0, input.length, { signal: new AbortController().signal, force: false })
}

describe("live MCP prompt autocomplete", () => {
	it.each([
		{ configured: false },
		{ configured: true, disabled: true },
	])("does not advertise disposed/disabled servers (%o)", async (settings) => {
		const { provider } = createProvider(createState(settings))

		expect(await completions(provider, "/mcp__")).toBeNull()
		expect(await completions(provider, `${COMMAND_NAME} t`)).toBeNull()
	})

	it("fails closed for ambiguous invocation names, including arguments", async () => {
		const { provider } = createProvider(createState(), { resolveInvocation: () => null })

		expect(await completions(provider, "/mcp__")).toBeNull()
		expect(await completions(provider, `${COMMAND_NAME} t`)).toBeNull()
	})

	it("dedupes an owned invocation that the base provider already listed", async () => {
		const baseSuggestions = {
			items: [{ value: COMMAND_NAME, label: COMMAND_NAME }],
			prefix: "/mcp__fixture__hello-w",
		}
		const { provider } = createProvider(createState(), { baseSuggestions })

		expect(await completions(provider, "/mcp__fixture__hello-w")).toBe(baseSuggestions)
	})

	it("forwards the selected row and its slash prefix to base.applyCompletion", async () => {
		const { base, provider } = createProvider(createState())
		const suggestions = await completions(provider, "/mcp__fixture__he")
		expect(suggestions?.items).toHaveLength(1)
		expect(suggestions?.prefix).toBe("/mcp__fixture__he")

		const selected = suggestions?.items[0]
		if (!suggestions || !selected) throw new Error("Expected the live prompt row")
		const input = "/mcp__fixture__he"
		const completion = provider.applyCompletion([input], 0, input.length, selected, suggestions.prefix)
		expect(completion).toEqual({ lines: ["accepted"], cursorLine: 0, cursorCol: 0 })
		expect(base.applyCompletion).toHaveBeenCalledWith([input], 0, input.length, selected, suggestions.prefix)
	})
})
