import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

describe("MCP configuration with the real upstream loader", () => {
	let homeDir: string
	let agentDir: string
	let cwd: string

	beforeAll(() => {
		homeDir = mkdtempSync(join(tmpdir(), "kimchi-mcp-config-integration-"))
		vi.stubEnv("HOME", homeDir)
		vi.stubEnv("PI_PACKAGE_DIR", process.cwd())
		vi.stubEnv("PI_MCP_CONFIG_MODE", "")
	})

	afterAll(() => {
		vi.unstubAllEnvs()
		rmSync(homeDir, { recursive: true, force: true })
	})

	beforeEach(() => {
		agentDir = mkdtempSync(join(homeDir, "agent-"))
		cwd = mkdtempSync(join(homeDir, "project-"))
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", agentDir)
	})

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true })
		rmSync(cwd, { recursive: true, force: true })
		rmSync(join(homeDir, ".config", "mcp", "mcp.json"), { force: true })
	})

	it("preserves global servers and settings when the legacy project file is selected", async () => {
		const { loadKimchiMcpConfig, LEGACY_PROJECT_MCP_CONFIG } = await import("./config.js")
		const sharedGlobalPath = join(homeDir, ".config", "mcp", "mcp.json")
		mkdirSync(dirname(sharedGlobalPath), { recursive: true })
		writeFileSync(
			sharedGlobalPath,
			JSON.stringify({ mcpServers: { personal: { command: "lower-priority" } }, settings: { autoAuth: true } }),
		)
		writeFileSync(
			join(agentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: { personal: { command: "personal-server" }, shared: { command: "global-server" } },
				settings: { autoAuth: false, toolPrefix: "server" },
			}),
		)
		writeFileSync(
			join(cwd, ".mcp.json"),
			JSON.stringify({ mcpServers: { standard: { command: "standard-server" }, shared: { command: "standard" } } }),
		)
		const legacyPath = join(cwd, LEGACY_PROJECT_MCP_CONFIG)
		mkdirSync(dirname(legacyPath), { recursive: true })
		writeFileSync(
			legacyPath,
			`{
				// The project overrides only the settings and servers it declares.
				"mcpServers": { "project": { "command": "project-server" }, "shared": { "command": "legacy" }, },
				"settings": { "toolPrefix": "none", },
			}`,
		)

		expect(loadKimchiMcpConfig({ cwd })).toEqual({
			config: {
				mcpServers: {
					personal: { command: "personal-server" },
					standard: { command: "standard-server" },
					project: { command: "project-server" },
					shared: { command: "legacy" },
				},
				settings: { autoAuth: false, toolPrefix: "none" },
			},
			warnings: [],
		})
	})

	it("persists panel choices and enable/disable overrides in the legacy project source", async () => {
		const { loadKimchiMcpConfig, LEGACY_PROJECT_MCP_CONFIG } = await import("./config.js")
		const { getServerProvenance, writeDirectToolsConfig, writeProjectServerDisabledOverride } = await import(
			"pi-mcp-adapter/config"
		)
		const legacyPath = join(cwd, LEGACY_PROJECT_MCP_CONFIG)
		mkdirSync(dirname(legacyPath), { recursive: true })
		writeFileSync(legacyPath, JSON.stringify({ mcpServers: { project: { command: "project-server" } } }))
		writeFileSync(
			join(agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { personal: { command: "personal-server" } } }),
		)
		const provenance = getServerProvenance(undefined, cwd)
		expect(provenance.get("project")).toMatchObject({ path: legacyPath, kind: "project" })
		expect(provenance.get("personal")).toMatchObject({ path: join(agentDir, "mcp.json"), kind: "user" })

		writeDirectToolsConfig(new Map([["project", ["echo"]]]), provenance, loadKimchiMcpConfig({ cwd }).config)
		expect(JSON.parse(readFileSync(legacyPath, "utf8")).mcpServers.project.directTools).toEqual(["echo"])
		expect(writeProjectServerDisabledOverride(undefined, cwd, "project", true)).toEqual({
			path: legacyPath,
			changed: true,
		})
		expect(loadKimchiMcpConfig({ cwd }).config.mcpServers.project).toMatchObject({
			disabled: true,
			directTools: ["echo"],
		})
		writeProjectServerDisabledOverride(undefined, cwd, "project", false)
		expect(loadKimchiMcpConfig({ cwd }).config.mcpServers.project.disabled).not.toBe(true)
	})

	it("retains the adapter default project path for hosts without the compatibility setting", async () => {
		const { getProjectPiConfigPath } = await import("pi-mcp-adapter/config")
		const manifestDir = join(cwd, "host-manifest")
		mkdirSync(manifestDir)
		writeFileSync(join(manifestDir, "package.json"), JSON.stringify({ piConfig: { configDir: ".custom-host" } }))
		vi.stubEnv("PI_PACKAGE_DIR", manifestDir)
		try {
			expect(getProjectPiConfigPath(cwd)).toBe(join(cwd, ".custom-host", "mcp.json"))
		} finally {
			vi.stubEnv("PI_PACKAGE_DIR", process.cwd())
		}
	})

	it("still expands imports declared by the legacy layer", async () => {
		const { loadKimchiMcpConfig, LEGACY_PROJECT_MCP_CONFIG } = await import("./config.js")
		writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { personal: { command: "personal" } } }))
		const cursorPath = join(homeDir, ".cursor", "mcp.json")
		mkdirSync(dirname(cursorPath))
		writeFileSync(cursorPath, JSON.stringify({ mcpServers: { imported: { command: "cursor-server" } } }))
		const legacyPath = join(cwd, LEGACY_PROJECT_MCP_CONFIG)
		mkdirSync(dirname(legacyPath), { recursive: true })
		writeFileSync(legacyPath, JSON.stringify({ imports: ["cursor"], mcpServers: {} }))

		expect(loadKimchiMcpConfig({ cwd }).config.mcpServers).toEqual({
			personal: { command: "personal" },
			imported: { command: "cursor-server" },
		})
	})
})
