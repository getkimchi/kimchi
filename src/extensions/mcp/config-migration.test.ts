import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { MIGRATION_REPORT, MIGRATION_STAMP, runNativeMcpMigration, runProjectMcpMigration } from "./config-migration.js"

function migrationIssues(result: ReturnType<typeof runNativeMcpMigration>) {
	const report = result.report
	if (!report) throw new Error("expected migration report")
	return report.issues
}

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "mcp-migration-"))
	const agentDir = join(root, "harness")
	mkdirSync(agentDir, { recursive: true })
	const project = join(root, "work", "proj")
	mkdirSync(join(project, ".kimchi"), { recursive: true })
	return { root, agentDir, project }
}

function writeJson(path: string, value: unknown) {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

describe("runNativeMcpMigration", () => {
	it("translates adapter fields in the global config and reports drops", () => {
		const { agentDir, project } = fixture()
		writeJson(join(agentDir, "mcp.json"), {
			mcpServers: {
				docs: {
					url: "https://example.com/mcp",
					disabled: true,
					requestTimeoutMs: 20_000,
					directTools: true,
					oauth: true,
					lifecycle: "keep-alive",
					caFile: "/tmp/ca.pem",
				},
				bearer: { url: "https://x.test/mcp", bearerTokenEnv: "MY_TOKEN" },
				limited: { command: "srv", includeTools: ["a"], excludeTools: ["b"] },
			},
			settings: { autoEnableCodemode: true, notifyOnStartupConnect: false },
			imports: ["claude-code"],
		})
		const result = runNativeMcpMigration({ agentDir, cwd: project })
		expect(result.migrated).toBe(true)

		const migrated = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"))
		expect(migrated.autoEnableCodemode).toBe(true)
		expect(migrated.settings).toBeUndefined()
		expect(migrated.imports).toBeUndefined()

		const docs = migrated.mcpServers.docs
		expect(docs.enabled).toBe(false)
		expect(docs.timeout).toBe(20)
		expect(docs.exposure).toBe("direct")
		expect(docs.oauth).toBeUndefined()
		expect(docs.lifecycle).toBeUndefined()
		expect(docs.caFile).toBeUndefined()

		expect(migrated.mcpServers.bearer.headers.Authorization).toBe("Bearer ${MY_TOKEN}")

		const limited = migrated.mcpServers.limited
		expect(limited.toolExposure).toEqual({ a: "direct", "*": "hidden", b: "hidden" })

		const report = result.report
		if (!report) throw new Error("expected migration report")
		const fields = report.issues.map((i) => i.field ?? "")
		expect([...fields, ...report.issues.map((i) => i.message)].join(" ")).toMatch(/imports/)
		expect(fields).toContain("settings")
		expect(fields).toContain("lifecycle")
		expect(fields).toContain("caFile")
		expect(fields).toContain("oauth")

		// Backup + 0600.
		expect(existsSync(join(agentDir, "mcp.json.pre-native-migration.bak"))).toBe(true)
		expect(statSync(join(agentDir, "mcp.json")).mode & 0o777).toBe(0o600)
	})

	it("translates literal bearerToken into a header and warns", () => {
		const { agentDir, project } = fixture()
		writeJson(join(agentDir, "mcp.json"), { mcpServers: { s: { url: "https://x", bearerToken: "abc" } } })
		const result = runNativeMcpMigration({ agentDir, cwd: project })
		const migrated = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"))
		expect(migrated.mcpServers.s.headers.Authorization).toBe("Bearer abc")
		expect(migrationIssues(result).some((i) => i.field === "bearerToken" && /permissions/.test(i.message))).toBe(true)
	})

	it("reduces project disable overlays to native overrides", () => {
		const { agentDir, project } = fixture()
		writeJson(join(agentDir, "mcp.json"), { mcpServers: { shared: { command: "a" } } })
		writeJson(join(project, ".kimchi", "mcp.json"), {
			mcpServers: {
				shared: { command: "a", disabled: true },
				local: { command: "b", socket: "/tmp/sock" },
			},
		})
		runNativeMcpMigration({ agentDir, cwd: project })
		const projectConfig = JSON.parse(readFileSync(join(project, ".kimchi", "mcp.json"), "utf8"))
		expect(projectConfig.mcpServers.shared).toEqual({ enabled: false })
		expect(projectConfig.mcpServers.local.command).toBe("b")
		expect(projectConfig.mcpServers.local.socket).toBeUndefined()
	})

	it("inlines legacy global layers (shared-global < harness < adapter-global)", () => {
		const { root, agentDir, project } = fixture()
		const sharedGlobal = join(root, ".config", "mcp", "mcp.json")
		mkdirSync(join(root, ".config", "mcp"), { recursive: true })
		writeJson(sharedGlobal, { mcpServers: { old: { command: "a" }, dup: { command: "low" } } })
		writeJson(join(agentDir, "mcp.json"), { mcpServers: { dup: { command: "high" } } })
		writeJson(join(agentDir, "mcp-adapter.json"), {
			mcpServers: { extra: { command: "b" }, dup: { command: "highest" } },
		})
		const result = runNativeMcpMigration({ agentDir, cwd: project, sharedGlobalPath: sharedGlobal })
		const migrated = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"))
		// adapter-era precedence: shared-global < harness mcp.json < mcp-adapter.json.
		expect(migrated.mcpServers.old.command).toBe("a")
		expect(migrated.mcpServers.extra.command).toBe("b")
		expect(migrated.mcpServers.dup.command).toBe("highest")
		expect(migrationIssues(result).some((i) => i.scope === sharedGlobal)).toBe(true)
		expect(migrationIssues(result).some((i) => i.scope.endsWith("mcp-adapter.json"))).toBe(true)
	})

	it("inlines legacy project layers with .mcp.json below and mcp-adapter.json above native", () => {
		const { agentDir, project } = fixture()
		writeJson(join(agentDir, "mcp.json"), { mcpServers: {} })
		writeJson(join(project, ".mcp.json"), {
			mcpServers: { bottom: { command: "a" }, tie: { command: "low" } },
		})
		writeJson(join(project, ".kimchi", "mcp.json"), { mcpServers: { tie: { command: "mid" } } })
		writeJson(join(project, ".kimchi", "mcp-adapter.json"), {
			mcpServers: { tie: { command: "top" }, above: { command: "b" } },
		})
		runNativeMcpMigration({ agentDir, cwd: project })
		const migrated = JSON.parse(readFileSync(join(project, ".kimchi", "mcp.json"), "utf8"))
		expect(migrated.mcpServers.bottom.command).toBe("a")
		expect(migrated.mcpServers.tie.command).toBe("top")
		expect(migrated.mcpServers.above.command).toBe("b")
	})

	it("downgrades legacy SSE servers to streamable HTTP and reports it", () => {
		const { agentDir, project } = fixture()
		writeJson(join(agentDir, "mcp.json"), {
			mcpServers: { old: { type: "sse", url: "https://example.test/sse" } },
		})
		const result = runNativeMcpMigration({ agentDir, cwd: project })
		const migrated = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"))
		expect(migrated.mcpServers.old).toEqual({ url: "https://example.test/sse" })
		expect(migrationIssues(result).some((i) => i.field === "type" && i.message.includes("legacy SSE transport"))).toBe(
			true,
		)
	})

	it("records an issue when a legacy layer cannot be parsed and keeps going", () => {
		const { root, agentDir, project } = fixture()
		const sharedGlobal = join(root, ".config", "mcp", "mcp.json")
		mkdirSync(join(root, ".config", "mcp"), { recursive: true })
		writeFileSync(sharedGlobal, "{ nope")
		writeJson(join(agentDir, "mcp.json"), { mcpServers: { keep: { command: "x" } } })
		const result = runNativeMcpMigration({ agentDir, cwd: project, sharedGlobalPath: sharedGlobal })
		const migrated = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"))
		expect(migrated.mcpServers.keep.command).toBe("x")
		expect(migrationIssues(result).some((i) => i.scope === sharedGlobal && /NOT inlined/.test(i.message))).toBe(true)
	})

	it("is idempotent (stamp) and only walks cwd ancestors for project files", () => {
		const { agentDir, root, project } = fixture()
		writeJson(join(agentDir, "mcp.json"), { mcpServers: { a: { command: "x", lifecycle: "eager" } } })
		const other = join(root, "elsewhere", ".kimchi")
		mkdirSync(other, { recursive: true })
		writeJson(join(other, "mcp.json"), { mcpServers: { b: { command: "y", socket: "/s" } } })

		const first = runNativeMcpMigration({ agentDir, cwd: project })
		expect(first.migrated).toBe(true)
		expect(existsSync(join(agentDir, MIGRATION_STAMP))).toBe(true)
		// The out-of-cwd project was not touched.
		expect(JSON.parse(readFileSync(join(other, "mcp.json"), "utf8")).mcpServers.b.socket).toBe("/s")

		const second = runNativeMcpMigration({ agentDir, cwd: join(root, "elsewhere") })
		expect(second.migrated).toBe(false)
	})

	it("records failures as issues without blocking other files", () => {
		const { agentDir, project } = fixture()
		writeFileSync(join(agentDir, "mcp.json"), "{ not json")
		writeJson(join(project, ".kimchi", "mcp.json"), { mcpServers: { ok: { command: "x" } } })
		const result = runNativeMcpMigration({ agentDir, cwd: project })
		expect(result.migrated).toBe(true)
		expect(migrationIssues(result).some((i) => i.scope === "global" && /failed to translate/.test(i.message))).toBe(
			true,
		)
		const projectConfig = JSON.parse(readFileSync(join(project, ".kimchi", "mcp.json"), "utf8"))
		expect(projectConfig.mcpServers.ok.command).toBe("x")
	})

	it("writes no report when nothing was migrated (stamp only)", () => {
		const { agentDir, project } = fixture()
		const result = runNativeMcpMigration({ agentDir, cwd: project })
		expect(result.migrated).toBe(true)
		expect(existsSync(join(agentDir, MIGRATION_REPORT))).toBe(false)
		expect(existsSync(join(agentDir, MIGRATION_STAMP))).toBe(true)
	})

	it("leaves an already-native config untouched (no rewrite, no backup, no report)", () => {
		const { agentDir, project } = fixture()
		const native = {
			mcpServers: {
				fixture: { command: "node", args: ["srv.js"], env: { K: "v" } },
				docs: { url: "https://example.com/mcp", enabled: false, timeout: 20, exposure: "direct" },
			},
		}
		writeJson(join(agentDir, "mcp.json"), native)
		const before = readFileSync(join(agentDir, "mcp.json"), "utf8")
		const result = runNativeMcpMigration({ agentDir, cwd: project })
		expect(result.migrated).toBe(true)
		expect(readFileSync(join(agentDir, "mcp.json"), "utf8")).toBe(before)
		expect(existsSync(join(agentDir, "mcp.json.pre-native-migration.bak"))).toBe(false)
		expect(existsSync(join(agentDir, MIGRATION_REPORT))).toBe(false)
		expect(result.report?.files).toEqual([])
		expect(result.report?.issues).toEqual([])
	})

	it("still reports adapter-only tiers on an otherwise-native config", () => {
		const { agentDir, project } = fixture()
		writeJson(join(agentDir, "mcp.json"), {
			mcpServers: { fixture: { command: "node", args: ["srv.js"] } },
			imports: ["claude-code"],
		})
		const result = runNativeMcpMigration({ agentDir, cwd: project })
		const migrated = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"))
		expect(migrated.imports).toBeUndefined()
		expect(migrationIssues(result).some((i) => i.field === "imports")).toBe(true)
		// The untouched server is not reported as changed.
		expect(result.report?.files[0]?.changedServers).toEqual([])
	})
})

describe("runProjectMcpMigration", () => {
	it("is a no-op until the global one-shot migration has run", () => {
		const { agentDir, project } = fixture()
		writeJson(join(project, ".kimchi", "mcp.json"), {
			mcpServers: { docs: { command: "x", lifecycle: "eager" } },
		})
		expect(runProjectMcpMigration({ agentDir, cwd: project }).migrated).toBe(false)
		expect(JSON.parse(readFileSync(join(project, ".kimchi", "mcp.json"), "utf8")).mcpServers.docs.lifecycle).toBe(
			"eager",
		)
	})

	it("translates a project outside the launch walk, then is idempotent per project", () => {
		const { agentDir, root, project } = fixture()
		writeJson(join(agentDir, "mcp.json"), { mcpServers: { a: { command: "x" } } })
		// The launch one-shot runs in `project`; the ACP session happens in `other`.
		runNativeMcpMigration({ agentDir, cwd: project })
		const other = join(root, "other", ".kimchi")
		mkdirSync(other, { recursive: true })
		writeJson(join(other, "mcp.json"), {
			mcpServers: {
				docs: { url: "https://example.com/mcp", disabled: true, idleTimeout: 60 },
			},
		})

		const first = runProjectMcpMigration({ agentDir, cwd: join(root, "other") })
		expect(first.migrated).toBe(true)
		const migrated = JSON.parse(readFileSync(join(other, "mcp.json"), "utf8"))
		expect(migrated.mcpServers.docs.enabled).toBe(false)
		expect(migrated.mcpServers.docs.idleTimeout).toBeUndefined()

		// Second run must not rewrite (hand edits after the first translation stay).
		writeJson(join(other, "mcp.json"), { mcpServers: { hand: { command: "edited" } } })
		expect(runProjectMcpMigration({ agentDir, cwd: join(root, "other") }).migrated).toBe(false)
		expect(JSON.parse(readFileSync(join(other, "mcp.json"), "utf8")).mcpServers.hand.command).toBe("edited")
	})

	it("folds legacy project layers and appends issues to the existing report", () => {
		const { agentDir, root, project } = fixture()
		writeJson(join(agentDir, "mcp.json"), { mcpServers: {} })
		runNativeMcpMigration({ agentDir, cwd: project })

		const other = join(root, "acp", ".kimchi")
		mkdirSync(other, { recursive: true })
		writeJson(join(root, "acp", ".mcp.json"), { mcpServers: { lower: { command: "l" } } })
		writeJson(join(other, "mcp.json"), { mcpServers: { docs: { command: "d", socket: "/s" } } })

		expect(runProjectMcpMigration({ agentDir, cwd: join(root, "acp") }).migrated).toBe(true)
		const migrated = JSON.parse(readFileSync(join(other, "mcp.json"), "utf8"))
		expect(migrated.mcpServers.docs.command).toBe("d")
		expect(migrated.mcpServers.docs.socket).toBeUndefined()
		expect(migrated.mcpServers.lower.command).toBe("l")

		const report = JSON.parse(readFileSync(join(agentDir, MIGRATION_REPORT), "utf8"))
		expect(report.files.some((f: { path: string }) => f.path === join(other, "mcp.json"))).toBe(true)
		expect(report.issues.some((i: { scope?: string }) => i.scope === join(other, "mcp.json"))).toBe(true)
	})

	it("does nothing for a directory without any MCP config", () => {
		const { agentDir, root, project } = fixture()
		writeJson(join(agentDir, "mcp.json"), { mcpServers: {} })
		runNativeMcpMigration({ agentDir, cwd: project })
		expect(runProjectMcpMigration({ agentDir, cwd: join(root, "empty") }).migrated).toBe(false)
		expect(existsSync(join(agentDir, "mcp-native-migration-projects.json"))).toBe(false)
	})
})

describe("runProjectMcpMigration (already-native no-op)", () => {
	it("records the project without rewriting an already-native project file", () => {
		const { agentDir, project } = fixture()
		writeJson(join(agentDir, MIGRATION_STAMP), "1\n")
		const native = { mcpServers: { local: { command: "b" } } }
		writeJson(join(project, ".kimchi", "mcp.json"), native)
		const before = readFileSync(join(project, ".kimchi", "mcp.json"), "utf8")
		const result = runProjectMcpMigration({ agentDir, cwd: project })
		expect(result.migrated).toBe(true)
		expect(readFileSync(join(project, ".kimchi", "mcp.json"), "utf8")).toBe(before)
		expect(existsSync(join(project, ".kimchi", "mcp.json.pre-native-migration.bak"))).toBe(false)
		const record = JSON.parse(readFileSync(join(agentDir, "mcp-native-migration-projects.json"), "utf8")) as string[]
		expect(record).toContain(project)
	})
})
