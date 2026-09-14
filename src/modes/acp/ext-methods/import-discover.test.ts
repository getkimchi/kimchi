import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentDefinition, DirCandidate } from "../../../agent-discovery/index.js"
import * as discoveryModule from "../../../agent-discovery/index.js"
import type { ServerEntry } from "../../../extensions/mcp-adapter/types.js"
import { ADVERTISED_CAPABILITIES, AVAILABLE_EXT_METHODS, CAPABILITIES_KEY } from "../capabilities.js"
import { importDiscover } from "./import-discover.js"

/**
 * A minimal source-app definition for driving importDiscover against real
 * temporary directory trees (same shape as the engine tests' makeDef).
 */
function makeDef(overrides?: {
	id?: string
	displayName?: string
	configPaths?: string[]
	skillsDirs?: DirCandidate[]
}): AgentDefinition {
	return {
		id: overrides?.id ?? "test-agent",
		displayName: overrides?.displayName ?? "Test Agent",
		configPaths: overrides?.configPaths ?? [],
		skillsDirs: overrides?.skillsDirs ?? [],
		commandsDirs: [],
		extractServerSources: (parsed: unknown) => {
			if (!parsed || typeof parsed !== "object") return []
			const root = parsed as Record<string, unknown>
			if (root.mcpServers && typeof root.mcpServers === "object" && !Array.isArray(root.mcpServers)) {
				return [root.mcpServers as Record<string, unknown>]
			}
			return []
		},
		transformServer: (raw: unknown) => {
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
			return raw as ServerEntry
		},
	}
}

function writeSkill(skillsDir: string, name: string, frontmatter: string): void {
	mkdirSync(join(skillsDir, name), { recursive: true })
	writeFileSync(join(skillsDir, name, "SKILL.md"), `---\n${frontmatter}\n---\nBody.\n`, "utf-8")
}

/** Recursive listing of every path in a tree, for the no-writes assertion. */
function snapshotTree(root: string): string[] {
	const out: string[] = []
	const walk = (dir: string, prefix: string): void => {
		for (const entry of readdirSync(dir)) {
			const rel = prefix ? `${prefix}/${entry}` : entry
			out.push(rel)
			if (statSync(join(dir, entry)).isDirectory()) walk(join(dir, entry), rel)
		}
	}
	walk(root, "")
	return out.sort()
}

describe("import_discover", () => {
	let tempDir: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-import-discover-"))
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
	})

	it("returns each source app with id, display name, skills and MCP servers", () => {
		const config = join(tempDir, "claude.json")
		writeFileSync(config, JSON.stringify({ mcpServers: { fetch: { command: "fetchy", args: ["--fast"] } } }), "utf-8")
		const skillsDir = join(tempDir, "claude-skills")
		writeSkill(skillsDir, "deploy", "name: deploy\ndescription: Ship the service")

		const result = importDiscover([
			makeDef({ id: "claude-code", displayName: "Claude Code", configPaths: [config], skillsDirs: [skillsDir] }),
		])

		expect(result.apps).toHaveLength(1)
		expect(result.apps[0].id).toBe("claude-code")
		expect(result.apps[0].displayName).toBe("Claude Code")
		expect(result.apps[0].skills).toEqual([
			{
				name: "deploy",
				description: "Ship the service",
				path: join(skillsDir, "deploy", "SKILL.md"),
				sourceAppId: "claude-code",
				sourceAppName: "Claude Code",
			},
		])
		expect(result.apps[0].mcpServers).toEqual([
			{ name: "fetch", command: "fetchy", sourceAppId: "claude-code", sourceAppName: "Claude Code" },
		])
	})

	it("omits source apps with no skills and no MCP servers", () => {
		const emptyConfig = join(tempDir, "empty.json")
		writeFileSync(emptyConfig, JSON.stringify({ mcpServers: {} }), "utf-8")
		const skillDir = join(tempDir, "some-skills")
		writeSkill(skillDir, "solo", "name: solo\ndescription: Present")

		const result = importDiscover([
			makeDef({ id: "has-nothing", displayName: "Empty App", configPaths: [emptyConfig] }),
			makeDef({ id: "has-skills", displayName: "Skillful App", skillsDirs: [skillDir] }),
		])

		// The client never has to filter empty rows
		expect(result.apps.map((a) => a.id)).toEqual(["has-skills"])
	})

	it("reports the same skill name from two source apps twice, each attributed to its own source", () => {
		const skillsA = join(tempDir, "a-skills")
		const skillsB = join(tempDir, "b-skills")
		writeSkill(skillsA, "another-skill", "name: another-skill\ndescription: From app A")
		writeSkill(skillsB, "another-skill", "name: another-skill\ndescription: From app B")

		const result = importDiscover([
			makeDef({ id: "app-a", displayName: "App A", skillsDirs: [skillsA] }),
			makeDef({ id: "app-b", displayName: "App B", skillsDirs: [skillsB] }),
		])

		expect(result.apps).toHaveLength(2)
		expect(result.apps[0].skills[0].description).toBe("From app A")
		expect(result.apps[1].skills[0].description).toBe("From app B")
		expect(result.apps.map((a) => a.skills[0].sourceAppId)).toEqual(["app-a", "app-b"])
	})

	it("omits a skill whose frontmatter cannot be read or parsed, and returns everything else", () => {
		const skillsDir = join(tempDir, "skills")
		writeSkill(skillsDir, "good", "name: good\ndescription: Fine")
		writeSkill(skillsDir, "broken", "name: [unclosed\ndescription: {{")

		const result = importDiscover([makeDef({ id: "app", displayName: "App", skillsDirs: [skillsDir] })])

		expect(result.apps[0].skills.map((s) => s.name)).toEqual(["good"])
	})

	it("drops an MCP server with neither command nor url, and omits an app left with nothing", () => {
		const config = join(tempDir, "config.json")
		writeFileSync(
			config,
			JSON.stringify({
				mcpServers: {
					broken: { args: ["--x"] },
					emptyCommand: { command: "" },
					emptyUrl: { url: "" },
					good: { command: "cmd" },
				},
			}),
			"utf-8",
		)
		const onlyBroken = join(tempDir, "only-broken.json")
		writeFileSync(onlyBroken, JSON.stringify({ mcpServers: { broken: {} } }), "utf-8")

		const result = importDiscover([
			makeDef({ id: "mixed", displayName: "Mixed", configPaths: [config] }),
			makeDef({ id: "only-broken", displayName: "Only Broken", configPaths: [onlyBroken] }),
		])

		// The name-only and empty-string rows are dropped — a client could not
		// act on any of them
		expect(result.apps.map((a) => a.id)).toEqual(["mixed"])
		expect(result.apps[0].mcpServers).toEqual([
			{ name: "good", command: "cmd", sourceAppId: "mixed", sourceAppName: "Mixed" },
		])
	})

	it("keeps an app whose skills directory has entries that failed enumeration (skillCount > 0, skills empty)", () => {
		const def = makeDef({ id: "failed-enum", displayName: "Failed Enum" })

		// Simulate an enumeration failure: the skills directory exists and
		// contains skill-looking entries (skillCount counts raw subdirectories),
		// but the loader could not read any of them.
		const spy = vi.spyOn(discoveryModule, "discoverAgent").mockReturnValue({
			id: "failed-enum",
			displayName: "Failed Enum",
			mcpServers: {},
			skillCount: 2,
			skills: [],
			skillsDir: "/tmp/failed-enum-skills",
			commandsCount: 0,
		})
		try {
			const result = importDiscover([def])
			// Reported with an empty payload so the client can distinguish
			// "nothing here" from "couldn't read what is here"
			expect(result.apps.map((a) => a.id)).toEqual(["failed-enum"])
			expect(result.apps[0].skills).toEqual([])
		} finally {
			spy.mockRestore()
		}
	})

	it("reports MCP servers with command or URL, never env, headers or tokens", () => {
		const config = join(tempDir, "config.json")
		writeFileSync(
			config,
			JSON.stringify({
				mcpServers: {
					stdio: { command: "cmd", args: ["--x"], env: { SECRET: "s" } },
					http: {
						url: "https://user:pass@mcp.example.com/mcp?key=s3cr3t",
						headers: { Authorization: "Bearer tok" },
					},
				},
			}),
			"utf-8",
		)

		const result = importDiscover([makeDef({ id: "app", displayName: "App", configPaths: [config] })])

		const servers = result.apps[0].mcpServers
		expect(servers).toEqual([
			{ name: "stdio", command: "cmd", sourceAppId: "app", sourceAppName: "App" },
			// URL credentials (userinfo + query string) are redacted before
			// leaving the harness
			{ name: "http", url: "https://mcp.example.com/mcp", sourceAppId: "app", sourceAppName: "App" },
		])
		const serialized = JSON.stringify(servers)
		expect(serialized).not.toContain("SECRET")
		expect(serialized).not.toContain("Bearer")
		expect(serialized).not.toContain("args")
		expect(serialized).not.toContain("s3cr3t")
		expect(serialized).not.toContain("user:pass")
		expect(serialized).not.toContain("key=")
	})

	it("performs no writes — discovery leaves the disk exactly as it found it", () => {
		const config = join(tempDir, ".claude.json")
		writeFileSync(config, JSON.stringify({ mcpServers: { fetch: { command: "fetchy" } } }), "utf-8")
		const skillsDir = join(tempDir, ".claude", "skills")
		writeSkill(skillsDir, "deploy", "name: deploy\ndescription: Ship")
		// The read-only contract: no config file, skills directory, or MCP
		// config may be created or modified by a discovery call.
		mkdirSync(join(tempDir, ".config", "kimchi", "harness"), { recursive: true })
		const mcpConfig = join(tempDir, ".config", "kimchi", "harness", "mcp.json")
		writeFileSync(mcpConfig, JSON.stringify({ mcpServers: {} }), "utf-8")

		const before = snapshotTree(tempDir)
		importDiscover([makeDef({ id: "app", displayName: "App", configPaths: [config], skillsDirs: [skillsDir] })])
		const after = snapshotTree(tempDir)

		expect(after).toEqual(before)
		expect(existsSync(mcpConfig)).toBe(true)
		expect(readFileSync(mcpConfig, "utf-8")).toBe(JSON.stringify({ mcpServers: {} }))
	})

	it("scopes discovery to home-level roots only", () => {
		// Make the harness cwd the fake project so a project-relative probe
		// would find the project skill if the handler ever made one.
		const project = join(tempDir, "project")
		const projectSkills = join(project, ".agents", "skills")
		writeSkill(projectSkills, "proj-only", "name: proj-only\ndescription: Project")
		const homeSkills = join(tempDir, "home-skills")
		writeSkill(homeSkills, "home-only", "name: home-only\ndescription: Home")

		const savedCwd = process.cwd()
		process.chdir(project)
		try {
			const result = importDiscover([
				makeDef({
					id: "agents",
					displayName: "Agents",
					skillsDirs: [{ projectRelative: join(".agents", "skills") }, homeSkills],
				}),
			])
			expect(result.apps[0].skills.map((s) => s.name)).toEqual(["home-only"])
		} finally {
			process.chdir(savedCwd)
		}
	})

	it("resolves roots through discoverAgent with home scope", () => {
		const skillsDir = join(tempDir, "skills")
		const def = makeDef({ id: "app", displayName: "App", skillsDirs: [skillsDir] })

		const spy = vi.spyOn(discoveryModule, "discoverAgent").mockReturnValue({
			id: "app",
			displayName: "App",
			mcpServers: {},
			skillCount: 1,
			skills: [{ name: "solo", description: "Alone", path: join(skillsDir, "solo", "SKILL.md") }],
			skillsDir,
			commandsCount: 0,
		})

		const result = importDiscover([def])

		expect(spy).toHaveBeenCalledWith(def, { scope: "home" })
		expect(result.apps[0].skills).toHaveLength(1)
		spy.mockRestore()
	})

	// Real EACCES against the real filesystem — the mocked test above cannot
	// catch the distinction between "directory empty" and "directory unreadable".
	it.runIf(process.platform !== "win32" && (process.getuid?.() ?? 0) !== 0)(
		"keeps an app whose skills directory exists but is unreadable (real EACCES, not mocked)",
		() => {
			const skillsDir = join(tempDir, "locked")
			mkdirSync(join(skillsDir, "alpha"), { recursive: true })
			chmodSync(skillsDir, 0o000)
			try {
				const result = importDiscover([
					makeDef({ id: "unreadable", displayName: "Unreadable", skillsDirs: [skillsDir] }),
				])
				// skillCount is -1 (existed but unreadable), so the row is kept
				// with an empty payload instead of being dropped
				expect(result.apps.map((a) => a.id)).toEqual(["unreadable"])
				expect(result.apps[0].skills).toEqual([])
				expect(result.apps[0].mcpServers).toEqual([])
			} finally {
				chmodSync(skillsDir, 0o700)
			}
		},
	)

	it("registers and advertises the import_discover capability", () => {
		expect(AVAILABLE_EXT_METHODS.import_discover).toBe(`_${CAPABILITIES_KEY}/import_discover`)
		expect(ADVERTISED_CAPABILITIES.import_discover).toBe(true)
	})
})
