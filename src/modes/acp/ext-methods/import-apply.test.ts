import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentDefinition, DirCandidate } from "../../../agent-discovery/index.js"
import type { ServerEntry } from "../../../extensions/mcp-adapter/types.js"
import { ADVERTISED_CAPABILITIES, AVAILABLE_EXT_METHODS, CAPABILITIES_KEY } from "../capabilities.js"
import { handleImportApply } from "./import-apply.js"

/** Path fragment that makes cpSync throw; set per-test, empty by default. */
const failCopy = vi.hoisted(() => ({ pattern: "" }))

/** When true, the completion writes (skillPaths + migration marker) throw. */
const failConfigWrite = vi.hoisted(() => ({ fail: false }))

/** Path fragment that makes writeJsonObjectFile throw; set per-test, empty by default. */
const failJsonWrite = vi.hoisted(() => ({ pattern: "" }))

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>()
	return {
		...actual,
		cpSync: (src: string, dest: string, opts?: object) => {
			if (failCopy.pattern && src.includes(failCopy.pattern)) throw new Error("simulated copy failure")
			return actual.cpSync(src, dest, opts)
		},
	}
})

vi.mock("../../../config.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../config.js")>()
	return {
		...actual,
		writeSkillPaths: (paths: string[], configPath?: string) => {
			if (failConfigWrite.fail) throw new Error("simulated config write failure")
			return actual.writeSkillPaths(paths, configPath)
		},
		writeMigrationState: (state: Parameters<typeof actual.writeMigrationState>[0], configPath?: string) => {
			if (failConfigWrite.fail) throw new Error("simulated config write failure")
			return actual.writeMigrationState(state, configPath)
		},
		writeJsonObjectFile: (path: string, value: Record<string, unknown>) => {
			if (failJsonWrite.pattern && path.includes(failJsonWrite.pattern))
				throw new Error("simulated mcp config write failure")
			return actual.writeJsonObjectFile(path, value)
		},
	}
})

/**
 * A minimal source-app definition for driving handleImportApply against real
 * temporary directory trees (same shape as the import_discover tests' makeDef).
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

function writeSkill(
	skillsDir: string,
	name: string,
	frontmatter: string,
	extraFile?: { name: string; body: string },
): void {
	mkdirSync(join(skillsDir, name), { recursive: true })
	writeFileSync(join(skillsDir, name, "SKILL.md"), `---\n${frontmatter}\n---\nBody.\n`, "utf-8")
	if (extraFile) {
		writeFileSync(join(skillsDir, name, extraFile.name), extraFile.body, "utf-8")
	}
}

/** Recursive listing of every path in a tree, for byte-for-byte / unchanged assertions. */
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

describe("import_apply", () => {
	let tempDir: string
	let agentDir: string
	let configPath: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-import-apply-"))
		agentDir = join(tempDir, "agent")
		configPath = join(tempDir, "config.json")
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
	})

	function apply(
		params: {
			skills?: Array<{ sourceAppId: string; path: string }>
			mcpServers?: Array<{ sourceAppId: string; name: string }>
		},
		defs: AgentDefinition[],
	) {
		return handleImportApply({ agentDir, configPath, definitions: defs }, params)
	}

	it("copies each selected skill into Kimchi's own skills directory with its tree intact, and it is then discoverable", () => {
		const skillsDir = join(tempDir, "claude-skills")
		writeSkill(skillsDir, "deploy", "name: deploy\ndescription: Ship the service", {
			name: "helpers.txt",
			body: "reference material",
		})

		const result = apply({ skills: [{ sourceAppId: "claude-code", path: join(skillsDir, "deploy", "SKILL.md") }] }, [
			makeDef({ id: "claude-code", skillsDirs: [skillsDir] }),
		])

		expect(result.results).toEqual([
			{
				kind: "skill",
				sourceAppId: "claude-code",
				path: join(skillsDir, "deploy", "SKILL.md"),
				name: "deploy",
				outcome: "imported",
			},
		])

		const copiedSkillMd = join(agentDir, "skills", "deploy", "SKILL.md")
		expect(existsSync(copiedSkillMd)).toBe(true)
		expect(readFileSync(copiedSkillMd, "utf-8")).toBe(readFileSync(join(skillsDir, "deploy", "SKILL.md"), "utf-8"))
		expect(readFileSync(join(agentDir, "skills", "deploy", "helpers.txt"), "utf-8")).toBe("reference material")

		// Discoverable by the harness: the copied skill loads under the same
		// invocation name and description.
		const { skills } = loadSkillsFromDir({ dir: join(agentDir, "skills"), source: join(agentDir, "skills") })
		expect(skills.map((s) => ({ name: s.name, description: s.description }))).toEqual([
			{ name: "deploy", description: "Ship the service" },
		])
	})

	it("never adds a source app's directory to the stored skill paths", () => {
		const skillsDir = join(tempDir, "claude-skills")
		writeSkill(skillsDir, "deploy", "name: deploy\ndescription: Ship")

		apply({ skills: [{ sourceAppId: "claude-code", path: join(skillsDir, "deploy", "SKILL.md") }] }, [
			makeDef({ id: "claude-code", skillsDirs: [skillsDir] }),
		])

		const stored = JSON.parse(readFileSync(configPath, "utf-8")) as { skillPaths?: string[] }
		expect(stored.skillPaths).not.toContain(skillsDir)
		// The skills phase of the terminal wizard must not re-arm either: the
		// key is set even though the user never ran the wizard.
		expect(Array.isArray(stored.skillPaths)).toBe(true)
	})

	it("skips a skill whose destination name already exists in Kimchi, leaving the existing one byte-for-byte unchanged", () => {
		const skillsDir = join(tempDir, "claude-skills")
		writeSkill(skillsDir, "deploy", "name: deploy\ndescription: Source version")
		const destDir = join(agentDir, "skills", "deploy")
		mkdirSync(destDir, { recursive: true })
		writeFileSync(
			join(destDir, "SKILL.md"),
			"---\nname: deploy\ndescription: Existing Kimchi work\n---\nKeep me.\n",
			"utf-8",
		)
		writeFileSync(join(destDir, "notes.txt"), "precious", "utf-8")

		const before = snapshotTree(destDir)

		const result = apply({ skills: [{ sourceAppId: "claude-code", path: join(skillsDir, "deploy", "SKILL.md") }] }, [
			makeDef({ id: "claude-code", skillsDirs: [skillsDir] }),
		])

		expect(result.results).toEqual([
			{
				kind: "skill",
				sourceAppId: "claude-code",
				path: join(skillsDir, "deploy", "SKILL.md"),
				name: "deploy",
				outcome: "skipped",
				reason: "already installed",
			},
		])
		expect(snapshotTree(destDir)).toEqual(before)
		expect(readFileSync(join(destDir, "SKILL.md"), "utf-8")).toContain("Existing Kimchi work")
		expect(readFileSync(join(destDir, "notes.txt"), "utf-8")).toBe("precious")
	})

	it("skips a selected skill whose source has disappeared since discovery, and the call still succeeds", () => {
		const gonePath = join(tempDir, "vanished-skills", "ghost", "SKILL.md")

		const result = apply({ skills: [{ sourceAppId: "claude-code", path: gonePath }] }, [makeDef({ id: "claude-code" })])

		expect(result.results).toEqual([
			{
				kind: "skill",
				sourceAppId: "claude-code",
				path: gonePath,
				// Identified by source app + path; the client already knows the
				// name from discover, so none is echoed.
				outcome: "skipped",
				reason: "not found at apply time",
			},
		])
		expect(existsSync(agentDir)).toBe(false)
	})

	it("a failing item is reported as an error and does not prevent the remaining items from being written", () => {
		const skillsDir = join(tempDir, "claude-skills")
		writeSkill(skillsDir, "first", "name: first\ndescription: Lands fine")
		writeSkill(skillsDir, "second", "name: second\ndescription: Copy explodes")

		// Make cpSync throw for the second skill's source only.
		failCopy.pattern = "second"
		try {
			const result = apply(
				{
					skills: [
						{ sourceAppId: "claude-code", path: join(skillsDir, "first", "SKILL.md") },
						{ sourceAppId: "claude-code", path: join(skillsDir, "second", "SKILL.md") },
					],
				},
				[makeDef({ id: "claude-code", skillsDirs: [skillsDir] })],
			)

			expect(result.results).toEqual([
				{
					kind: "skill",
					sourceAppId: "claude-code",
					path: join(skillsDir, "first", "SKILL.md"),
					name: "first",
					outcome: "imported",
				},
				{
					kind: "skill",
					sourceAppId: "claude-code",
					path: join(skillsDir, "second", "SKILL.md"),
					name: "second",
					outcome: "error",
					reason: "simulated copy failure",
				},
			])
			expect(existsSync(join(agentDir, "skills", "first", "SKILL.md"))).toBe(true)
			expect(existsSync(join(agentDir, "skills", "second"))).toBe(false)
		} finally {
			failCopy.pattern = ""
		}
	})

	it("adds selected MCP servers to Kimchi's MCP config with their full entries", () => {
		const config = join(tempDir, "claude.json")
		writeFileSync(
			config,
			JSON.stringify({ mcpServers: { fetch: { command: "fetchy", args: ["--fast"], env: { TOKEN: "t" } } } }),
			"utf-8",
		)

		const result = apply({ mcpServers: [{ sourceAppId: "claude-code", name: "fetch" }] }, [
			makeDef({ id: "claude-code", configPaths: [config] }),
		])

		expect(result.results).toEqual([
			{ kind: "mcpServer", sourceAppId: "claude-code", name: "fetch", outcome: "imported" },
		])
		const mcpConfig = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf-8")) as {
			mcpServers: Record<string, ServerEntry>
		}
		expect(mcpConfig.mcpServers.fetch).toEqual({ command: "fetchy", args: ["--fast"], env: { TOKEN: "t" } })
	})

	it("preserves an MCP server already present under the same name, and the imported one is not written", () => {
		const config = join(tempDir, "claude.json")
		writeFileSync(config, JSON.stringify({ mcpServers: { fetch: { command: "fetchy" } } }), "utf-8")
		const mcpJson = join(agentDir, "mcp.json")
		mkdirSync(agentDir, { recursive: true })
		writeFileSync(mcpJson, JSON.stringify({ mcpServers: { fetch: { command: "mine" } } }), "utf-8")

		const result = apply({ mcpServers: [{ sourceAppId: "claude-code", name: "fetch" }] }, [
			makeDef({ id: "claude-code", configPaths: [config] }),
		])

		expect(result.results).toEqual([
			{
				kind: "mcpServer",
				sourceAppId: "claude-code",
				name: "fetch",
				outcome: "skipped",
				reason: "already configured",
			},
		])
		const mcpConfig = JSON.parse(readFileSync(mcpJson, "utf-8")) as { mcpServers: Record<string, ServerEntry> }
		expect(mcpConfig.mcpServers.fetch).toEqual({ command: "mine" })
	})

	it("leaves prefixed connector entries in the MCP config unchanged", () => {
		const config = join(tempDir, "claude.json")
		writeFileSync(config, JSON.stringify({ mcpServers: { fetch: { command: "fetchy" } } }), "utf-8")
		const mcpJson = join(agentDir, "mcp.json")
		mkdirSync(agentDir, { recursive: true })
		const connectorEntry = { url: "https://studio.kimchi.dev/mcp", headers: { Authorization: "Bearer s" } }
		writeFileSync(
			mcpJson,
			JSON.stringify({ mcpServers: { "studio-connector": connectorEntry }, settings: { toolPrefix: "server" } }),
			"utf-8",
		)

		apply({ mcpServers: [{ sourceAppId: "claude-code", name: "fetch" }] }, [
			makeDef({ id: "claude-code", configPaths: [config] }),
		])

		const mcpConfig = JSON.parse(readFileSync(mcpJson, "utf-8")) as {
			mcpServers: Record<string, ServerEntry>
			settings?: unknown
		}
		// The prefixed entry and sibling settings survive the import untouched.
		expect(mcpConfig.mcpServers["studio-connector"]).toEqual(connectorEntry)
		expect(mcpConfig.settings).toEqual({ toolPrefix: "server" })
		expect(mcpConfig.mcpServers.fetch).toEqual({ command: "fetchy" })
	})

	it("writes mcp.json owner-only (0600) — imported entries carry plaintext credentials", () => {
		const config = join(tempDir, "claude.json")
		writeFileSync(
			config,
			JSON.stringify({ mcpServers: { fetch: { command: "fetchy", env: { TOKEN: "t" } } } }),
			"utf-8",
		)

		apply({ mcpServers: [{ sourceAppId: "claude-code", name: "fetch" }] }, [
			makeDef({ id: "claude-code", configPaths: [config] }),
		])

		const mcpJson = join(agentDir, "mcp.json")
		expect(existsSync(mcpJson)).toBe(true)
		// Same hardening config.ts applies to config.json (API key, git tokens):
		// the rename may inherit umask perms, so the mode must be tightened
		// explicitly.
		expect(statSync(mcpJson).mode & 0o777).toBe(0o600)
	})

	it("cannot import an MCP server entry discover would never report (no command and no url)", () => {
		const config = join(tempDir, "claude.json")
		writeFileSync(config, JSON.stringify({ mcpServers: { broken: { args: ["--x"] } } }), "utf-8")

		const result = apply({ mcpServers: [{ sourceAppId: "claude-code", name: "broken" }] }, [
			makeDef({ id: "claude-code", configPaths: [config] }),
		])

		// import_discover drops this entry, so apply must not accept it by name
		// either — the two methods agree on what a selectable server is.
		expect(result.results).toEqual([
			{
				kind: "mcpServer",
				sourceAppId: "claude-code",
				name: "broken",
				outcome: "skipped",
				reason: "not found at apply time",
			},
		])
		expect(existsSync(join(agentDir, "mcp.json"))).toBe(false)
	})

	it("cannot import an MCP server whose command/url are empty strings — the same falsy rule as discover", () => {
		const config = join(tempDir, "claude.json")
		writeFileSync(config, JSON.stringify({ mcpServers: { empty: { command: "" }, blank: { url: "" } } }), "utf-8")

		const result = apply(
			{
				mcpServers: [
					{ sourceAppId: "claude-code", name: "empty" },
					{ sourceAppId: "claude-code", name: "blank" },
				],
			},
			[makeDef({ id: "claude-code", configPaths: [config] })],
		)

		// import_discover treats an empty-string command/url as just as
		// unactionable as an absent one (falsy check), so apply must too.
		expect(result.results).toEqual([
			{
				kind: "mcpServer",
				sourceAppId: "claude-code",
				name: "empty",
				outcome: "skipped",
				reason: "not found at apply time",
			},
			{
				kind: "mcpServer",
				sourceAppId: "claude-code",
				name: "blank",
				outcome: "skipped",
				reason: "not found at apply time",
			},
		])
		expect(existsSync(join(agentDir, "mcp.json"))).toBe(false)
	})

	it("starts fresh when the existing mcp.json is corrupt, and still imports", () => {
		const config = join(tempDir, "claude.json")
		writeFileSync(config, JSON.stringify({ mcpServers: { fetch: { command: "fetchy" } } }), "utf-8")
		const mcpJson = join(agentDir, "mcp.json")
		mkdirSync(agentDir, { recursive: true })
		writeFileSync(mcpJson, "{ not json", "utf-8")

		const result = apply({ mcpServers: [{ sourceAppId: "claude-code", name: "fetch" }] }, [
			makeDef({ id: "claude-code", configPaths: [config] }),
		])

		expect(result.results).toEqual([
			{ kind: "mcpServer", sourceAppId: "claude-code", name: "fetch", outcome: "imported" },
		])
		const mcpConfig = JSON.parse(readFileSync(mcpJson, "utf-8")) as { mcpServers: Record<string, ServerEntry> }
		expect(mcpConfig.mcpServers.fetch).toEqual({ command: "fetchy" })
	})

	it("starts fresh when mcpServers is a non-object (parses but corrupt), without persisting garbage", () => {
		const config = join(tempDir, "claude.json")
		writeFileSync(config, JSON.stringify({ mcpServers: { fetch: { command: "fetchy" } } }), "utf-8")
		const mcpJson = join(agentDir, "mcp.json")
		mkdirSync(agentDir, { recursive: true })
		// Parses fine but mcpServers is a scalar: object-spreading it would
		// write garbage numeric keys back into the user's mcp.json.
		writeFileSync(mcpJson, JSON.stringify({ mcpServers: "oops", settings: { toolPrefix: "server" } }), "utf-8")

		const result = apply({ mcpServers: [{ sourceAppId: "claude-code", name: "fetch" }] }, [
			makeDef({ id: "claude-code", configPaths: [config] }),
		])

		expect(result.results).toEqual([
			{ kind: "mcpServer", sourceAppId: "claude-code", name: "fetch", outcome: "imported" },
		])
		const mcpConfig = JSON.parse(readFileSync(mcpJson, "utf-8")) as {
			mcpServers: Record<string, ServerEntry>
			settings?: unknown
		}
		expect(mcpConfig.mcpServers).toEqual({ fetch: { command: "fetchy" } })
		// Sibling top-level keys survive the recovery.
		expect(mcpConfig.settings).toEqual({ toolPrefix: "server" })
	})

	it("downgrades imported MCP servers to error with a warning when the mcp.json write fails", () => {
		const config = join(tempDir, "claude.json")
		writeFileSync(config, JSON.stringify({ mcpServers: { fetch: { command: "fetchy" } } }), "utf-8")
		const skillsDir = join(tempDir, "claude-skills")
		writeSkill(skillsDir, "deploy", "name: deploy\ndescription: Ship")

		failJsonWrite.pattern = "mcp.json"
		try {
			const result = apply(
				{
					skills: [{ sourceAppId: "claude-code", path: join(skillsDir, "deploy", "SKILL.md") }],
					mcpServers: [{ sourceAppId: "claude-code", name: "fetch" }],
				},
				[makeDef({ id: "claude-code", configPaths: [config], skillsDirs: [skillsDir] })],
			)

			// The skill landed; the MCP server did not — reported honestly.
			expect(result.results).toEqual([
				{
					kind: "skill",
					sourceAppId: "claude-code",
					path: join(skillsDir, "deploy", "SKILL.md"),
					name: "deploy",
					outcome: "imported",
				},
				{
					kind: "mcpServer",
					sourceAppId: "claude-code",
					name: "fetch",
					outcome: "error",
					reason: "MCP config write failed: simulated mcp config write failure",
				},
			])
			expect(result.warnings).toEqual(["Failed to persist the MCP config: simulated mcp config write failure"])
			// The completion writes still ran — the marker is set, so the
			// terminal wizard does not re-ask despite the partial import.
			const stored = JSON.parse(readFileSync(configPath, "utf-8")) as { migrationState?: string }
			expect(stored.migrationState).toBe("done")
		} finally {
			failJsonWrite.pattern = ""
		}
	})

	it("reports persistence failures as warnings and still returns the per-item results", () => {
		const skillsDir = join(tempDir, "claude-skills")
		writeSkill(skillsDir, "deploy", "name: deploy\ndescription: Ship")

		failConfigWrite.fail = true
		try {
			const result = apply({ skills: [{ sourceAppId: "claude-code", path: join(skillsDir, "deploy", "SKILL.md") }] }, [
				makeDef({ id: "claude-code", skillsDirs: [skillsDir] }),
			])

			// Partial outcomes are reported, not hidden: the skill landed and the
			// client hears about it, with a warning naming what could not persist.
			expect(result.results).toEqual([
				{
					kind: "skill",
					sourceAppId: "claude-code",
					path: join(skillsDir, "deploy", "SKILL.md"),
					name: "deploy",
					outcome: "imported",
				},
			])
			expect(result.warnings).toEqual([
				"Failed to persist skill paths: simulated config write failure",
				"Failed to persist the migration marker: simulated config write failure",
			])
		} finally {
			failConfigWrite.fail = false
		}
	})

	it("sets the migration marker even when the batch contained an error item", () => {
		const skillsDir = join(tempDir, "claude-skills")
		writeSkill(skillsDir, "first", "name: first\ndescription: Lands fine")
		writeSkill(skillsDir, "second", "name: second\ndescription: Copy explodes")

		failCopy.pattern = "second"
		try {
			apply(
				{
					skills: [
						{ sourceAppId: "claude-code", path: join(skillsDir, "first", "SKILL.md") },
						{ sourceAppId: "claude-code", path: join(skillsDir, "second", "SKILL.md") },
					],
				},
				[makeDef({ id: "claude-code", skillsDirs: [skillsDir] })],
			)

			const stored = JSON.parse(readFileSync(configPath, "utf-8")) as { migrationState?: string }
			expect(stored.migrationState).toBe("done")
		} finally {
			failCopy.pattern = ""
		}
	})

	it("merges stored skill paths instead of replacing them — a hand-added custom path survives", () => {
		writeFileSync(
			configPath,
			JSON.stringify({ skillPaths: ["/my/custom/skills", ".config/kimchi/harness/skills"] }),
			"utf-8",
		)
		const skillsDir = join(tempDir, "claude-skills")
		writeSkill(skillsDir, "deploy", "name: deploy\ndescription: Ship")

		apply({ skills: [{ sourceAppId: "claude-code", path: join(skillsDir, "deploy", "SKILL.md") }] }, [
			makeDef({ id: "claude-code", skillsDirs: [skillsDir] }),
		])

		const stored = JSON.parse(readFileSync(configPath, "utf-8")) as { skillPaths?: string[] }
		expect(stored.skillPaths).toContain("/my/custom/skills")
		expect(stored.skillPaths).toContain(".config/kimchi/harness/skills")
	})

	it("sets the migration marker on completion, including when the batch contained skipped items", () => {
		const skillsDir = join(tempDir, "claude-skills")
		writeSkill(skillsDir, "deploy", "name: deploy\ndescription: Ship")
		const destDir = join(agentDir, "skills", "deploy")
		writeSkill(destDir, "unused", "name: deploy\ndescription: Already here")

		apply(
			{
				skills: [{ sourceAppId: "claude-code", path: join(skillsDir, "deploy", "SKILL.md") }],
				mcpServers: [{ sourceAppId: "claude-code", name: "vanished" }],
			},
			[makeDef({ id: "claude-code", skillsDirs: [skillsDir] })],
		)

		const stored = JSON.parse(readFileSync(configPath, "utf-8")) as { migrationState?: string }
		expect(stored.migrationState).toBe("done")
	})

	it("completes with an empty selection, still satisfying the migration marker", () => {
		const result = apply({}, [makeDef({ id: "claude-code" })])

		expect(result.results).toEqual([])
		const stored = JSON.parse(readFileSync(configPath, "utf-8")) as { migrationState?: string }
		expect(stored.migrationState).toBe("done")
	})

	it("rejects malformed selections with invalid params", () => {
		const badSkill = { sourceAppId: 42, path: "/x" } as unknown as { sourceAppId: string; path: string }
		const emptyName = { sourceAppId: "a", name: "" } as unknown as { sourceAppId: string; name: string }
		expect(() => apply({ skills: [badSkill] }, [])).toThrow(/sourceAppId/)
		expect(() => apply({ mcpServers: [emptyName] }, [])).toThrow(/name/)
		expect(() => apply({ skills: "nope" as unknown as Array<{ sourceAppId: string; path: string }> }, [])).toThrow(
			/must be an array/,
		)
	})

	it("registers and advertises the import_apply capability", () => {
		expect(AVAILABLE_EXT_METHODS.import_apply).toBe(`_${CAPABILITIES_KEY}/import_apply`)
		expect(ADVERTISED_CAPABILITIES.import_apply).toBe(true)
	})
})
