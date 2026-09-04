import type {
	BeforeAgentStartEvent,
	BeforeProviderRequestEvent,
	MessageEndEvent,
} from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import contextAssemblyExtension, {
	attributeComponents,
	CONTEXT_ASSEMBLY_ENTRY_TYPE,
	CONTEXT_ASSEMBLY_SCHEMA_VERSION,
	type ContextAssemblyEntry,
	extractPayloadSurface,
	sectionSizes,
} from "./context-assembly.js"

function beforeAgentStartEvent(
	systemPrompt: string,
	options: Partial<BeforeAgentStartEvent["systemPromptOptions"]> = {},
) {
	const opts = { cwd: "/tmp/project", ...options } as BeforeAgentStartEvent["systemPromptOptions"]
	return {
		type: "before_agent_start",
		prompt: "do the thing",
		systemPrompt,
		systemPromptOptions: opts,
	} as BeforeAgentStartEvent
}

function beforeProviderRequestEvent(payload: unknown) {
	return { type: "before_provider_request", payload } as BeforeProviderRequestEvent
}

/** Clean assistant message_end — the flush trigger for journaled entries. */
function messageEndEvent(role: "assistant" | "user" = "assistant", stopReason = "stop") {
	return {
		type: "message_end",
		message: { role, content: [], stopReason },
	} as unknown as MessageEndEvent
}

describe("context-assembly", () => {
	it("emits one composition entry on before_agent_start and dedups identical compositions", () => {
		const { api, getHandler, getAppendedEntries } = createExtensionApi()
		contextAssemblyExtension(api)
		const handler = getHandler<BeforeAgentStartEvent>("before_agent_start")

		const event = beforeAgentStartEvent("BASE PROMPT")
		const result = handler(event, {} as never)
		expect(result).toBeUndefined()
		getHandler<MessageEndEvent>("message_end")(messageEndEvent(), {} as never)

		const entries = getAppendedEntries<ContextAssemblyEntry>(CONTEXT_ASSEMBLY_ENTRY_TYPE)
		expect(entries).toHaveLength(1)
		expect(entries[0].schemaVersion).toBe(CONTEXT_ASSEMBLY_SCHEMA_VERSION)
		expect(entries[0].reason).toBe("composition")
		expect(entries[0].systemPrompt.chars).toBe("BASE PROMPT".length)
		expect(entries[0].systemPrompt.tokensEstimated).toBe(Math.ceil("BASE PROMPT".length / 4))
		expect(typeof entries[0].promptHash).toBe("string")
		expect(entries[0].promptHash).toHaveLength(40)

		// Identical composition → no new entry
		handler(beforeAgentStartEvent("BASE PROMPT"), {} as never)
		expect(getAppendedEntries<ContextAssemblyEntry>(CONTEXT_ASSEMBLY_ENTRY_TYPE)).toHaveLength(1)
	})

	it("emits a new composition entry when the composition changes", () => {
		const { api, getHandler, getAppendedEntries } = createExtensionApi()
		contextAssemblyExtension(api)
		const handler = getHandler<BeforeAgentStartEvent>("before_agent_start")

		handler(beforeAgentStartEvent("PROMPT A"), {} as never)
		handler(beforeAgentStartEvent("PROMPT B"), {} as never)
		getHandler<MessageEndEvent>("message_end")(messageEndEvent(), {} as never)
		const entries = getAppendedEntries<ContextAssemblyEntry>(CONTEXT_ASSEMBLY_ENTRY_TYPE)
		expect(entries).toHaveLength(2)
		expect(entries[0].promptHash).not.toBe(entries[1].promptHash)
	})

	it("attributes components: dominated category, exact arithmetic, unattributed bucket", () => {
		const { api, getHandler, getAppendedEntries } = createExtensionApi()
		contextAssemblyExtension(api)
		const handler = getHandler<BeforeAgentStartEvent>("before_agent_start")

		const prompt = `${"A".repeat(100)}FILE CONTENTXX${"B".repeat(50)}`
		handler(
			beforeAgentStartEvent(prompt, {
				contextFiles: [{ path: "AGENTS.md", content: "FILE CONTENTXX" }],
				skills: [
					{
						name: "dap-debugging",
						description: "desc",
						filePath: "p",
						baseDir: "d",
						sourceInfo: {},
						disableModelInvocation: false,
					} as never,
				],
			}),
			{} as never,
		)
		getHandler<MessageEndEvent>("message_end")(messageEndEvent(), {} as never)

		const entries = getAppendedEntries<ContextAssemblyEntry>(CONTEXT_ASSEMBLY_ENTRY_TYPE)
		const components = entries[0].components ?? []
		const charsSum = components.reduce((sum, c) => sum + c.chars, 0)
		const attributed = components.filter((c) => c.kind !== "unattributed").reduce((sum, c) => sum + c.chars, 0)
		expect(charsSum).toBe(prompt.length)
		expect(attributed).toBeLessThanOrEqual(prompt.length)

		const contextFile = components.find((c) => c.kind === "contextFile")
		expect(contextFile?.name).toBe("AGENTS.md")
		expect(contextFile?.chars).toBe("FILE CONTENTXX".length)
		expect(contextFile?.tokensEstimated).toBe(Math.ceil((contextFile?.chars ?? 0) / 4))

		const skill = components.find((c) => c.kind === "skill")
		expect(skill?.name).toBe("dap-debugging")

		expect(components.some((c) => c.kind === "unattributed")).toBe(true)
	})

	it("attributeComponents floors unattributed at zero when parts overflow", () => {
		const prompt = "tiny"
		const components = attributeComponents(prompt, {
			cwd: "/tmp",
			appendSystemPrompt: "MUCH LARGER THAN THE PROMPT ITSELF",
		} as never)
		expect(components.find((c) => c.kind === "unattributed")).toBeUndefined()
	})

	it("sectionSizes attributes prompt size by ## section with exact arithmetic", () => {
		const prompt = [
			"HEADER TEXT",
			"## Rules",
			"no rules files",
			"## Available Tools",
			"read, bash",
			"## Debugger (DAP)",
			"debugger guidance",
		].join("\n")
		const sections = sectionSizes(prompt)
		expect(sections.reduce((sum, s) => sum + s.chars, 0)).toBe(prompt.length)
		expect(sections.map((s) => s.name)).toEqual(["(intro)", "## Rules", "## Available Tools", "## Debugger (DAP)"])
		expect(sections[0].chars).toBe("HEADER TEXT".length + 1) // newline before first header
		expect(sections[1].tokensEstimated).toBe(Math.ceil(sections[1].chars / 4))
	})

	it("sectionSizes collapses a headerless prompt into the intro bucket", () => {
		const sections = sectionSizes("HEADER TEXT")
		expect(sections).toEqual([
			{ name: "(intro)", chars: "HEADER TEXT".length, tokensEstimated: Math.ceil("HEADER TEXT".length / 4) },
		])
	})

	it("includes the section size table on composition entries", () => {
		const { api, getHandler, getAppendedEntries } = createExtensionApi()
		contextAssemblyExtension(api)
		const handler = getHandler<BeforeAgentStartEvent>("before_agent_start")
		const prompt = "intro text\n## Rules\nbody"
		handler(beforeAgentStartEvent(prompt), {} as never)
		getHandler<MessageEndEvent>("message_end")(messageEndEvent(), {} as never)
		const entries = getAppendedEntries<ContextAssemblyEntry>(CONTEXT_ASSEMBLY_ENTRY_TYPE)
		expect(entries).toHaveLength(1)
		expect(entries[0].sections?.map((s) => s.name)).toEqual(["(intro)", "## Rules"])
		expect(entries[0].sections?.reduce((sum, s) => sum + s.chars, 0)).toBe(prompt.length)
	})

	it("emits a prefix-change entry with per-tool surface on the first provider request and dedups stable prefixes", () => {
		const { api, getHandler, getAppendedEntries } = createExtensionApi()
		contextAssemblyExtension(api)
		const handler = getHandler<BeforeProviderRequestEvent>("before_provider_request")

		const payload = {
			system: "SYSTEM",
			tools: [
				{
					type: "function",
					function: {
						name: "bash",
						description: "Run commands",
						parameters: { type: "object", properties: { command: { type: "string" } } },
					},
				},
			],
			messages: [],
		}
		const result = handler(beforeProviderRequestEvent(payload), {} as never)
		expect(result).toBeUndefined()
		getHandler<MessageEndEvent>("message_end")(messageEndEvent(), {} as never)

		const entries = getAppendedEntries<ContextAssemblyEntry>(CONTEXT_ASSEMBLY_ENTRY_TYPE)
		expect(entries).toHaveLength(1)
		expect(entries[0].reason).toBe("prefix-change")
		expect(entries[0].prefixHash).toHaveLength(40)
		const bash = entries[0].tools?.find((t) => t.name === "bash")
		expect(bash?.descriptionChars).toBe("Run commands".length)
		expect(bash?.schemaChars).toBeGreaterThan(0)
		expect(entries[0].toolSurface?.chars).toBe((bash?.descriptionChars ?? 0) + (bash?.schemaChars ?? 0))

		// Same payload → stable prefix → no new entry
		handler(beforeProviderRequestEvent(payload), {} as never)
		getHandler<MessageEndEvent>("message_end")(messageEndEvent(), {} as never)
		expect(getAppendedEntries<ContextAssemblyEntry>(CONTEXT_ASSEMBLY_ENTRY_TYPE)).toHaveLength(1)
	})

	it("emits a new prefix-change entry when a tool description changes mid-session (cache-break signal)", () => {
		const { api, getHandler, getAppendedEntries } = createExtensionApi()
		contextAssemblyExtension(api)
		const handler = getHandler<BeforeProviderRequestEvent>("before_provider_request")

		const mk = (desc: string) => ({
			system: "SYSTEM",
			tools: [{ name: "bash", description: desc, input_schema: { type: "object" } }],
		})
		handler(beforeProviderRequestEvent(mk("first")), {} as never)
		handler(beforeProviderRequestEvent(mk("second")), {} as never)
		getHandler<MessageEndEvent>("message_end")(messageEndEvent(), {} as never)

		const entries = getAppendedEntries<ContextAssemblyEntry>(CONTEXT_ASSEMBLY_ENTRY_TYPE)
		expect(entries).toHaveLength(2)
		expect(entries[0].prefixHash).not.toBe(entries[1].prefixHash)
	})

	it("extractPayloadSurface handles Anthropic and OpenAI shapes and degrades gracefully", () => {
		const anthropic = extractPayloadSurface({
			system: [
				{ type: "text", text: "A" },
				{ type: "text", text: "B" },
			],
			tools: [{ name: "read", description: "Read file", input_schema: { type: "object" } }],
		})
		expect(anthropic.systemText).toBe("A\nB")
		expect(anthropic.tools[0].name).toBe("read")

		const anthropicString = extractPayloadSurface({
			system: "SYS",
			tools: [{ name: "ls", description: "List", input_schema: {} }],
		})
		expect(anthropicString.systemText).toBe("SYS")

		const openai = extractPayloadSurface({
			messages: [
				{ role: "system", content: "SYS" },
				{ role: "user", content: "hi" },
			],
			tools: [{ type: "function", function: { name: "edit", description: "Edit", parameters: {} } }],
		})
		expect(openai.systemText).toBe("SYS")
		expect(openai.tools[0].name).toBe("edit")

		const unknown = extractPayloadSurface(42)
		expect(unknown.systemText).toBe("")
		expect(unknown.tools).toEqual([])
	})

	it("never mutates event inputs", () => {
		const { api, getHandler } = createExtensionApi()
		contextAssemblyExtension(api)

		const startEvent = beforeAgentStartEvent("PROMPT")
		const startSnapshot = JSON.stringify(startEvent)
		getHandler<BeforeAgentStartEvent>("before_agent_start")(startEvent, {} as never)
		expect(JSON.stringify(startEvent)).toBe(startSnapshot)

		const requestEvent = beforeProviderRequestEvent({
			system: "SYS",
			tools: [{ name: "ls", description: "List", input_schema: {} }],
		})
		const requestSnapshot = JSON.stringify(requestEvent)
		getHandler<BeforeProviderRequestEvent>("before_provider_request")(requestEvent, {} as never)
		expect(JSON.stringify(requestEvent)).toBe(requestSnapshot)
	})

	it("buffers entries until a clean assistant message_end, ignoring user and errored messages", () => {
		const { api, getHandler, getAppendedEntries } = createExtensionApi()
		contextAssemblyExtension(api)
		const onMessageEnd = getHandler<MessageEndEvent>("message_end")

		// Observed but not journaled yet — the before_* junction must stay clean.
		getHandler<BeforeAgentStartEvent>("before_agent_start")(beforeAgentStartEvent("PROMPT"), {} as never)
		expect(getAppendedEntries<ContextAssemblyEntry>(CONTEXT_ASSEMBLY_ENTRY_TYPE)).toHaveLength(0)

		onMessageEnd(messageEndEvent("user"), {} as never)
		expect(getAppendedEntries<ContextAssemblyEntry>(CONTEXT_ASSEMBLY_ENTRY_TYPE)).toHaveLength(0)
		onMessageEnd(messageEndEvent("assistant", "error"), {} as never)
		expect(getAppendedEntries<ContextAssemblyEntry>(CONTEXT_ASSEMBLY_ENTRY_TYPE)).toHaveLength(0)

		onMessageEnd(messageEndEvent(), {} as never)
		const entries = getAppendedEntries<ContextAssemblyEntry>(CONTEXT_ASSEMBLY_ENTRY_TYPE)
		expect(entries).toHaveLength(1)
		expect(entries[0].reason).toBe("composition")
	})

	it("skips toolless provider requests (summarization side-calls are not the session prefix)", () => {
		const { api, getHandler, getAppendedEntries } = createExtensionApi()
		contextAssemblyExtension(api)
		getHandler<BeforeProviderRequestEvent>("before_provider_request")(
			beforeProviderRequestEvent({ system: "You are a context summarization assistant.", messages: [] }),
			{} as never,
		)
		getHandler<MessageEndEvent>("message_end")(messageEndEvent(), {} as never)
		expect(getAppendedEntries<ContextAssemblyEntry>(CONTEXT_ASSEMBLY_ENTRY_TYPE)).toHaveLength(0)
	})
})
