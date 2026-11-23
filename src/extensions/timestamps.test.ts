import {
	AssistantMessageComponent,
	BashExecutionComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	CustomMessageComponent,
	InteractiveMode,
	initTheme,
	SkillInvocationMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent"
import { Container, visibleWidth } from "@earendil-works/pi-tui"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import {
	configureTranscriptTimestamps,
	formatTranscriptTimestamp,
	installTranscriptTimestampAdapters,
	resolveTranscriptTimezone,
} from "./timestamps.js"

const FIXED_MS = Date.parse("2026-11-23T13:04:05.000Z")
const UTC_LABEL = "2026-11-23 13:04:05 GMT+0"
const SGR_RE = new RegExp(`${"\x1b"}\\[[0-9;]*m`, "g")
const stripSgr = (line: string): string => line.replace(SGR_RE, "")

function expectTimestampRow(lines: string[], role: string, timestamp: string | undefined = UTC_LABEL): void {
	expect(timestamp).toBeDefined()
	const row = stripSgr(lines[0] ?? "")
	expect(row.startsWith(`${role} ·`)).toBe(true)
	if (timestamp) expect(row.trimEnd().endsWith(timestamp)).toBe(true)
}

interface FakeChat {
	host: object
	container: Container
}

function createFakeChat(): FakeChat {
	const host = Object.create(InteractiveMode.prototype) as object
	const container = new Container()
	Reflect.set(host, "chatContainer", container)
	Reflect.set(host, "toolOutputExpanded", false)
	Reflect.set(host, "ui", { requestRender: () => {} })
	Reflect.set(host, "getUserMessageText", (message: { content?: unknown }) => message.content ?? "")
	Reflect.set(host, "getMarkdownThemeWithSettings", () => undefined)
	Reflect.set(host, "runtimeHost", {
		session: {
			extensionRunner: {
				getMessageRenderer: () => undefined,
				getMarkdownTransformers: () => [],
			},
		},
	})
	Reflect.set(host, "editor", {})
	return { host, container }
}

function addMessage(chat: FakeChat, message: Record<string, unknown>): void {
	const add = Reflect.get(chat.host, "addMessageToChat") as (message: Record<string, unknown>) => void
	add.call(chat.host, message)
}

function createAssistantMessage(timestamp = FIXED_MS, stopReason = "stop"): Record<string, unknown> {
	return {
		role: "assistant",
		timestamp,
		stopReason,
		content: [{ type: "text", text: "Original assistant response" }],
	}
}

function createTool(): ToolExecutionComponent {
	return new ToolExecutionComponent(
		"CustomTimestampTool",
		"tc-timestamp",
		{ path: "README.md" },
		{},
		undefined,
		{ requestRender: () => {} } as never,
		"/tmp",
	)
}

beforeAll(() => {
	initTheme("default")
	installTranscriptTimestampAdapters()
	// Idempotency is important when interactive extensions are rebound.
	installTranscriptTimestampAdapters()
})

beforeEach(() => {
	configureTranscriptTimestamps({ enabled: true, timezone: "UTC" })
})

afterEach(() => {
	configureTranscriptTimestamps({ enabled: false, timezone: "local" })
	vi.useRealTimers()
})

describe("transcript timestamp formatting", () => {
	it("formats deterministic UTC and IANA-zone datetimes", () => {
		expect(formatTranscriptTimestamp(FIXED_MS, "UTC")).toBe(UTC_LABEL)
		expect(formatTranscriptTimestamp(FIXED_MS, "Europe/Kyiv")).toBe("2026-11-23 15:04:05 GMT+2")
		expect(formatTranscriptTimestamp(0, "UTC")).toBe("1970-01-01 00:00:00 GMT+0")
	})

	it("updates the offset with the selected zone's DST rules", () => {
		expect(formatTranscriptTimestamp(Date.parse("2026-01-23T13:04:05Z"), "Europe/Kyiv")).toContain("GMT+2")
		expect(formatTranscriptTimestamp(Date.parse("2026-07-23T13:04:05Z"), "Europe/Kyiv")).toContain("GMT+3")
	})

	it("uses the host timezone for local and invalid resolver input", () => {
		const systemZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
		expect(resolveTranscriptTimezone()).toBe(systemZone)
		expect(resolveTranscriptTimezone("local")).toBe(systemZone)
		expect(resolveTranscriptTimezone("Bad/Zone")).toBe(systemZone)
		expect(formatTranscriptTimestamp(FIXED_MS, "local")).toBe(formatTranscriptTimestamp(FIXED_MS, systemZone))
	})

	it("returns no label for invalid timestamps or runtime zones", () => {
		expect(formatTranscriptTimestamp(Number.NaN, "UTC")).toBeUndefined()
		expect(formatTranscriptTimestamp(Infinity, "UTC")).toBeUndefined()
		expect(formatTranscriptTimestamp(FIXED_MS, "Bad/Zone")).toBeUndefined()
	})
})

describe("message timestamp rendering", () => {
	it("is byte-identical when disabled and preserves original lines and OSC 133 markers when enabled", () => {
		const chat = createFakeChat()
		const message = { role: "user", content: "Original user prompt", timestamp: FIXED_MS }
		addMessage(chat, message)
		const component = chat.container.children.find((child) => child instanceof UserMessageComponent)
		expect(component).toBeInstanceOf(UserMessageComponent)
		if (!(component instanceof UserMessageComponent)) return

		configureTranscriptTimestamps({ enabled: false, timezone: "UTC" })
		const original = component.render(80)
		expect(original.join("\n")).not.toContain(UTC_LABEL)

		const rendered = component.render(80)
		expect(rendered).toEqual(original)
		configureTranscriptTimestamps({ enabled: true, timezone: "UTC" })
		const withTimestamp = component.render(80)
		expectTimestampRow(withTimestamp, "user")
		expect(withTimestamp[0]).not.toBe(stripSgr(withTimestamp[0] ?? ""))
		expect(withTimestamp.slice(1)).toEqual(original)
		expect(withTimestamp.join("\n")).toContain("Original user prompt")
		expect(withTimestamp.slice(1).join("\n")).toContain("\x1b]133;A\x07")
		expect(withTimestamp.slice(1).join("\n")).toContain("\x1b]133;B\x07\x1b]133;C\x07")
		expect(message.content).toBe("Original user prompt")
	})

	it("composes with cached user renders without accumulating labels", () => {
		const chat = createFakeChat()
		addMessage(chat, { role: "user", content: "Cached prompt", timestamp: FIXED_MS })
		const component = chat.container.children.find((child) => child instanceof UserMessageComponent)
		if (!(component instanceof UserMessageComponent)) throw new Error("user component missing")

		const first = component.render(80)
		const second = component.render(80)
		expect(first).toEqual(second)
		expect(first.filter((line) => stripSgr(line).trimEnd().endsWith(UTC_LABEL))).toHaveLength(1)
	})

	it("does not traverse existing chat children while appending with timestamps disabled", () => {
		const chat = createFakeChat()
		for (let index = 0; index < 100; index++) chat.container.addChild(new Container())
		// The old implementation built a Set from every existing child. That
		// snapshot is forbidden by this proxy even before the message is added.
		Reflect.set(
			chat.container,
			"children",
			new Proxy(chat.container.children as unknown[], {
				get(target, property, receiver) {
					if (property === Symbol.iterator) throw new Error("existing children were traversed")
					return Reflect.get(target, property, receiver)
				},
			}),
		)
		configureTranscriptTimestamps({ enabled: false, timezone: "UTC" })

		expect(() => addMessage(chat, { role: "user", content: "Linear append", timestamp: FIXED_MS })).not.toThrow()
		const children = Reflect.get(chat.container, "children") as unknown[]
		const component = children[children.length - 1]
		expect(component).toBeInstanceOf(UserMessageComponent)
		configureTranscriptTimestamps({ enabled: true, timezone: "UTC" })
		expectTimestampRow((component as UserMessageComponent).render(80), "user")
	})

	it("reads live and settled assistant timestamps without modifying content", () => {
		const message = createAssistantMessage()
		const component = new AssistantMessageComponent(message as never)
		const rendered = component.render(80)

		expectTimestampRow(rendered, "assistant")
		expect(rendered.slice(1).join("\n")).toContain("Original assistant response")
		expect(message.content).toEqual([{ type: "text", text: "Original assistant response" }])
	})

	it("decorates custom, compaction, branch, and skill entries from their source message", () => {
		const chat = createFakeChat()
		addMessage(chat, {
			role: "custom",
			customType: "timestamp-test",
			content: "Custom event",
			display: true,
			timestamp: FIXED_MS,
		})
		addMessage(chat, {
			role: "compactionSummary",
			summary: "Compaction event",
			tokensBefore: 100,
			timestamp: FIXED_MS,
		})
		addMessage(chat, { role: "branchSummary", summary: "Branch event", fromId: null, timestamp: FIXED_MS })
		addMessage(chat, {
			role: "user",
			content: '<skill name="pdf" location="/skills/pdf/SKILL.md">\nUse PDF tools.\n</skill>',
			timestamp: FIXED_MS,
		})

		for (const [type, role] of [
			[CustomMessageComponent, "event"],
			[CompactionSummaryMessageComponent, "compaction"],
			[BranchSummaryMessageComponent, "branch"],
			[SkillInvocationMessageComponent, "skill"],
		] as const) {
			const component = chat.container.children.find((child) => child instanceof type)
			expect(component, type.name).toBeDefined()
			if (!(component instanceof type)) continue
			expectTimestampRow(component.render(80), role)
		}
	})

	it("truncates timestamp labels safely at tiny widths", () => {
		const chat = createFakeChat()
		addMessage(chat, { role: "user", content: "x", timestamp: FIXED_MS })
		const component = chat.container.children.find((child) => child instanceof UserMessageComponent)
		if (!(component instanceof UserMessageComponent)) throw new Error("user component missing")

		for (const width of [1, 2, 5]) {
			for (const line of component.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width)
		}
	})
})

describe("tool and bash completion timestamps", () => {
	it("uses a persisted final tool-result timestamp on replay", () => {
		const component = createTool()
		const result = {
			content: [{ type: "text", text: "Original tool output" }],
			isError: false,
			timestamp: FIXED_MS,
		}
		component.updateResult(result as never, false)
		const rendered = component.render(80)

		expectTimestampRow(rendered, "tool completed")
		expect(rendered.slice(1).join("\n")).toContain("Original tool output")
		expect(result).toEqual({
			content: [{ type: "text", text: "Original tool output" }],
			isError: false,
			timestamp: FIXED_MS,
		})
	})

	it("does not timestamp partial results and uses current time for a live final result", () => {
		const currentMs = Date.parse("2026-12-01T00:00:00.000Z")
		vi.useFakeTimers()
		vi.setSystemTime(currentMs)
		const component = createTool()
		component.updateResult({ content: [], isError: false, timestamp: 1 } as never, true)
		expect(component.render(80).join("\n")).not.toContain("1970-01-01")

		component.updateResult({ content: [], isError: false } as never, false)
		expectTimestampRow(component.render(80), "tool completed", formatTranscriptTimestamp(currentMs, "UTC"))
	})

	it("keeps an empty/hidden tool block hidden even when it has a completion time", () => {
		const component = createTool()
		component.updateResult({ content: [], isError: false, timestamp: FIXED_MS } as never, false)
		Reflect.set(component, "hideComponent", true)
		expect(component.render(80)).toEqual([])
	})

	it("records bash completion without changing its command or output", () => {
		const currentMs = Date.parse("2026-12-02T00:00:00.000Z")
		vi.useFakeTimers()
		vi.setSystemTime(currentMs)
		const component = new BashExecutionComponent("printf hello", { requestRender: () => {} } as never)
		component.appendOutput("hello")
		component.setComplete(0, false)
		const rendered = component.render(80)

		expectTimestampRow(rendered, "bash completed", formatTranscriptTimestamp(currentMs, "UTC"))
		expect(rendered.slice(1).join("\n")).toContain("$ printf hello")
		expect(rendered.slice(1).join("\n")).toContain("hello")
		expect(component.getCommand()).toBe("printf hello")
		expect(component.getOutput()).toBe("hello")
	})

	it("preserves a replayed bash completion across later duplicate completion calls", () => {
		const chat = createFakeChat()
		vi.useFakeTimers()
		vi.setSystemTime(FIXED_MS + 100_000)
		addMessage(chat, {
			role: "bashExecution",
			command: "printf replay",
			output: "replayed output",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			excludeFromContext: false,
			timestamp: FIXED_MS,
		})
		const component = chat.container.children.find((child) => child instanceof BashExecutionComponent)
		expect(component).toBeInstanceOf(BashExecutionComponent)
		if (!(component instanceof BashExecutionComponent)) return

		expectTimestampRow(component.render(80), "bash completed")
		component.setComplete(0, false)
		expectTimestampRow(component.render(80), "bash completed")
		expect(component.render(80).join("\n")).toContain("replayed output")
	})
})
