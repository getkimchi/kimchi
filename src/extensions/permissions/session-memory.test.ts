import { describe, expect, it } from "vitest"
import { SessionMemory, suggestScope } from "./session-memory.js"

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

	it("keeps env even for non-inert vars (no allowlist) and strips rtk", () => {
		const s = suggestScope("bash", { command: "LD_PRELOAD=/tmp/x.so rtk go test" })
		expect(s.content).toBe("LD_PRELOAD=/tmp/x.so go test:*")
	})

	it("is unchanged for commands with no env prefix", () => {
		const s = suggestScope("bash", { command: "go test --short" })
		expect(s.content).toBe("go test:*")
		expect(s.wildcardContent).toBe("go *")
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
