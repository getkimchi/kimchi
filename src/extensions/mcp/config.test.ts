import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import type { McpConfig } from "pi-mcp-adapter/types"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const upstream = vi.hoisted(() => ({
	load: vi.fn<(overridePath?: string, cwd?: string) => McpConfig>(),
}))

vi.mock("pi-mcp-adapter/config", () => ({
	loadMcpConfig: upstream.load,
}))

import { LEGACY_PROJECT_MCP_CONFIG, loadKimchiMcpConfig } from "./config.js"

describe("loadKimchiMcpConfig", () => {
	let cwd: string

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "kimchi-mcp-config-"))
		upstream.load.mockReset()
		upstream.load.mockReturnValue({ mcpServers: {} })
	})

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true })
		vi.unstubAllEnvs()
	})

	it("uses upstream's standard discovery when no legacy config exists", () => {
		const config: McpConfig = { mcpServers: { docs: { url: "https://example.test/mcp" } } }
		upstream.load.mockReturnValue(config)

		const result = loadKimchiMcpConfig({ cwd })

		expect(result).toEqual({ config, warnings: [] })
		expect(upstream.load).toHaveBeenCalledWith(undefined, cwd)
	})

	it("loads user-only config outside the repository and forces programmatic mode", () => {
		const config: McpConfig = { mcpServers: { personal: { command: "personal-server" } } }
		upstream.load.mockReturnValue(config)

		const result = loadKimchiMcpConfig({ cwd, includeProjectSources: false })

		expect(result).toEqual({ config, useProgrammaticConfig: true, warnings: [] })
		expect(upstream.load).toHaveBeenCalledWith(undefined, join(getAgentDir(), ".kimchi-mcp-user-config"))
	})

	it("uses the legacy project config as a file-backed upstream override", () => {
		const legacyPath = join(cwd, LEGACY_PROJECT_MCP_CONFIG)
		mkdirSync(dirname(legacyPath), { recursive: true })
		writeFileSync(legacyPath, JSON.stringify({ mcpServers: { local: { command: "local-server" } } }))
		const config: McpConfig = { mcpServers: { local: { command: "local-server" } } }
		upstream.load.mockReturnValue(config)

		const result = loadKimchiMcpConfig({ cwd })

		expect(result).toEqual({ config, configPath: legacyPath, warnings: [] })
		expect(upstream.load).toHaveBeenCalledWith(legacyPath, cwd)
	})

	it("restores legacy precedence when a standard project source overrides the same server", () => {
		const legacyPath = join(cwd, LEGACY_PROJECT_MCP_CONFIG)
		mkdirSync(dirname(legacyPath), { recursive: true })
		writeFileSync(legacyPath, JSON.stringify({ mcpServers: { shared: { command: "legacy-server" } } }))
		const discovered: McpConfig = {
			mcpServers: {
				shared: { command: "standard-project-server" },
				standardOnly: { command: "standard-only-server" },
			},
		}
		upstream.load.mockReturnValue(discovered)

		const result = loadKimchiMcpConfig({ cwd })

		expect(result).toEqual({
			config: {
				mcpServers: {
					shared: { command: "legacy-server" },
					standardOnly: { command: "standard-only-server" },
				},
			},
			configPath: legacyPath,
			useProgrammaticConfig: true,
			warnings: [],
		})
	})

	it("prefers an explicit config path over the legacy project file", () => {
		const legacyPath = join(cwd, LEGACY_PROJECT_MCP_CONFIG)
		mkdirSync(dirname(legacyPath), { recursive: true })
		writeFileSync(legacyPath, JSON.stringify({ mcpServers: { legacy: { command: "legacy" } } }))

		const result = loadKimchiMcpConfig({ cwd, overridePath: "/tmp/explicit-mcp.json" })

		expect(result.configPath).toBe("/tmp/explicit-mcp.json")
		expect(upstream.load).toHaveBeenCalledWith("/tmp/explicit-mcp.json", cwd)
	})

	it("does not inject the legacy path in exclusive config mode", () => {
		const legacyPath = join(cwd, LEGACY_PROJECT_MCP_CONFIG)
		mkdirSync(dirname(legacyPath), { recursive: true })
		writeFileSync(legacyPath, JSON.stringify({ mcpServers: { legacy: { command: "legacy" } } }))
		vi.stubEnv("PI_MCP_CONFIG_MODE", "exclusive")

		const result = loadKimchiMcpConfig({ cwd })

		expect(result.configPath).toBeUndefined()
		expect(upstream.load).toHaveBeenCalledWith(undefined, cwd)
	})
})
