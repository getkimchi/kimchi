import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ServerEntry } from "../extensions/mcp-adapter/types.js"
import { hasBearerAuthorizationHeader, resolveDirCandidates, selectDirCandidates } from "./engine.js"
import type { AgentDefinition, DirCandidate } from "./index.js"
import { discoverAgent } from "./index.js"

describe("discoverAgent engine", () => {
	let tempDir: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-engine-test-"))
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
	})

	// A minimal AgentDefinition that exercises each engine path.
	function makeDef(
		overrides?: Partial<{
			configPaths: string[]
			skillsDirs: string[]
			commandsDirs: string[]
			parseConfig: (raw: string) => unknown
		}>,
	): AgentDefinition {
		const parseConfig = overrides?.parseConfig ?? JSON.parse
		return {
			id: "test-agent",
			displayName: "Test Agent",
			configPaths: overrides?.configPaths ?? [],
			skillsDirs: overrides?.skillsDirs ?? [],
			commandsDirs: overrides?.commandsDirs ?? [],
			parseConfig,
			extractServerSources: (parsed: unknown) => {
				if (!parsed || typeof parsed !== "object") return []
				const root = parsed as Record<string, unknown>
				const sources: Array<Record<string, unknown>> = []
				if (root.modern && typeof root.modern === "object" && !Array.isArray(root.modern)) {
					sources.push(root.modern as Record<string, unknown>)
				}
				if (root.legacy && typeof root.legacy === "object" && !Array.isArray(root.legacy)) {
					sources.push(root.legacy as Record<string, unknown>)
				}
				return sources
			},
			transformServer: (raw: unknown, _name: string) => {
				if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
				const r = raw as Record<string, unknown>
				if (r.skip) return undefined
				return { command: String(r.command ?? "") }
			},
		}
	}

	function configPath(name = "config.json"): string {
		return join(tempDir, name)
	}

	function skillsPath(name: string): string {
		return join(tempDir, name)
	}

	// ---------------------------------------------------------------------------
	// E1: every readable config in configPaths contributes; servers are merged
	// ---------------------------------------------------------------------------
	it("E1: every readable config in configPaths contributes; servers are merged", () => {
		const path1 = configPath("a.json")
		const path2 = configPath("b.json")
		writeFileSync(path1, JSON.stringify({ modern: { toolA: { command: "a" } } }))
		writeFileSync(path2, JSON.stringify({ modern: { toolB: { command: "b" } } }))

		const def = makeDef({ configPaths: [path1, path2] })
		const result = discoverAgent(def)

		expect(result.mcpServers.toolA).toMatchObject({ command: "a" })
		expect(result.mcpServers.toolB).toMatchObject({ command: "b" })
	})

	// ---------------------------------------------------------------------------
	// E1b: on per-name collision across files, the earlier configPaths entry wins
	// ---------------------------------------------------------------------------
	it("E1b: on per-name collision across files, the earlier configPaths entry wins", () => {
		const path1 = configPath("a.json")
		const path2 = configPath("b.json")
		writeFileSync(path1, JSON.stringify({ modern: { shared: { command: "first" } } }))
		writeFileSync(path2, JSON.stringify({ modern: { shared: { command: "second" } } }))

		const def = makeDef({ configPaths: [path1, path2] })
		const result = discoverAgent(def)

		expect(result.mcpServers.shared).toMatchObject({ command: "first" })
	})

	// ---------------------------------------------------------------------------
	// E2: unreadable (non-ENOENT) config emits warning, continues to next path
	// ---------------------------------------------------------------------------
	it("E2: unreadable (non-ENOENT) config emits warning, continues to next path", () => {
		// This is hard to trigger without mocking, but we can at least verify
		// ENOENT is silent and the loop continues. Use a path that won't exist.
		const path1 = configPath("none1.json")
		const path2 = configPath("none2.json")
		writeFileSync(path2, JSON.stringify({ modern: { tool: { command: "ok" } } }))

		const def = makeDef({ configPaths: [path1, path2] })
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		const result = discoverAgent(def)

		expect(result.mcpServers.tool).toBeDefined()
		expect(warnSpy).not.toHaveBeenCalled() // ENOENT is silent
		warnSpy.mockRestore()
	})

	// ---------------------------------------------------------------------------
	// E3: unparseable config emits warning, continues to next path
	// ---------------------------------------------------------------------------
	it("E3: unparseable config emits warning, continues to next path", () => {
		const path1 = configPath("bad.json")
		const path2 = configPath("good.json")
		writeFileSync(path1, "{ not json", "utf-8")
		writeFileSync(path2, JSON.stringify({ modern: { tool: { command: "ok" } } }))

		const def = makeDef({ configPaths: [path1, path2] })
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		const result = discoverAgent(def)

		expect(result.mcpServers.tool).toBeDefined()
		expect(warnSpy).toHaveBeenCalled()
		warnSpy.mockRestore()
	})

	// ---------------------------------------------------------------------------
	// E4: first-writer-wins across multiple extractServerSources blocks
	// ---------------------------------------------------------------------------
	it("E4: first-writer-wins across multiple extractServerSources blocks", () => {
		const path = configPath()
		// Uses our makeDef which lists modern first, legacy second.
		// Our def's extractServerSources enumerates modern before legacy.
		// So "tool" in modern should win over "tool" in legacy.
		writeFileSync(
			path,
			JSON.stringify({
				modern: { tool: { command: "winner" } },
				legacy: { tool: { command: "loser" } },
			}),
		)

		const def = makeDef({ configPaths: [path] })
		const result = discoverAgent(def)

		expect(result.mcpServers.tool).toMatchObject({ command: "winner" })
	})

	// ---------------------------------------------------------------------------
	// E5: malformed entries (null, array, string) silently skipped
	// ---------------------------------------------------------------------------
	it("E5: malformed entries (null, array, string) silently skipped", () => {
		const path = configPath()
		writeFileSync(
			path,
			JSON.stringify({
				modern: {
					bad1: null,
					bad2: ["array"],
					bad3: "string",
					good: { command: "ok" },
				},
			}),
		)

		const def = makeDef({ configPaths: [path] })
		const result = discoverAgent(def)

		expect(result.mcpServers.bad1).toBeUndefined()
		expect(result.mcpServers.bad2).toBeUndefined()
		expect(result.mcpServers.bad3).toBeUndefined()
		expect(result.mcpServers.good).toMatchObject({ command: "ok" })
	})

	// ---------------------------------------------------------------------------
	// E6: transformServer returning undefined skips the entry
	// ---------------------------------------------------------------------------
	it("E6: transformServer returning undefined skips the entry", () => {
		const path = configPath()
		writeFileSync(
			path,
			JSON.stringify({
				modern: {
					skipme: { skip: true },
					keepme: { command: "ok" },
				},
			}),
		)

		const def = makeDef({ configPaths: [path] })
		const result = discoverAgent(def)

		expect(result.mcpServers.skipme).toBeUndefined()
		expect(result.mcpServers.keepme).toBeDefined()
	})

	// ---------------------------------------------------------------------------
	// E7: missing skills dir → skillCount: 0, skillsDir undefined, no warn
	// ---------------------------------------------------------------------------
	it("E7: missing skills dir → skillCount: 0, skillsDir undefined, no warn", () => {
		const path = configPath()
		writeFileSync(path, JSON.stringify({ modern: {} }))

		const def = makeDef({
			configPaths: [path],
			skillsDirs: [skillsPath("nonexistent")],
		})
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		const result = discoverAgent(def)

		expect(result.skillCount).toBe(0)
		expect(result.skillsDir).toBeUndefined()
		expect(warnSpy).not.toHaveBeenCalled()
		warnSpy.mockRestore()
	})

	// ---------------------------------------------------------------------------
	// E8: present empty skills dir → skillCount: 0, skillsDir set
	// ---------------------------------------------------------------------------
	it("E8: present empty skills dir → skillCount: 0, skillsDir set", () => {
		const path = configPath()
		writeFileSync(path, JSON.stringify({ modern: {} }))

		const dir = skillsPath("empty-skills")
		mkdirSync(dir, { recursive: true })

		const def = makeDef({ configPaths: [path], skillsDirs: [dir] })
		const result = discoverAgent(def)

		expect(result.skillCount).toBe(0)
		expect(result.skillsDir).toBe(dir)
	})

	// ---------------------------------------------------------------------------
	// E9: skills dir with files (not dirs) → skillCount: 0, skillsDir set
	// ---------------------------------------------------------------------------
	it("E9: skills dir with files (not dirs) → skillCount: 0, skillsDir set", () => {
		const path = configPath()
		writeFileSync(path, JSON.stringify({ modern: {} }))

		const dir = skillsPath("file-only")
		mkdirSync(dir, { recursive: true })
		writeFileSync(join(dir, "README.md"), "readme")

		const def = makeDef({ configPaths: [path], skillsDirs: [dir] })
		const result = discoverAgent(def)

		expect(result.skillCount).toBe(0)
		expect(result.skillsDir).toBe(dir)
	})

	// ---------------------------------------------------------------------------
	// E10: skills dir with N subdirs → skillCount === N, skillsDir set
	// ---------------------------------------------------------------------------
	it("E10: skills dir with N subdirs → skillCount === N, skillsDir set", () => {
		const path = configPath()
		writeFileSync(path, JSON.stringify({ modern: {} }))

		const dir = skillsPath("has-skills")
		mkdirSync(dir, { recursive: true })
		mkdirSync(join(dir, "skill-a"), { recursive: true })
		mkdirSync(join(dir, "skill-b"), { recursive: true })
		mkdirSync(join(dir, "skill-c"), { recursive: true })

		const def = makeDef({ configPaths: [path], skillsDirs: [dir] })
		const result = discoverAgent(def)

		expect(result.skillCount).toBe(3)
		expect(result.skillsDir).toBe(dir)
	})

	// ---------------------------------------------------------------------------
	// E11: empty configPaths and skillsDirs → servers: {}, skillCount: 0
	// ---------------------------------------------------------------------------
	it("E11: empty configPaths and skillsDirs → servers: {}, skillCount: 0", () => {
		const def = makeDef({ configPaths: [], skillsDirs: [] })
		const result = discoverAgent(def)

		expect(result.mcpServers).toEqual({})
		expect(result.skillCount).toBe(0)
		expect(result.skillsDir).toBeUndefined()
	})

	// ---------------------------------------------------------------------------
	// E11b: empty commandsDirs → commandsCount: 0, commandsDir undefined
	// ---------------------------------------------------------------------------
	it("E11b: empty commandsDirs → commandsCount: 0, commandsDir undefined", () => {
		const def = makeDef({ configPaths: [], skillsDirs: [], commandsDirs: [] })
		const result = discoverAgent(def)

		expect(result.commandsCount).toBe(0)
		expect(result.commandsDir).toBeUndefined()
	})

	// ---------------------------------------------------------------------------
	// E11c: missing commands dir → commandsCount: 0, commandsDir undefined
	// ---------------------------------------------------------------------------
	it("E11c: missing commands dir → commandsCount: 0, commandsDir undefined", () => {
		const def = makeDef({ commandsDirs: [join(tempDir, "nonexistent-cmds")] })
		const result = discoverAgent(def)

		expect(result.commandsCount).toBe(0)
		expect(result.commandsDir).toBeUndefined()
	})

	// ---------------------------------------------------------------------------
	// E11d: commands dir with .md files → commandsCount counts only top-level
	// ---------------------------------------------------------------------------
	it("E11d: commands dir with .md files → commandsCount counts only top-level", () => {
		const dir = join(tempDir, "commands")
		mkdirSync(dir, { recursive: true })
		writeFileSync(join(dir, "review.md"), "# review")
		writeFileSync(join(dir, "deploy.md"), "# deploy")
		writeFileSync(join(dir, "ignore.txt"), "not a command")
		const sub = join(dir, "reference")
		mkdirSync(sub, { recursive: true })
		writeFileSync(join(sub, "react.md"), "# react")

		const def = makeDef({ commandsDirs: [dir] })
		const result = discoverAgent(def)

		expect(result.commandsCount).toBe(2)
		expect(result.commandsDir).toBe(dir)
	})

	// ---------------------------------------------------------------------------
	// E11e: commands dir empty → commandsCount: 0, commandsDir set
	// ---------------------------------------------------------------------------
	it("E11e: commands dir empty → commandsCount: 0, commandsDir set", () => {
		const dir = join(tempDir, "empty-cmds")
		mkdirSync(dir, { recursive: true })

		const def = makeDef({ commandsDirs: [dir] })
		const result = discoverAgent(def)

		expect(result.commandsCount).toBe(0)
		expect(result.commandsDir).toBe(dir)
	})

	// ---------------------------------------------------------------------------
	// E12: parseConfig defaults to JSON.parse when omitted
	// ---------------------------------------------------------------------------
	it("E12: parseConfig defaults to JSON.parse when omitted", () => {
		const path = configPath()
		writeFileSync(path, JSON.stringify({ legacy: { tool: { command: "ok" } } }))

		// No parseConfig provided — should use JSON.parse
		const def: AgentDefinition = {
			id: "test",
			displayName: "Test",
			configPaths: [path],
			skillsDirs: [],
			commandsDirs: [],
			extractServerSources: (parsed: unknown) => {
				if (!parsed || typeof parsed !== "object") return []
				const root = parsed as Record<string, unknown>
				if (root.legacy && typeof root.legacy === "object" && !Array.isArray(root.legacy)) {
					return [root.legacy as Record<string, unknown>]
				}
				return []
			},
			transformServer: (raw: unknown, _name: string) => {
				const r = raw as Record<string, unknown>
				return { command: String(r.command ?? "") }
			},
		}

		const result = discoverAgent(def)
		expect(result.mcpServers.tool).toBeDefined()
	})

	describe("discoverAgent skill enumeration and root scoping", () => {
		let tempDir: string
		let savedCwd: string

		beforeEach(() => {
			// realpath: on macOS tmpdir() is a /var symlink, and process.cwd() after
			// chdir reports the /private prefix
			tempDir = realpathSync(mkdtempSync(join(tmpdir(), "kimchi-engine-skills-")))
			savedCwd = process.cwd()
		})

		afterEach(() => {
			process.chdir(savedCwd)
			rmSync(tempDir, { recursive: true, force: true })
		})

		function makeDef(
			overrides?: Partial<{ configPaths: string[]; skillsDirs: DirCandidate[]; commandsDirs: DirCandidate[] }>,
		): AgentDefinition {
			return {
				id: "test-agent",
				displayName: "Test Agent",
				configPaths: overrides?.configPaths ?? [],
				skillsDirs: overrides?.skillsDirs ?? [],
				commandsDirs: overrides?.commandsDirs ?? [],
				extractServerSources: () => [],
				transformServer: () => undefined,
			}
		}

		function writeSkill(skillsDir: string, name: string, frontmatter: string): void {
			mkdirSync(join(skillsDir, name), { recursive: true })
			writeFileSync(join(skillsDir, name, "SKILL.md"), `---\n${frontmatter}\n---\nBody.\n`, "utf-8")
		}

		// S1: invocation name and description come from the skill's frontmatter
		it("S1: enumerates skills with invocation name and description from frontmatter", () => {
			const skillsDir = join(tempDir, "skills")
			writeSkill(skillsDir, "deploy", "name: deploy\ndescription: Ship the service")
			// No frontmatter name → falls back to the directory name
			writeSkill(skillsDir, "review", "description: Review the diff")

			const result = discoverAgent(makeDef({ skillsDirs: [skillsDir] }))

			expect(result.skills).toEqual([
				{ name: "deploy", description: "Ship the service", path: join(skillsDir, "deploy", "SKILL.md") },
				{ name: "review", description: "Review the diff", path: join(skillsDir, "review", "SKILL.md") },
			])
			// skillCount still counts raw subdirectories, unchanged for the wizard
			expect(result.skillCount).toBe(2)
		})

		// S2: a skill whose frontmatter cannot be parsed is omitted; the pass continues
		it("S2: omits a skill whose frontmatter cannot be parsed without failing discovery", () => {
			const skillsDir = join(tempDir, "skills")
			writeSkill(skillsDir, "good", "name: good\ndescription: Fine")
			writeSkill(skillsDir, "broken", "name: [unclosed\ndescription: {{{")

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
			const result = discoverAgent(makeDef({ skillsDirs: [skillsDir] }))
			warnSpy.mockRestore()

			expect(result.skills.map((s) => s.name)).toEqual(["good"])
		})

		// S2b: the loader's diagnostics for omitted skills are surfaced, not dropped —
		// otherwise the skill vanishes from discovery with no observable reason why.
		it("S2b: surfaces loader diagnostics for omitted skills as warnings", () => {
			const skillsDir = join(tempDir, "skills")
			writeSkill(skillsDir, "good", "name: good\ndescription: Fine")
			writeSkill(skillsDir, "broken", "name: [unclosed\ndescription: {{{")

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
			try {
				discoverAgent(makeDef({ skillsDirs: [skillsDir] }))
				const warned = warnSpy.mock.calls.map((call) => call.join(" "))
				expect(warned.some((line) => line.includes("broken"))).toBe(true)
			} finally {
				warnSpy.mockRestore()
			}
		})

		// S3: a skill whose SKILL.md cannot be read is omitted
		it("S3: omits a skill whose SKILL.md cannot be read", () => {
			const skillsDir = join(tempDir, "skills")
			writeSkill(skillsDir, "good", "name: good\ndescription: Fine")
			// SKILL.md as a directory → readFileSync throws EISDIR
			mkdirSync(join(skillsDir, "unreadable", "SKILL.md"), { recursive: true })

			const result = discoverAgent(makeDef({ skillsDirs: [skillsDir] }))

			expect(result.skills.map((s) => s.name)).toEqual(["good"])
		})

		// S4: a source app with no parseable config still reports its skills
		it("S4: reports skills even when the source app has no parseable config", () => {
			const config = join(tempDir, "bad.json")
			writeFileSync(config, "{ not json", "utf-8")
			const skillsDir = join(tempDir, "skills")
			writeSkill(skillsDir, "solo", "name: solo\ndescription: Alone")

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
			const result = discoverAgent(makeDef({ configPaths: [config], skillsDirs: [skillsDir] }))
			warnSpy.mockRestore()

			expect(result.mcpServers).toEqual({})
			expect(result.skills.map((s) => s.name)).toEqual(["solo"])
		})

		// S5: home scope drops project-relative candidates entirely
		it("S5: home scope does not report a skill present solely under a project-relative root", () => {
			const projectSkills = join(tempDir, "project", ".github", "skills")
			writeSkill(projectSkills, "proj", "name: proj\ndescription: Project-only")

			const def = makeDef({ skillsDirs: [{ projectRelative: join(".github", "skills") }] })

			const homeResult = discoverAgent(def, { scope: "home", cwd: join(tempDir, "project") })
			expect(homeResult.skills).toEqual([])
			expect(homeResult.skillCount).toBe(0)
			expect(homeResult.skillsDir).toBeUndefined()

			// The default (TUI) scope still finds it — behaviour deliberately untouched
			const allResult = discoverAgent(def, { cwd: join(tempDir, "project") })
			expect(allResult.skills.map((s) => s.name)).toEqual(["proj"])
			expect(allResult.skillsDir).toBe(projectSkills)
		})

		// S6: home scope still reports skills under a home-level root
		it("S6: home scope reports skills under a home-level root", () => {
			const homeSkills = join(tempDir, "home", ".claude", "skills")
			writeSkill(homeSkills, "dep", "name: dep\ndescription: Dep")

			const def = makeDef({
				skillsDirs: [{ projectRelative: join(".claude", "skills") }, homeSkills],
			})

			const result = discoverAgent(def, { scope: "home", cwd: tempDir })
			expect(result.skills.map((s) => s.name)).toEqual(["dep"])
			expect(result.skillsDir).toBe(homeSkills)
		})

		// S7: project-relative roots resolve per call against the given cwd — the
		// prefactor that retires the module-load cwd freeze
		it("S7: resolves project-relative roots per call, not at module load", () => {
			const dirA = join(tempDir, "a")
			const dirB = join(tempDir, "b")
			mkdirSync(join(dirA, ".warp", "skills", "in-a"), { recursive: true })
			mkdirSync(join(dirB, ".warp", "skills", "in-b"), { recursive: true })

			const def = makeDef({ skillsDirs: [{ projectRelative: join(".warp", "skills") }] })

			expect(discoverAgent(def, { cwd: dirA }).skillsDir).toBe(join(dirA, ".warp", "skills"))
			expect(discoverAgent(def, { cwd: dirB }).skillsDir).toBe(join(dirB, ".warp", "skills"))

			// Default cwd is read at call time: the module was loaded under savedCwd,
			// so a discovery that runs after chdir must see the new directory.
			process.chdir(dirA)
			expect(discoverAgent(def).skillsDir).toBe(join(dirA, ".warp", "skills"))
			process.chdir(dirB)
			expect(discoverAgent(def).skillsDir).toBe(join(dirB, ".warp", "skills"))
		})

		// S8: commands directories honour the same scoping
		it("S8: home scope drops project-relative commands directories", () => {
			const projectCommands = join(tempDir, "project", ".cursor", "commands")
			mkdirSync(projectCommands, { recursive: true })
			writeFileSync(join(projectCommands, "do.md"), "# do", "utf-8")

			const def = makeDef({ commandsDirs: [{ projectRelative: join(".cursor", "commands") }] })

			expect(discoverAgent(def, { scope: "home", cwd: join(tempDir, "project") }).commandsDir).toBeUndefined()
			expect(discoverAgent(def, { cwd: join(tempDir, "project") }).commandsDir).toBe(projectCommands)
		})

		// S8c: symmetric with the configPaths guard — a non-absolute plain-string
		// skills/commands candidate is dropped under home scope, not probed
		// against the ambient cwd
		it("S8c: home scope drops non-absolute plain-string dir candidates instead of probing ambient cwd", () => {
			mkdirSync(join(tempDir, "relative-skills", "alpha"), { recursive: true })
			mkdirSync(join(tempDir, "relative-commands"), { recursive: true })
			writeFileSync(join(tempDir, "relative-commands", "do.md"), "# do", "utf-8")
			const def = makeDef({ skillsDirs: ["relative-skills"], commandsDirs: ["relative-commands"] })

			const savedCwd = process.cwd()
			process.chdir(tempDir)
			try {
				const home = discoverAgent(def, { scope: "home" })
				expect(home.skillsDir).toBeUndefined()
				expect(home.commandsDir).toBeUndefined()
				// The default (wizard) scope still probes them: relative strings pass
				// through raw and are resolved against the ambient cwd inside
				// existsSync (resolveDirCandidates warns about this)
				const all = discoverAgent(def, { scope: "all", cwd: tempDir })
				expect(all.skillsDir).toBe("relative-skills")
				expect(all.commandsDir).toBe("relative-commands")
			} finally {
				process.chdir(savedCwd)
			}
		})

		// S8b: configPaths are home-level absolute by contract — under home scope a
		// relative entry must be skipped, not probed against the ambient cwd.
		it("S8b: home scope skips a non-absolute config path instead of probing it against the ambient cwd", () => {
			// The entry is deliberately relative: written under tempDir, which the
			// test chdirs into, so an ambient-cwd probe would find it.
			const configName = "project-relative-config.json"
			writeFileSync(join(tempDir, configName), JSON.stringify({ mcpServers: { probe: { command: "cmd" } } }), "utf-8")
			const def: AgentDefinition = {
				id: "probe-agent",
				displayName: "Probe Agent",
				configPaths: [configName],
				skillsDirs: [],
				commandsDirs: [],
				extractServerSources: (parsed: unknown) => {
					if (!parsed || typeof parsed !== "object") return []
					const root = parsed as Record<string, unknown>
					return root.mcpServers && typeof root.mcpServers === "object" && !Array.isArray(root.mcpServers)
						? [root.mcpServers as Record<string, unknown>]
						: []
				},
				transformServer: (raw: unknown) =>
					raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as ServerEntry) : undefined,
			}

			const savedCwd = process.cwd()
			process.chdir(tempDir)
			try {
				const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
				let home: ReturnType<typeof discoverAgent>
				let all: ReturnType<typeof discoverAgent>
				try {
					home = discoverAgent(def, { scope: "home" })
					all = discoverAgent(def, { scope: "all", cwd: tempDir })
				} finally {
					warnSpy.mockRestore()
				}
				expect(Object.keys(home.mcpServers)).toEqual([])
				// The default (wizard) scope still reads it
				expect(Object.keys(all.mcpServers)).toEqual(["probe"])
			} finally {
				process.chdir(savedCwd)
			}
		})

		// S9: a winning skills directory that exists but cannot be read must be
		// distinct from an empty one — skillCount -1 so import_discover keeps
		// the app with an empty payload ("couldn't read what is here" vs
		// "nothing here"). Real EACCES, not a mocked discoverAgent.
		const canDenyDirectoryRead = process.platform !== "win32" && (process.getuid?.() ?? 0) !== 0
		it.runIf(canDenyDirectoryRead)(
			"S9: reports skillCount -1 when the winning skills directory exists but is unreadable",
			() => {
				const skillsDir = join(tempDir, "locked")
				mkdirSync(join(skillsDir, "alpha"), { recursive: true })
				chmodSync(skillsDir, 0o000)
				const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
				try {
					const discovery = discoverAgent(makeDef({ skillsDirs: [skillsDir] }), { cwd: tempDir })
					expect(discovery.skillsDir).toBe(skillsDir)
					expect(discovery.skillCount).toBe(-1)
					expect(discovery.skills).toEqual([])
					// One root cause, one warning: enumeration is skipped when the
					// listing already failed — loadSkillsFromDir would hit the same
					// EACCES and emit a second, redundant diagnostic.
					expect(warnSpy).toHaveBeenCalledTimes(1)
				} finally {
					warnSpy.mockRestore()
					chmodSync(skillsDir, 0o700)
				}
			},
		)

		// S9b: count-only callers (telemetry snapshot, wizards) can skip the
		// per-call frontmatter parsing — counts stay identical, enumeration is
		// simply not performed.
		it("S9b: enumerateSkills false skips frontmatter parsing — counts without enumerating", () => {
			const skillsDir = join(tempDir, "skills")
			writeSkill(skillsDir, "deploy", "name: deploy\ndescription: Ship the service")
			writeSkill(skillsDir, "review", "description: Review the diff")
			const def = makeDef({ skillsDirs: [skillsDir] })

			const enumerated = discoverAgent(def)
			expect(enumerated.skillCount).toBe(2)
			expect(enumerated.skills).toHaveLength(2)

			const countOnly = discoverAgent(def, { enumerateSkills: false })
			expect(countOnly.skillCount).toBe(2)
			// Frontmatter is never parsed — no enumerated names, no path work.
			expect(countOnly.skills).toEqual([])
		})

		// S10: process.cwd() throws ENOENT (uv_cwd) when the working directory
		// has been deleted out from under a long-lived process. "home" scope
		// must never touch it — import_discover runs exactly in that environment.
		it("S10: home scope never reads process.cwd(), so a deleted cwd does not crash discovery", () => {
			const doomed = mkdtempSync(join(tmpdir(), "kimchi-deleted-cwd-"))
			process.chdir(doomed)
			rmSync(doomed, { recursive: true, force: true })
			try {
				const def = makeDef({ skillsDirs: [{ projectRelative: join(".x", "skills") }] })
				expect(() => discoverAgent(def, { scope: "home" })).not.toThrow()
				expect(discoverAgent(def, { scope: "home" }).skillsDir).toBeUndefined()
			} finally {
				process.chdir(savedCwd)
			}
		})

		describe("resolveDirCandidates / selectDirCandidates", () => {
			it("resolves plain strings through and project candidates against cwd", () => {
				expect(
					resolveDirCandidates([join(tempDir, "x"), { projectRelative: join(".k", "skills") }], () => "/base"),
				).toEqual([join(tempDir, "x"), join("/base", ".k", "skills")])
				// The cwd getter is only invoked for { projectRelative } candidates
				const getCwd = vi.fn(() => "/base")
				resolveDirCandidates([join(tempDir, "abs")], getCwd)
				expect(getCwd).not.toHaveBeenCalled()
				resolveDirCandidates([{ projectRelative: ".k" }], getCwd)
				expect(getCwd).toHaveBeenCalledTimes(1)
			})

			it("warns on a non-absolute plain-string candidate instead of silently depending on ambient cwd", () => {
				const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
				try {
					expect(resolveDirCandidates(["relative/dir", join(tempDir, "abs")], () => "/base")).toEqual([
						"relative/dir",
						join(tempDir, "abs"),
					])
					expect(warnSpy.mock.calls.some((call) => String(call[0]).includes("relative/dir"))).toBe(true)
				} finally {
					warnSpy.mockRestore()
				}
			})

			it("home scope keeps only absolute string candidates", () => {
				const candidates: DirCandidate[] = [join(tempDir, "home-dir"), "relative/dir", { projectRelative: ".x" }]
				// Symmetric with the configPaths guard: a non-absolute plain string
				// would be probed against the ambient cwd, so home scope drops it
				// instead of merely warning.
				expect(selectDirCandidates(candidates, "home")).toEqual([join(tempDir, "home-dir")])
				expect(selectDirCandidates(candidates, "all")).toEqual(candidates)
			})
		})
	})

	describe("hasBearerAuthorizationHeader (defensive)", () => {
		it("returns true for Authorization: Bearer", () => {
			expect(hasBearerAuthorizationHeader({ Authorization: "Bearer x" })).toBe(true)
		})
		it("is case-insensitive on key and value", () => {
			expect(hasBearerAuthorizationHeader({ authorization: "bearer x" })).toBe(true)
			expect(hasBearerAuthorizationHeader({ AUTHORIZATION: "BEARER x" })).toBe(true)
		})
		it("returns false for Basic auth", () => {
			expect(hasBearerAuthorizationHeader({ Authorization: "Basic dXNlcjpwYXNz" })).toBe(false)
		})
		it("returns false (does not throw) when headers is null", () => {
			expect(hasBearerAuthorizationHeader(null)).toBe(false)
		})
		it("returns false (does not throw) when headers is undefined", () => {
			expect(hasBearerAuthorizationHeader(undefined)).toBe(false)
		})
		it("returns false (does not throw) when headers is an array", () => {
			expect(hasBearerAuthorizationHeader(["Authorization", "Bearer x"])).toBe(false)
		})
		it("returns false (does not throw) when headers is a primitive", () => {
			expect(hasBearerAuthorizationHeader("Bearer x")).toBe(false)
			expect(hasBearerAuthorizationHeader(42)).toBe(false)
		})
		it("ignores non-string header values without throwing", () => {
			expect(hasBearerAuthorizationHeader({ Authorization: 123 })).toBe(false)
			expect(hasBearerAuthorizationHeader({ Authorization: null })).toBe(false)
		})
	})
})
