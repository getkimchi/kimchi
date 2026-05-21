// End-to-end checks that a real kimchi run spawning a real Agent leaves parent
// and child session files side-by-side on disk with bidirectional linkage — the
// path unit tests can't reach.

import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runBinary } from "./harness.js"

interface TokenUsage {
	input: number
	output: number
	cacheRead: number
	cacheWrite: number
}

interface AgentDetails {
 	agentId?: string
	sessionFile?: string
	tokenUsage?: TokenUsage
	durationMs?: number
}

interface SessionEntry {
	type: string
	message?: {
		role?: string
		toolCallId?: string
		details?: unknown
		usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
	}
}

function readJsonl(path: string): SessionEntry[] {
	return readFileSync(path, "utf-8")
		.split("\n")
		.filter((l) => l.trim().length > 0)
		.map((l) => JSON.parse(l) as SessionEntry)
}

// Sum `message.usage` across every assistant message in a session file — reconstructs per-turn billing from disk.
function sumAssistantUsage(entries: SessionEntry[]): TokenUsage {
	const total: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue
		const u = entry.message.usage
		if (!u) continue
		total.input += u.input ?? 0
		total.output += u.output ?? 0
		total.cacheRead += u.cacheRead ?? 0
		total.cacheWrite += u.cacheWrite ?? 0
	}
	return total
}

describe("Agent session tracking smoke tests", () => {
	let sessionDir: string

	beforeEach(() => {
		sessionDir = mkdtempSync(join(tmpdir(), "kimchi-agent-session-"))
	})

	afterEach(() => {
		rmSync(sessionDir, { recursive: true, force: true })
	})

	it.skipIf(!process.env.KIMCHI_API_KEY)(
		"Agent run leaves a child session file with a header that back-references the parent, and the parent's tool-result records the child's id and path",
		{ timeout: 60_000, retry: 1 },
		() => {
			const prompt = [
				"Use the `Agent` tool exactly once with these arguments:",
				'- subagent_type: "General-Purpose"',
				'- model: "kimchi-dev/kimi-k2.5"',
				'- description: "reply ok"',
				'- prompt: "Reply with only the single word: OK"',
				"",
				"After it returns, echo the Agent's reply verbatim as your final answer and nothing else.",
			].join("\n")

			runBinary({
				args: ["--session-dir", sessionDir, "-p", prompt],
				extraEnv: { KIMCHI_API_KEY: process.env.KIMCHI_API_KEY as string },
				timeoutMs: 55_000,
			})

			const files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"))
			const sessionsByFile = new Map<
				string,
				{ file: string; header: { id?: string; parentSession?: string }; entries: SessionEntry[] }
			>()
			for (const name of files) {
				const full = join(sessionDir, name)
				const entries = readJsonl(full)
				const header = entries[0] as unknown as { id?: string; parentSession?: string; type?: string }
				if (header?.type !== "session") continue
				sessionsByFile.set(name, { file: full, header, entries })
			}

			const parent = [...sessionsByFile.values()].find((s) => !s.header.parentSession)
			const child = [...sessionsByFile.values()].find((s) => s.header.parentSession !== undefined)
			expect(parent, "parent session file (no parentSession header) should exist").toBeDefined()
			expect(child, "child session file (with parentSession header) should exist").toBeDefined()

			// Header linkage: child → parent.
			expect(child?.header.parentSession).toBe(parent?.file)

			// Parent → child linkage: the parent session log should carry a tool-result entry with AgentDetails referencing the child.
			const toolResult = parent?.entries.find(
				(e) =>
					e.type === "message" &&
					e.message?.role === "toolResult" &&
					(e.message.details as AgentDetails | undefined)?.sessionFile !== undefined,
			)
			expect(
				toolResult,
				"parent session should contain an Agent tool-result with sessionFile populated",
			).toBeDefined()
			const details = toolResult?.message?.details as AgentDetails
			expect(details.agentId).toBeDefined()
			expect(details.sessionFile).toBe(child?.file)
		},
	)

	// Nesting: an Agent that itself spawns an Agent must land its grandchild in the
	// top-level parent's dir, with a back-reference chain parent → child →
	// grandchild intact. Load-bearing for pi's session-selector tree UI at depth > 1.
	it.skipIf(!process.env.KIMCHI_API_KEY)(
		"nested Agent runs keep all descendants in the top-level parent's directory with intact back-references",
		{ timeout: 120_000, retry: 1 },
		() => {
			const prompt = [
				"Use the `Agent` tool exactly once with these arguments:",
				'- subagent_type: "General-Purpose"',
				'- model: "kimchi-dev/kimi-k2.5"',
				'- description: "spawn child"',
				"- prompt: (multi-line, copy verbatim)",
				'    """',
				"    Use the `Agent` tool exactly once with these arguments:",
				'    - subagent_type: "General-Purpose"',
				'    - model: "kimchi-dev/kimi-k2.5"',
				'    - description: "reply ok"',
				'    - prompt: "Reply with only the single word: OK"',
				"",
				"    After it returns, echo the Agent's reply verbatim as your final answer and nothing else.",
				'    """',
				"",
				"After it returns, echo the Agent's reply verbatim as your final answer and nothing else.",
			].join("\n")

			runBinary({
				args: ["--session-dir", sessionDir, "-p", prompt],
				extraEnv: { KIMCHI_API_KEY: process.env.KIMCHI_API_KEY as string },
				timeoutMs: 110_000,
			})

			const files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"))
			const sessionsByFile = new Map<
				string,
				{ file: string; header: { id?: string; parentSession?: string }; entries: SessionEntry[] }
			>()
			for (const name of files) {
				const full = join(sessionDir, name)
				const entries = readJsonl(full)
				const header = entries[0] as unknown as { id?: string; parentSession?: string; type?: string }
				if (header?.type !== "session") continue
				sessionsByFile.set(full, { file: full, header, entries })
			}

			const parent = [...sessionsByFile.values()].find((s) => !s.header.parentSession)
			expect(parent, "top-level parent session (no parentSession header) should exist").toBeDefined()

			// Walk the chain: parent → child → grandchild via `parentSession` headers.
			const child = [...sessionsByFile.values()].find((s) => s.header.parentSession === parent?.file)
			expect(child, "child session back-referencing the parent should exist").toBeDefined()

			const grandchild = [...sessionsByFile.values()].find((s) => s.header.parentSession === child?.file)
			expect(grandchild, "grandchild session back-referencing the child should exist").toBeDefined()

			// All three must share the same directory — required for pi's non-recursive session-selector tree to render the full chain.
			expect(child?.file.startsWith(`${sessionDir}/`)).toBe(true)
			expect(grandchild?.file.startsWith(`${sessionDir}/`)).toBe(true)

			// Forward linkage: each level's tool-result points at the next level's session file.
			const parentToolResult = parent?.entries.find(
				(e) =>
					e.type === "message" &&
					e.message?.role === "toolResult" &&
					(e.message.details as AgentDetails | undefined)?.sessionFile === child?.file,
			)
			expect(parentToolResult, "parent tool-result should reference child.sessionFile").toBeDefined()

			const childToolResult = child?.entries.find(
				(e) =>
					e.type === "message" &&
					e.message?.role === "toolResult" &&
					(e.message.details as AgentDetails | undefined)?.sessionFile === grandchild?.file,
			)
			expect(childToolResult, "child tool-result should reference grandchild.sessionFile").toBeDefined()
		},
	)
})
