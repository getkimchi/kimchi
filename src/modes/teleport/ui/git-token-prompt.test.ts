import { describe, expect, it } from "vitest"
import {
	type GitTokenPromptEvent,
	type GitTokenPromptState,
	initialGitTokenPromptState,
	keyToGitTokenPromptEvent,
	reduceGitTokenPrompt,
	renderGitTokenPromptLines,
} from "./git-token-prompt.js"

// ── Helpers ──────────────────────────────────────────────────────────────────

function state(overrides?: Partial<GitTokenPromptState>): GitTokenPromptState {
	return { ...initialGitTokenPromptState("github.com"), ...overrides }
}

function reduce(s: GitTokenPromptState, event: GitTokenPromptEvent) {
	return reduceGitTokenPrompt(s, event)
}

// ── initialGitTokenPromptState ───────────────────────────────────────────────

describe("initialGitTokenPromptState", () => {
	it("starts with empty token and save enabled", () => {
		const s = initialGitTokenPromptState("github.com")
		expect(s.token).toBe("")
		expect(s.saveForFuture).toBe(true)
		expect(s.host).toBe("github.com")
	})
})

// ── reduceGitTokenPrompt ─────────────────────────────────────────────────────

describe("reduceGitTokenPrompt", () => {
	it("appends a character", () => {
		const { state: next } = reduce(state(), { kind: "char", char: "a" })
		expect(next.token).toBe("a")
	})

	it("appends a pasted string", () => {
		const { state: next } = reduce(state(), { kind: "char", char: "ghp_abc123" })
		expect(next.token).toBe("ghp_abc123")
	})

	it("accumulates characters", () => {
		let s = state()
		s = reduce(s, { kind: "char", char: "g" }).state
		s = reduce(s, { kind: "char", char: "h" }).state
		s = reduce(s, { kind: "char", char: "p" }).state
		expect(s.token).toBe("ghp")
	})

	it("removes last character on backspace", () => {
		const { state: next } = reduce(state({ token: "abc" }), { kind: "backspace" })
		expect(next.token).toBe("ab")
	})

	it("does nothing on backspace when token is empty", () => {
		const { state: next } = reduce(state({ token: "" }), { kind: "backspace" })
		expect(next.token).toBe("")
	})

	it("toggles save checkbox", () => {
		const { state: next } = reduce(state({ saveForFuture: true }), { kind: "toggle-save" })
		expect(next.saveForFuture).toBe(false)
	})

	it("toggles save checkbox back", () => {
		const { state: next } = reduce(state({ saveForFuture: false }), { kind: "toggle-save" })
		expect(next.saveForFuture).toBe(true)
	})

	it("submit with non-empty token produces submitted result", () => {
		const { result } = reduce(state({ token: "ghp_abc" }), { kind: "submit" })
		expect(result).toEqual({ outcome: "submitted", token: "ghp_abc", save: true })
	})

	it("submit with save=false produces save=false in result", () => {
		const { result } = reduce(state({ token: "ghp_abc", saveForFuture: false }), { kind: "submit" })
		expect(result).toEqual({ outcome: "submitted", token: "ghp_abc", save: false })
	})

	it("submit trims whitespace from token", () => {
		const { result } = reduce(state({ token: "  ghp_abc  " }), { kind: "submit" })
		expect(result).toEqual({ outcome: "submitted", token: "ghp_abc", save: true })
	})

	it("submit with empty token produces no result", () => {
		const { result } = reduce(state({ token: "" }), { kind: "submit" })
		expect(result).toBeUndefined()
	})

	it("submit with whitespace-only token produces no result", () => {
		const { result } = reduce(state({ token: "   " }), { kind: "submit" })
		expect(result).toBeUndefined()
	})

	it("skip produces skipped result", () => {
		const { result } = reduce(state(), { kind: "skip" })
		expect(result).toEqual({ outcome: "skipped" })
	})

	it("skip works even with a token entered", () => {
		const { result } = reduce(state({ token: "ghp_abc" }), { kind: "skip" })
		expect(result).toEqual({ outcome: "skipped" })
	})
})

// ── keyToGitTokenPromptEvent ─────────────────────────────────────────────────

describe("keyToGitTokenPromptEvent", () => {
	it("maps Escape to skip", () => {
		expect(keyToGitTokenPromptEvent("\x1b"))?.toEqual({ kind: "skip" })
	})

	it("maps Ctrl-C to skip", () => {
		expect(keyToGitTokenPromptEvent("\x03"))?.toEqual({ kind: "skip" })
	})

	it("maps Enter to submit", () => {
		expect(keyToGitTokenPromptEvent("\r"))?.toEqual({ kind: "submit" })
	})

	it("maps Tab to toggle-save", () => {
		expect(keyToGitTokenPromptEvent("\t"))?.toEqual({ kind: "toggle-save" })
	})

	it("maps Backspace to backspace", () => {
		expect(keyToGitTokenPromptEvent("\x7f"))?.toEqual({ kind: "backspace" })
	})

	it("maps printable character to char event", () => {
		expect(keyToGitTokenPromptEvent("a")).toEqual({ kind: "char", char: "a" })
	})

	it("maps pasted text (multi-char) to char event", () => {
		expect(keyToGitTokenPromptEvent("ghp_abc123")).toEqual({ kind: "char", char: "ghp_abc123" })
	})

	it("strips bracketed paste markers and returns char event", () => {
		const pasted = "\x1b[200~ghp_abc\x1b[201~"
		expect(keyToGitTokenPromptEvent(pasted)).toEqual({ kind: "char", char: "ghp_abc" })
	})

	it("returns undefined for unknown escape sequences", () => {
		expect(keyToGitTokenPromptEvent("\x1b[A")).toBeUndefined() // Up arrow
	})
})

// ── renderGitTokenPromptLines ────────────────────────────────────────────────

describe("renderGitTokenPromptLines", () => {
	// Minimal theme mock that passes through text
	const theme = {
		bold: (t: string) => t,
		fg: (_color: string, t: string) => t,
		// biome-ignore lint/suspicious/noExplicitAny: test mock only needs bold + fg
	} as any

	it("includes the host in the heading", () => {
		const lines = renderGitTokenPromptLines(state(), theme, 80)
		expect(lines.some((l) => l.includes("github.com"))).toBe(true)
	})

	it("shows placeholder when token is empty", () => {
		const lines = renderGitTokenPromptLines(state({ token: "" }), theme, 80)
		expect(lines.some((l) => l.includes("paste or type your token"))).toBe(true)
	})

	it("shows masked token when token has content", () => {
		const lines = renderGitTokenPromptLines(state({ token: "ghp_abc" }), theme, 80)
		expect(lines.some((l) => l.includes("●●●●●●●"))).toBe(true)
		expect(lines.every((l) => !l.includes("ghp_abc"))).toBe(true) // actual token never shown
	})

	it("shows char count for long tokens", () => {
		const longToken = "x".repeat(50)
		const lines = renderGitTokenPromptLines(state({ token: longToken }), theme, 80)
		expect(lines.some((l) => l.includes("50 chars"))).toBe(true)
	})

	it("caps mask at 40 chars", () => {
		const longToken = "x".repeat(60)
		const lines = renderGitTokenPromptLines(state({ token: longToken }), theme, 80)
		const maskLine = lines.find((l) => l.includes("●"))
		const maskCount = (maskLine?.match(/●/g) ?? []).length
		expect(maskCount).toBe(40)
	})

	it("shows checked checkbox when saveForFuture is true", () => {
		const lines = renderGitTokenPromptLines(state({ saveForFuture: true }), theme, 80)
		expect(lines.some((l) => l.includes("[✓]"))).toBe(true)
	})

	it("shows unchecked checkbox when saveForFuture is false", () => {
		const lines = renderGitTokenPromptLines(state({ saveForFuture: false }), theme, 80)
		expect(lines.some((l) => l.includes("[ ]"))).toBe(true)
	})

	it("shows key hints", () => {
		const lines = renderGitTokenPromptLines(state(), theme, 80)
		const allText = lines.join(" ")
		expect(allText).toContain("[Enter]")
		expect(allText).toContain("[Tab]")
		expect(allText).toContain("[Esc]")
	})
})
