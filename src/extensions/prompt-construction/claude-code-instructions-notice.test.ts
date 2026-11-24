import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readClaudeCodeInstructionsNoticeSeenAt } from "../../config.js"
import { setResourceOverride } from "../../resources/store.js"
import { createContext } from "../__mocks__/context.js"
import { notifyClaudeCodeInstructionsOnce } from "./claude-code-instructions-notice.js"
import { CLAUDE_CODE_INSTRUCTIONS_RESOURCE_ID } from "./claude-code-instructions-resource.js"

describe("notifyClaudeCodeInstructionsOnce", () => {
	let dir: string
	let claudePath: string
	let agentDir: string
	let project: string

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "kimchi-claude-notice-"))
		claudePath = join(dir, "claude", "CLAUDE.md")
		agentDir = join(dir, "agent")
		project = join(dir, "project")
		for (const d of [join(dir, "claude"), agentDir, project]) mkdirSync(d)
		vi.stubEnv("CLAUDE_CONFIG_DIR", join(dir, "claude"))
		// Upstream getAgentDir reads PI_ outside the kimchi entry; the resource store reads KIMCHI_.
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir)
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", agentDir)
		rmSync(join(homedir(), ".config", "kimchi", "config.json"), { force: true })
		writeFileSync(claudePath, "claude rules")
	})

	afterEach(() => {
		vi.unstubAllEnvs()
		rmSync(dir, { recursive: true, force: true })
	})

	function run(hasUI = true) {
		const ctx = createContext({ hasUI, cwd: project })
		notifyClaudeCodeInstructionsOnce(ctx)
		return vi.mocked(ctx.ui.notify)
	}

	it("notifies once when the Claude Code file loads with the global AGENTS.md", () => {
		writeFileSync(join(agentDir, "AGENTS.md"), "kimchi rules")

		const notify = run()

		expect(notify).toHaveBeenCalledOnce()
		expect(notify.mock.calls[0][0]).toContain(claudePath)
		expect(notify.mock.calls[0][0]).toContain(`kimchi resources disable ${CLAUDE_CODE_INSTRUCTIONS_RESOURCE_ID}`)
		expect(readClaudeCodeInstructionsNoticeSeenAt()).toBeDefined()
		expect(run()).not.toHaveBeenCalled()
	})

	it("notifies when the Claude Code file loads with a project AGENTS.md", () => {
		writeFileSync(join(project, "AGENTS.md"), "project rules")
		expect(run()).toHaveBeenCalledOnce()
	})

	it("stays silent when only CLAUDE.md files load", () => {
		writeFileSync(join(project, "CLAUDE.md"), "project claude rules")
		expect(run()).not.toHaveBeenCalled()
		expect(readClaudeCodeInstructionsNoticeSeenAt()).toBeUndefined()
	})

	it("stays silent when the only AGENTS.md repeats the Claude Code file", () => {
		symlinkSync(claudePath, join(project, "AGENTS.md"))
		expect(run()).not.toHaveBeenCalled()
	})

	it("stays silent when the resource is off", () => {
		writeFileSync(join(agentDir, "AGENTS.md"), "kimchi rules")
		setResourceOverride(CLAUDE_CODE_INSTRUCTIONS_RESOURCE_ID, false)
		expect(run()).not.toHaveBeenCalled()
	})

	it("stays silent and keeps the notice for later when there is no UI", () => {
		writeFileSync(join(agentDir, "AGENTS.md"), "kimchi rules")
		expect(run(false)).not.toHaveBeenCalled()
		expect(readClaudeCodeInstructionsNoticeSeenAt()).toBeUndefined()
	})
})
