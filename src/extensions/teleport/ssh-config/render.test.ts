import { describe, expect, it, vi } from "vitest"

vi.mock("../provisioning/proxy-command.js", () => ({
	buildProxyCommand: (target: string) => `kimchi --ssh-proxy ${target}`,
}))

import type { Workspace } from "../../../sandbox/cloud/types.js"
import { MANAGED_HEADER, renderSshConfig, slugify } from "./render.js"

function ws(over: Partial<Workspace> & { id: string; name: string }): Workspace {
	return {
		createdAt: new Date("2026-01-01T00:00:00Z"),
		lastActivityAt: new Date("2026-01-01T00:00:00Z"),
		status: "active",
		host: "host.example",
		...over,
	}
}

const FIXED_NOW = new Date("2026-06-03T12:00:00Z")

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

describe("renderSshConfig", () => {
	it("emits the managed header", () => {
		const out = renderSshConfig([], FIXED_NOW)
		expect(out).toContain(MANAGED_HEADER)
		expect(out).toContain("# Generated at 2026-06-03T12:00:00.000Z.")
	})

	it("notes an empty file when no workspaces are provisioned", () => {
		const out = renderSshConfig([ws({ id: "w-1", name: "alpha", host: undefined })], FIXED_NOW)
		expect(out).toContain("# No provisioned workspaces.")
		expect(out).not.toContain("Host kimchi-")
	})

	it("renders one block per provisioned workspace with the session-id ProxyCommand", () => {
		const out = renderSshConfig(
			[ws({ id: "uuid-aaaa-1111", name: "My Project", host: "ws-aaa.remote.kimchi.dev" })],
			FIXED_NOW,
		)
		expect(out).toContain("Host kimchi-my-project")
		expect(out).toContain("    HostName ws-aaa.remote.kimchi.dev")
		expect(out).toContain("    User sandbox")
		expect(out).toContain("    ProxyCommand kimchi --ssh-proxy uuid-aaaa-1111")
		expect(out).toContain("    StrictHostKeyChecking no")
		expect(out).toContain("    UserKnownHostsFile /dev/null")
	})

	it("skips workspaces without a host", () => {
		const out = renderSshConfig(
			[
				ws({ id: "w-1", name: "ready", host: "host.example" }),
				ws({ id: "w-2", name: "pending", host: undefined }),
				ws({ id: "w-3", name: "blank-host", host: "" }),
			],
			FIXED_NOW,
		)
		expect(out).toContain("Host kimchi-ready")
		expect(out).not.toContain("Host kimchi-pending")
		expect(out).not.toContain("Host kimchi-blank-host")
	})

	it("disambiguates colliding slugs with an id suffix", () => {
		const out = renderSshConfig(
			[
				ws({ id: "uuid-aaaa-1111", name: "My Project", host: "a.example" }),
				ws({ id: "uuid-bbbb-2222", name: "my project", host: "b.example" }),
			],
			FIXED_NOW,
		)
		// Both must be present and distinct.
		expect(out).toMatch(/Host kimchi-my-project-uuidaaaa\b/)
		expect(out).toMatch(/Host kimchi-my-project-uuidbbbb\b/)
	})

	it("falls back to the id prefix when the name is empty", () => {
		const out = renderSshConfig([ws({ id: "abcdef0123456789", name: "", host: "x.example" })], FIXED_NOW)
		expect(out).toContain("Host kimchi-abcdef01")
	})

	it("is deterministic — sorts by alias", () => {
		const a = renderSshConfig(
			[ws({ id: "w-1", name: "zeta", host: "z.example" }), ws({ id: "w-2", name: "alpha", host: "a.example" })],
			FIXED_NOW,
		)
		const b = renderSshConfig(
			[ws({ id: "w-2", name: "alpha", host: "a.example" }), ws({ id: "w-1", name: "zeta", host: "z.example" })],
			FIXED_NOW,
		)
		expect(a).toBe(b)
		expect(a.indexOf("kimchi-alpha")).toBeLessThan(a.indexOf("kimchi-zeta"))
	})
})
