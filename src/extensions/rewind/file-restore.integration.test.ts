import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AssistantMessage } from "@earendil-works/pi-ai"
import type { SessionEntry } from "@earendil-works/pi-coding-agent"
import { afterEach, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import rewindExtension from "./index.js"

let root: string | undefined
afterEach(() => {
	vi.unstubAllEnvs()
	if (root) rmSync(root, { recursive: true, force: true })
})

function assistantReply(timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Edited the notes" }],
		api: "openai-completions",
		provider: "kimchi-dev",
		model: "kimi-k2.7",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	}
}

// Pins patches/pi-rewind-hook@1.8.7.patch: pi appends a prompt's user entry only after
// turn_start, and restoring files to a prompt must still bring back the files from before it.
it("restores the files from before each prompt", async () => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "kimchi-rewind-")))
	const sessionFile = join(root, "session.jsonl")
	const cwd = join(root, "repo")
	const agentDir = join(root, "agent")
	mkdirSync(cwd)
	mkdirSync(agentDir)
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir)
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ rewind: { silentCheckpoints: true } }))
	const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args])
	git("init", "-q")
	git("config", "user.name", "Rewind Test")
	git("config", "user.email", "rewind@example.invalid")
	git("config", "commit.gpgSign", "false")
	const notes = join(cwd, "notes.txt")
	writeFileSync(notes, "zero\n")

	const branch: SessionEntry[] = []
	const pi = createExtensionApi()
	pi.exec.mockImplementation(async (command, args) => {
		const result = spawnSync(command, args, { cwd, encoding: "utf8" })
		return { stdout: result.stdout, stderr: result.stderr, code: result.status ?? 1, killed: false }
	})
	pi.appendEntry.mockImplementation((customType, data) => {
		branch.push({
			type: "custom",
			id: `${customType}-${branch.length}`,
			parentId: branch.at(-1)?.id ?? null,
			timestamp: new Date().toISOString(),
			customType,
			data,
		})
	})
	rewindExtension(pi.api)
	const ctx = createContext({
		cwd,
		sessionManager: {
			getBranch: () => branch,
			getEntries: () => branch,
			getEntry: (id) => branch.find((entry) => entry.id === id),
			getSessionFile: () => sessionFile,
			getCwd: () => cwd,
		},
		ui: { select: vi.fn(async () => "Restore files to that point") },
	})

	await pi.getHandler("session_start")({ type: "session_start", reason: "startup" }, ctx)
	for (const [index, content] of ["one\n", "two\n"].entries()) {
		const reply = assistantReply(index + 1)
		await pi.getHandler("turn_start")({ type: "turn_start", turnIndex: 0, timestamp: reply.timestamp }, ctx)
		// pi appends the prompt and its reply after turn_start.
		branch.push(
			{
				type: "message",
				id: `user-${index + 1}`,
				parentId: branch.at(-1)?.id ?? null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "Edit the notes", timestamp: reply.timestamp },
			},
			{
				type: "message",
				id: `assistant-${index + 1}`,
				parentId: `user-${index + 1}`,
				timestamp: new Date().toISOString(),
				message: reply,
			},
		)
		writeFileSync(notes, content)
		await pi.getHandler("turn_end")({ type: "turn_end", turnIndex: 0, message: reply, toolResults: [] }, ctx)
		await pi.getHandler("agent_end")({ type: "agent_end", messages: [] }, ctx)
	}

	await pi.getHandler("session_before_tree")({ type: "session_before_tree", preparation: { targetId: "user-2" } }, ctx)
	expect(readFileSync(notes, "utf8")).toBe("one\n")
	await pi.getHandler("session_before_tree")({ type: "session_before_tree", preparation: { targetId: "user-1" } }, ctx)
	expect(readFileSync(notes, "utf8")).toBe("zero\n")
}, 30_000)
