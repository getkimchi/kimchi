import { describe, expect, it } from "vitest"
import type { Workspace } from "../../sandbox/cloud/types.js"
import { assignWorkspaceSlugs, slugify } from "./workspace-slugs.js"

function ws(id: string, name: string): Workspace {
	return {
		id,
		name,
		createdAt: new Date("2026-01-01T00:00:00Z"),
		lastActivityAt: new Date("2026-01-01T00:00:00Z"),
		status: "active",
		host: "host.example",
	}
}

describe("slugify", () => {
	it("lowercases and dash-separates", () => {
		expect(slugify("My Project")).toBe("my-project")
	})
	it("collapses runs of non-alphanumerics", () => {
		expect(slugify("a__b--c")).toBe("a-b-c")
	})
	it("trims leading and trailing dashes", () => {
		expect(slugify("___foo___")).toBe("foo")
	})
	it("returns empty string for blank input", () => {
		expect(slugify("   ")).toBe("")
		expect(slugify("")).toBe("")
	})
	it("strips combining marks (NFKD)", () => {
		expect(slugify("Café")).toBe("cafe")
	})
})

describe("assignWorkspaceSlugs", () => {
	it("returns the slugified name when names are unique", () => {
		const map = assignWorkspaceSlugs([ws("w-1", "My Project"), ws("w-2", "alpha")])
		expect(map.get("w-1")).toBe("my-project")
		expect(map.get("w-2")).toBe("alpha")
	})

	it("disambiguates colliding names with an id-prefix suffix", () => {
		const map = assignWorkspaceSlugs([
			ws("23d3a753-d949-47fb-9ecf-b237256f9f54", "gemini-check"),
			ws("ac0ca279-247b-4107-b553-7662e1725f5e", "gemini-check"),
		])
		expect(map.get("23d3a753-d949-47fb-9ecf-b237256f9f54")).toBe("gemini-check-23d3a753")
		expect(map.get("ac0ca279-247b-4107-b553-7662e1725f5e")).toBe("gemini-check-ac0ca279")
	})

	it("falls back to the id prefix when the name is empty", () => {
		const map = assignWorkspaceSlugs([ws("abcdef0123456789", "")])
		expect(map.get("abcdef0123456789")).toBe("abcdef01")
	})

	it("does not add a suffix when only one workspace has a colliding-looking slug", () => {
		const map = assignWorkspaceSlugs([ws("w-1", "alpha"), ws("w-2", "beta")])
		expect(map.get("w-1")).toBe("alpha")
		expect(map.get("w-2")).toBe("beta")
	})
})
