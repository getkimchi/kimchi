import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { discoverAgentRules } from "./discovery.js"
import { AgentRulesEngine } from "./engine.js"
import type { AgentRule } from "./types.js"

const base = join(tmpdir(), `kimchi-agents-rules-${Date.now()}`)
// Controlled ancestor chain: <base>/proj/pkg — walk is bounded by rootLimit=<base>.
const proj = join(base, "proj")
const pkg = join(proj, "pkg")

function write(dir: string, name: string, content: string): string {
	mkdirSync(dir, { recursive: true })
	const filePath = join(dir, name)
	writeFileSync(filePath, content)
	return filePath
}

function names(rules: AgentRule[]): string[] {
	return rules.map((r) => r.name)
}

beforeEach(() => {
	rmSync(base, { recursive: true, force: true })
	mkdirSync(pkg, { recursive: true })
})

afterEach(() => {
	rmSync(base, { recursive: true, force: true })
})

describe("discoverAgentRules", () => {
	it("returns empty rules when no .agents directory exists", () => {
		const result = discoverAgentRules(pkg, { rootLimit: base })
		expect(result.rules).toEqual([])
		expect(result.diagnostics).toEqual([])
	})

	it("returns empty rules when .agents/rules exists but is empty", () => {
		mkdirSync(join(pkg, ".agents", "rules"), { recursive: true })
		const result = discoverAgentRules(pkg, { rootLimit: base })
		expect(result.rules).toEqual([])
		expect(result.diagnostics).toEqual([])
	})

	it("discovers .mdc and .md files from the nearest .agents/rules", () => {
		const rulesDir = join(pkg, ".agents", "rules")
		const mdc = write(rulesDir, "api.mdc", "---\ndescription: API\n---\n# API")
		const md = write(rulesDir, "infra.md", "---\ndescription: Infra\n---\n# Infra")
		const txt = write(rulesDir, "ignored.txt", "not a rule")

		const result = discoverAgentRules(pkg, { rootLimit: base })
		expect(names(result.rules).sort()).toEqual(["api", "infra"])
		const paths = result.rules.map((r) => r.path)
		expect(paths).toContain(mdc)
		expect(paths).toContain(md)
		expect(paths).not.toContain(txt)
	})

	it("derives activation modes from frontmatter", () => {
		const rulesDir = join(pkg, ".agents", "rules")
		write(rulesDir, "always.mdc", "---\nalwaysApply: true\n---\nalways body")
		write(rulesDir, "globbed.mdc", '---\nglobs: "src/**/*.ts"\n---\nglob body')
		write(rulesDir, "available.mdc", "# no frontmatter")

		const result = discoverAgentRules(pkg, { rootLimit: base })
		const byName = new Map(result.rules.map((r) => [r.name, r]))
		expect(byName.get("always")?.mode).toBe("always")
		expect(byName.get("always")?.body).toBe("always body")
		expect(byName.get("globbed")?.mode).toBe("glob")
		expect(byName.get("globbed")?.globs).toEqual(["src/**/*.ts"])
		expect(byName.get("available")?.mode).toBe("available")
		expect(byName.get("available")?.description).toBeUndefined()
	})

	it("orders rules ancestor-first when .agents/rules exists at multiple levels", () => {
		write(join(proj, ".agents", "rules"), "root-level.mdc", "---\ndescription: baseline\n---\nbaseline")
		write(join(pkg, ".agents", "rules"), "near-level.mdc", "---\ndescription: refine\n---\nrefine")

		const result = discoverAgentRules(pkg, { rootLimit: base })
		expect(names(result.rules)).toEqual(["root-level", "near-level"])
	})

	it("sets baseDir to the directory containing .agents for each rule", () => {
		write(join(proj, ".agents", "rules"), "root-level.mdc", "body")
		write(join(pkg, ".agents", "rules"), "near-level.mdc", "body")

		const result = discoverAgentRules(pkg, { rootLimit: base })
		const byName = new Map(result.rules.map((r) => [r.name, r]))
		expect(byName.get("root-level")?.baseDir).toBe(proj)
		expect(byName.get("near-level")?.baseDir).toBe(pkg)
	})

	it("scans subdirectories inside rules/ recursively", () => {
		const rulesDir = join(pkg, ".agents", "rules")
		write(join(rulesDir, "api"), "nested.mdc", "---\ndescription: nested\n---\nnested")
		write(join(rulesDir, "api", "deep"), "deeper.md", "---\ndescription: deeper\n---\ndeep")

		const result = discoverAgentRules(pkg, { rootLimit: base })
		expect(names(result.rules).sort()).toEqual(["deeper", "nested"])
	})

	it("skips hidden files and directories", () => {
		const rulesDir = join(pkg, ".agents", "rules")
		write(rulesDir, "visible.mdc", "body")
		write(rulesDir, ".hidden.mdc", "body")
		write(join(rulesDir, ".hidden-dir"), "inside.mdc", "body")

		const result = discoverAgentRules(pkg, { rootLimit: base })
		expect(names(result.rules)).toEqual(["visible"])
	})

	it("records a diagnostic and keeps discovering when a file has malformed frontmatter", () => {
		const rulesDir = join(pkg, ".agents", "rules")
		const bad = write(rulesDir, "bad.mdc", "---\ndescription: [unclosed\n---\nbody")
		const good = write(rulesDir, "good.mdc", "---\ndescription: good\n---\nbody")

		const result = discoverAgentRules(pkg, { rootLimit: base })
		expect(names(result.rules)).toEqual(["good"])
		expect(result.diagnostics).toHaveLength(1)
		expect(result.diagnostics[0]?.path).toBe(bad)
		expect(result.diagnostics[0]?.message).toMatch(/bad\.mdc/)
		expect(result.diagnostics[0]?.message).toMatch(/invalid YAML/)
		expect(good).toBeDefined()
	})

	it("parses comma-separated globs from a discovered file", () => {
		write(join(pkg, ".agents", "rules"), "multi.mdc", '---\nglobs: "*.ts, *.tsx"\n---\nbody')

		const result = discoverAgentRules(pkg, { rootLimit: base })
		expect(result.rules[0]?.globs).toEqual(["*.ts", "*.tsx"])
	})

	it("coerces alwaysApply string values from a discovered file", () => {
		write(join(pkg, ".agents", "rules"), "str.mdc", '---\nalwaysApply: "true"\n---\nbody')

		const result = discoverAgentRules(pkg, { rootLimit: base })
		expect(result.rules[0]?.mode).toBe("always")
	})

	it("does not walk above rootLimit", () => {
		// Rules above the limit (at <base>) must not be found when walking from
		// <base>/proj with rootLimit=<base>/proj.
		write(join(base, ".agents", "rules"), "outside.mdc", "body")
		const result = discoverAgentRules(proj, { rootLimit: proj })
		expect(names(result.rules)).toEqual([])
	})

	it("returns deterministic ordering within one rules directory", () => {
		const rulesDir = join(pkg, ".agents", "rules")
		for (const name of ["c.mdc", "a.mdc", "b.md"]) write(rulesDir, name, "body")

		const result = discoverAgentRules(pkg, { rootLimit: base })
		expect(names(result.rules)).toEqual(["a", "b", "c"])
	})

	it("loads and activates the bundled README example end-to-end", () => {
		// The reference example doubles as a fixture: it must survive discovery
		// (valid frontmatter) and activate on the glob it declares.
		const moduleDir = dirname(fileURLToPath(import.meta.url))
		const rulesDir = join(pkg, ".agents", "rules")
		mkdirSync(rulesDir, { recursive: true })
		copyFileSync(join(moduleDir, "README-example.mdc"), join(rulesDir, "catalog-doc-mirror.mdc"))

		const result = discoverAgentRules(pkg, { rootLimit: base })
		expect(result.diagnostics).toEqual([])
		expect(names(result.rules)).toEqual(["catalog-doc-mirror"])

		const rule = result.rules[0] as AgentRule
		expect(rule.mode).toBe("glob")
		expect(rule.description).toContain("docs/catalog-architecture.md")
		expect(rule.body).toContain("# Catalog documentation mirror")

		// The declared glob activates on a file inside services/catalog/.
		const engine = new AgentRulesEngine(result.rules, pkg)
		const activated = engine.handleToolCall("edit", { path: join(pkg, "services/catalog/handlers/order.ts") })
		expect(activated.map((r) => r.name)).toEqual(["catalog-doc-mirror"])
		// ...and not on files outside it.
		expect(engine.handleToolCall("edit", { path: join(pkg, "services/checkout/handlers/order.ts") })).toEqual([])
	})
})
