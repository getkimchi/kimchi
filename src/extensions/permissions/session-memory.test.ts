import { describe, expect, it } from "vitest"
import { SessionMemory, suggestBashCommandScopes, suggestScope } from "./session-memory.js"
import type { Rule } from "./types.js"

describe("SessionMemory.addMany", () => {
	it("dedupes rules with identical tool/content/behavior (e.g. `npm install && npm install`)", () => {
		const session = new SessionMemory()
		const rule: Rule = { toolName: "bash", content: "npm install:*", behavior: "allow", source: "session" }
		session.addMany([rule, rule])
		session.addMany([rule])
		expect(session.all()).toEqual([rule])
	})
})

describe("suggestScope", () => {
	it("bash: program + subcommand when second token isn't a flag", () => {
		const s = suggestScope("bash", { command: "git status --short" })
		expect(s.content).toBe("git status:*")
		expect(s.label).toBe("bash(git status:*)")
	})

	it("bash: program-only when second token is a flag", () => {
		const s = suggestScope("bash", { command: "git -c foo" })
		expect(s.content).toBe("git:*")
		expect(s.label).toBe("bash(git:*)")
	})

	it("bash: single-token command", () => {
		const s = suggestScope("bash", { command: "ls" })
		expect(s.content).toBe("ls:*")
	})

	it("file tool: directory glob", () => {
		const s = suggestScope("write", { path: "src/cli.ts" })
		expect(s.content).toBe("src/**")
		expect(s.label).toBe("write(src/**)")
	})

	it("file tool: bare filename", () => {
		const s = suggestScope("read", { path: "README.md" })
		expect(s.content).toBe("README.md")
	})

	it("other tool: just the name", () => {
		const s = suggestScope("web_search", { query: "foo" })
		expect(s.content).toBeUndefined()
		expect(s.label).toBe("web_search")
	})

	it("keeps the env prefix in the bash scope (key and value)", () => {
		const s = suggestScope("bash", { command: "GOWORK=off go test -race" })
		expect(s.content).toBe("GOWORK=off go test:*")
		expect(s.label).toBe("bash(GOWORK=off go test:*)")
		expect(s.wildcardContent).toBe("GOWORK=off go *")
	})

	it("is unchanged for commands with no env prefix", () => {
		const s = suggestScope("bash", { command: "go test --short" })
		expect(s.content).toBe("go test:*")
		expect(s.wildcardContent).toBe("go *")
	})
})

describe("suggestBashCommandScopes", () => {
	it("derives one narrow scope per compound segment", () => {
		const { scopes, scopeable } = suggestBashCommandScopes("cd /tmp && npm install")
		expect(scopeable).toBe(true)
		expect(scopes.map((s) => s.content)).toEqual(["cd /tmp:*", "npm install:*"])
		expect(scopes.map((s) => s.label)).toEqual(["bash(cd /tmp:*)", "bash(npm install:*)"])
		expect(scopes.map((s) => s.wildcardContent)).toEqual(["cd *", "npm *"])
	})

	it.each(["&&", "||", ";"])("splits on the %s operator", (op) => {
		const { scopes, scopeable } = suggestBashCommandScopes(`ls ${op} pwd`)
		expect(scopeable).toBe(true)
		expect(scopes.map((s) => s.content)).toEqual(["ls:*", "pwd:*"])
	})

	it("matches segments so the compound gate can approve a repeat (all must pass)", () => {
		const { scopes } = suggestBashCommandScopes("cd /app && npm install && git status")
		expect(scopes).toHaveLength(3)
	})

	it("marks pipe stages that can execute code unscopeable (derived scopes could never match)", () => {
		const { scopes, scopeable } = suggestBashCommandScopes("cd /tmp && cat server.log | sh")
		expect(scopeable).toBe(false)
		expect(scopes.map((s) => s.content)).toEqual(["cd /tmp:*"])
	})

	it("marks an executable pipeline-only command unscopeable", () => {
		const { scopes, scopeable } = suggestBashCommandScopes("cat server.log | sh")
		expect(scopeable).toBe(false)
		expect(scopes).toEqual([])
	})

	it("scopes the head of a trailing read-only output-filter pipeline", () => {
		const { scopes, scopeable } = suggestBashCommandScopes("cd /tmp && npm install 2>&1 | tail -40")
		expect(scopeable).toBe(true)
		expect(scopes.map((s) => s.content)).toEqual(["cd /tmp:*", "npm install:*"])
	})

	it("treats head + whitelisted filters as one rememberable command", () => {
		const { scopes, scopeable } = suggestBashCommandScopes("cat server.log | tail -20")
		expect(scopeable).toBe(true)
		// cat scopes to program + first arg, same as `cd /tmp` → `cd /tmp:*`.
		expect(scopes.map((s) => s.content)).toEqual(["cat server.log:*"])
	})

	it("scopes the head through chained whitelisted filters", () => {
		const { scopes, scopeable } = suggestBashCommandScopes("npm test 2>&1 | sort -u | head -5")
		expect(scopeable).toBe(true)
		expect(scopes.map((s) => s.content)).toEqual(["npm test:*"])
	})

	it("keeps a non-filter stage after filters unscopeable", () => {
		const { scopes, scopeable } = suggestBashCommandScopes("cd /tmp && npm install 2>&1 | tail -40 | sh")
		expect(scopeable).toBe(false)
		expect(scopes.map((s) => s.content)).toEqual(["cd /tmp:*"])
	})

	it("keeps substitution unscopeable even with a filter tail", () => {
		const { scopes, scopeable } = suggestBashCommandScopes("cat $(ls) | tail")
		expect(scopeable).toBe(false)
		expect(scopes).toEqual([])
	})

	it("marks an env-only command unscopeable", () => {
		const { scopes, scopeable } = suggestBashCommandScopes("FOO=1")
		expect(scopeable).toBe(false)
		expect(scopes).toEqual([])
	})

	it("is identical to suggestScope for a single non-compound command", () => {
		const single = suggestScope("bash", { command: "git status --short" })
		const { scopes, scopeable } = suggestBashCommandScopes("git status --short")
		expect(scopeable).toBe(true)
		expect(scopes).toEqual([single])
	})
})

describe("SessionMemory", () => {
	it("stores and lists rules", () => {
		const mem = new SessionMemory()
		mem.add({ toolName: "bash", content: "git:*", behavior: "allow", source: "session" })
		mem.add({ toolName: "write", content: ".env", behavior: "deny", source: "session" })
		expect(mem.all()).toHaveLength(2)
	})

	it("clear empties the store", () => {
		const mem = new SessionMemory()
		mem.addMany([
			{ toolName: "bash", content: undefined, behavior: "allow", source: "session" },
			{ toolName: "read", content: undefined, behavior: "allow", source: "session" },
		])
		mem.clear()
		expect(mem.all()).toHaveLength(0)
	})
})
