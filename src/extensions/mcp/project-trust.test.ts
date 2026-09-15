import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent"
import type { McpConfig } from "pi-mcp-adapter/types"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { resolveMcpProjectTrust } from "./project-trust.js"

const USER_CONFIG: McpConfig = { mcpServers: { personal: { command: "personal-server" } } }
const PROJECT_CONFIG: McpConfig = {
	mcpServers: {
		...USER_CONFIG.mcpServers,
		project: { command: "project-server" },
	},
}

let root: string
let cwd: string
let agentDir: string

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "kimchi-mcp-project-trust-"))
	cwd = join(root, "project")
	agentDir = join(root, "agent")
	mkdirSync(cwd, { recursive: true })
	mkdirSync(agentDir, { recursive: true })
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

function context(overrides: Parameters<typeof createContext>[0] = {}) {
	return createContext({ cwd, isProjectTrusted: () => true, ...overrides })
}

describe("MCP project trust", () => {
	it("does not ask when project discovery has no effect", async () => {
		const ctx = context()

		await expect(
			resolveMcpProjectTrust(ctx, {
				projectConfig: USER_CONFIG,
				userConfig: USER_CONFIG,
				agentDir,
			}),
		).resolves.toBe(true)
		expect(ctx.ui.select).not.toHaveBeenCalled()
	})

	it("honors the session's existing untrusted decision", async () => {
		const ctx = context({ isProjectTrusted: () => false })

		await expect(
			resolveMcpProjectTrust(ctx, { projectConfig: PROJECT_CONFIG, userConfig: USER_CONFIG, agentDir }),
		).resolves.toBe(false)
		expect(ctx.ui.select).not.toHaveBeenCalled()
	})

	it("prompts for MCP-only project configuration and persists trust", async () => {
		const ctx = context({ ui: { select: async () => "Trust" } })

		await expect(
			resolveMcpProjectTrust(ctx, { projectConfig: PROJECT_CONFIG, userConfig: USER_CONFIG, agentDir }),
		).resolves.toBe(true)
		expect(new ProjectTrustStore(agentDir).get(cwd)).toBe(true)
	})

	it("supports session-only trust without persisting it", async () => {
		const ctx = context({ ui: { select: async () => "Trust (this session only)" } })

		await expect(
			resolveMcpProjectTrust(ctx, { projectConfig: PROJECT_CONFIG, userConfig: USER_CONFIG, agentDir }),
		).resolves.toBe(true)
		expect(new ProjectTrustStore(agentDir).get(cwd)).toBeNull()
	})

	it("fails closed without a terminal UI", async () => {
		const ctx = context({ hasUI: false, mode: "print" })

		await expect(
			resolveMcpProjectTrust(ctx, {
				projectConfig: PROJECT_CONFIG,
				userConfig: USER_CONFIG,
				agentDir,
				defaultProjectTrust: "ask",
			}),
		).resolves.toBe(false)
		expect(ctx.ui.select).not.toHaveBeenCalled()
	})

	it("honors explicit trust overrides and global defaults", async () => {
		const ctx = context()
		await expect(
			resolveMcpProjectTrust(ctx, {
				projectConfig: PROJECT_CONFIG,
				userConfig: USER_CONFIG,
				agentDir,
				explicitTrust: true,
			}),
		).resolves.toBe(true)
		await expect(
			resolveMcpProjectTrust(ctx, {
				projectConfig: PROJECT_CONFIG,
				userConfig: USER_CONFIG,
				agentDir,
				explicitTrust: false,
			}),
		).resolves.toBe(false)
		await expect(
			resolveMcpProjectTrust(ctx, {
				projectConfig: PROJECT_CONFIG,
				userConfig: USER_CONFIG,
				agentDir,
				defaultProjectTrust: "always",
			}),
		).resolves.toBe(true)
	})
})
