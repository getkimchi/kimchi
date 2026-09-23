import {
	initTheme,
	type KeybindingsManager,
	type SessionInfo,
	SessionSelectorComponent,
} from "@earendil-works/pi-coding-agent"
import { setKeybindings, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui"
import { beforeAll, describe, expect, it, vi } from "vitest"
import "./session-selector-adapter.js"

function session(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
	return {
		id,
		path: `/tmp/${id}.jsonl`,
		cwd: "/projects/kimchi",
		name: `Session ${id}`,
		created: new Date("2026-01-01T08:00:00Z"),
		modified: new Date("2026-09-20T12:30:00Z"),
		messageCount: 12,
		firstMessage: "Investigate request latency",
		allMessagesText: "Investigate request latency. Fixed connection pooling.",
		...overrides,
	}
}

async function picker(
	sessions: SessionInfo[],
	options: {
		all?: () => Promise<SessionInfo[]>
		currentPath?: string
		rename?: (path: string, name: string | undefined) => Promise<void>
	} = {},
) {
	const select = vi.fn()
	const cancel = vi.fn()
	const component = new SessionSelectorComponent(
		async () => sessions,
		options.all ?? (async () => sessions),
		select,
		cancel,
		vi.fn(),
		vi.fn(),
		{ renameSession: options.rename },
		options.currentPath,
	)
	setKeybindings((component as unknown as { keybindings: KeybindingsManager }).keybindings)
	await Promise.resolve()
	return { component, select, cancel }
}

function text(component: SessionSelectorComponent, width = 120): string {
	return stripTerminalSequences(component.render(width).join("\n"))
}

beforeAll(() => {
	initTheme("dark")
})

describe("resume explorer using the upstream selector", () => {
	it("shows recent sessions with labeled dates and details instead of default thread ordering", async () => {
		const child = session("child", { parentSessionPath: "/tmp/parent.jsonl" })
		const parent = session("parent", { modified: new Date("2026-01-01T08:00:00Z") })
		const { component } = await picker([child, parent], { currentPath: child.path })
		const rendered = text(component)
		expect(rendered).toContain("Resume session · Current folder · Last active")
		expect(rendered).toContain("[current] Session child")
		expect(rendered.indexOf("Session child")).toBeLessThan(rendered.indexOf("Session parent"))
		expect(rendered).toContain(`Last active: ${child.modified.toLocaleString()}`)
		expect(rendered).toContain(`Created: ${child.created.toLocaleString()} · 12 messages`)
		expect(rendered).toContain("Folder: /projects/kimchi")
		expect(rendered).toContain("Session: child")
		expect(rendered).toContain("First message: Investigate request latency")
	})

	it.each([
		"pooling",
		'"connection pooling"',
		"re:connection\\s+pooling",
		"latncy",
		"/projects/kimchi",
		"needle-id",
	])("retains upstream search for %s and resumes the selected file", async (query) => {
		const target = session("needle-id")
		const { component, select } = await picker([target])
		component.handleInput(query)
		expect(text(component)).toContain("1/1 sessions")
		component.handleInput("\r")
		expect(select).toHaveBeenCalledWith(target.path)
	})

	it("shows content match context beyond the first message and resets selection when the query changes", async () => {
		const { component, select } = await picker([
			session("a", { allMessagesText: `${"unrelated text ".repeat(80)}unique-needle found here` }),
			session("b"),
		])
		component.handleInput("\x1b[B")
		component.handleInput("unique-needle")
		expect(text(component)).toContain("unique-needle found here")
		expect(text(component)).toContain("1/1 sessions · 2 in scope")
		component.handleInput("\x15")
		component.handleInput("\r")
		expect(select).toHaveBeenCalledWith("/tmp/a.jsonl")
	})

	it("explains invalid regex and distinguishes no matches from an empty folder", async () => {
		const { component, select } = await picker([session("a")])
		component.handleInput("re:[")
		expect(text(component)).toContain("Invalid regular expression")
		component.handleInput("\r")
		expect(select).not.toHaveBeenCalled()
		component.handleInput("\x15")
		component.handleInput("zzzzzzzzzzz")
		expect(text(component)).toContain("No matching sessions")
		const empty = await picker([])
		expect(text(empty.component)).toContain("No sessions in this folder")
	})

	it("prefers literal titles and IDs over body and fuzzy matches without changing explicit recent sorting", async () => {
		const { component, select } = await picker([
			session("fuzzy", { name: "s a f f r o n", allMessagesText: "s a f f r o n" }),
			session("body", { name: "Retry bug", allMessagesText: "saffron retry" }),
			session("title", { name: "Saffron incident" }),
		])
		component.handleInput("saffron")
		expect(text(component).indexOf("Saffron incident")).toBeLessThan(text(component).indexOf("Retry bug"))
		component.handleInput("\r")
		expect(select).toHaveBeenLastCalledWith("/tmp/title.jsonl")
		component.handleInput("\x13")
		component.handleInput("\x13")
		component.handleInput("\r")
		expect(select).toHaveBeenLastCalledWith("/tmp/fuzzy.jsonl")
	})

	it("keeps the query across scope changes and prevents selecting hidden stale rows during loading", async () => {
		let resolveAll!: (sessions: SessionInfo[]) => void
		const all = new Promise<SessionInfo[]>((resolve) => {
			resolveAll = resolve
		})
		const { component, select } = await picker([session("here")], { all: () => all })
		component.handleInput("\t")
		expect(text(component)).toContain("Loading sessions")
		component.handleInput("\r")
		expect(select).not.toHaveBeenCalled()
		component.handleInput("\x04")
		expect(text(component)).not.toContain("Delete session?")
		component.handleInput("elsewhere")
		resolveAll([session("elsewhere", { cwd: "/another/project" })])
		await Promise.resolve()
		expect(text(component)).toContain("All folders · Best match")
		expect(text(component)).toContain("Folder: /another/project")
		component.handleInput("\r")
		expect(select).toHaveBeenCalledWith("/tmp/elsewhere.jsonl")
	})

	it("selects a result loaded after navigating an empty list", async () => {
		const { component, select } = await picker([], { all: async () => [session("other")] })
		component.handleInput("\x1b[B")
		component.handleInput("\t")
		await Promise.resolve()
		expect(text(component)).toContain("1/1 sessions")
		component.handleInput("\r")
		expect(select).toHaveBeenCalledWith("/tmp/other.jsonl")
	})

	it("keeps search and selection visible in an 80 by 24 terminal with paging", async () => {
		const rows = process.stdout.rows
		process.stdout.rows = 24
		try {
			const { component } = await picker(
				Array.from({ length: 20 }, (_, index) =>
					session(String(index), {
						firstMessage: "Long conversation preview ".repeat(40),
					}),
				),
			)
			expect(component.render(80).length).toBeLessThanOrEqual(24)
			component.handleInput("\x1b[6~")
			const rendered = text(component, 80)
			expect(rendered).toContain("Search names")
			expect(rendered).toContain("Session: 6")
			expect(rendered).toContain("7/20 sessions")
		} finally {
			process.stdout.rows = rows
		}
	})

	it("preserves rename, cancellation, path toggling and delete confirmation without deleting files", async () => {
		const rename = vi.fn(async () => {})
		const { component, cancel } = await picker([session("a")], { rename })
		component.handleInput("\x10")
		expect(text(component)).toContain("File: /tmp/a.jsonl")
		component.handleInput("\x12")
		expect(text(component)).toContain("Rename Session")
		component.handleInput("\x05")
		component.handleInput("\x15")
		component.handleInput("New name")
		component.handleInput("\r")
		await vi.waitFor(() => expect(rename).toHaveBeenCalledWith("/tmp/a.jsonl", "New name"))
		await vi.waitFor(() => expect(text(component)).toContain("Resume session"))
		component.handleInput("\x04")
		expect(text(component)).toContain("Delete session?")
		component.handleInput("\x1b")
		expect(cancel).not.toHaveBeenCalled()
		component.handleInput("\x1b")
		expect(cancel).toHaveBeenCalledOnce()
	})

	it("retains current-session deletion protection", async () => {
		vi.useFakeTimers()
		try {
			const { component } = await picker([session("a")], { currentPath: "/tmp/a.jsonl" })
			component.handleInput("\x04")
			expect(text(component)).toContain("Cannot delete the currently active session")
			component.handleInput("\x1b")
		} finally {
			vi.useRealTimers()
		}
	})

	it.each([28, 60, 100, 160])("fits %i columns and strips terminal controls from saved metadata", async (width) => {
		const { component } = await picker([
			session("a", {
				name: "\x1b[31mLong 日本語 title\x1b[0m".repeat(8),
				cwd: "/tmp/\nunsafe\x1b]0;injected-title\x07",
			}),
		])
		const lines = component.render(width)
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true)
		expect(lines.join("\n")).not.toContain("injected-title")
		expect(text(component, width)).toContain("Last active")
	})

	it("keeps the distinguishing folder and file names visible in long paths", async () => {
		const { component } = await picker([
			session("a", {
				cwd: `${"/very/long/日本語".repeat(20)}/my-project`,
				path: `${"/very/long/path".repeat(20)}/my-session.jsonl`,
			}),
		])
		component.handleInput("\x10")
		expect(text(component, 60)).toContain("/my-project")
		expect(text(component, 60)).toContain("/my-session.jsonl")
		expect(component.render(60).every((line) => visibleWidth(line) <= 60)).toBe(true)
	})
})
