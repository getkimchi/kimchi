import { describe, expect, it } from "vitest"
import { resolveWorkspaceSpec, WorkspaceSpecError } from "./spec.js"

describe("resolveWorkspaceSpec dependencies", () => {
	it.each([
		"jq",
		"node@22",
		"node@22.1.0",
		"prettier@latest",
		"npm:typescript-language-server@0.12.0",
		"ghcr:some-org/some-tool@1.2.3-beta.1",
		"a",
		"x@1",
		"@types/node",
		"@types/node@20",
	])("accepts %s", (dep) => {
		expect(resolveWorkspaceSpec({ dependencies: [dep] })).toEqual({ dependencies: [dep] })
	})

	it.each([
		"@latest",
		"@22",
		"npm:@latest",
		"node@",
		"no de",
		"node@^22",
		"NPM:jq",
	])("rejects %s as an invalid tool reference", (dep) => {
		expect(() => resolveWorkspaceSpec({ dependencies: [dep] })).toThrowError(/not a valid tool reference/)
	})

	it("rejects an entry exceeding 128 characters", () => {
		expect(() => resolveWorkspaceSpec({ dependencies: ["a".repeat(129)] })).toThrowError(/exceeds 128 characters/)
	})

	it("rejects an empty entry, naming its index", () => {
		expect(() => resolveWorkspaceSpec({ dependencies: ["jq", ""] })).toThrowError(/dependencies\[1\].*empty entry/)
	})

	it("rejects more than 50 dependencies", () => {
		const deps = Array.from({ length: 51 }, (_, i) => `tool-${String(i).padStart(2, "0")}`)
		expect(() => resolveWorkspaceSpec({ dependencies: deps })).toThrowError(/maximum of 50/)
	})

	it("rejects duplicates, naming the entry", () => {
		expect(() => resolveWorkspaceSpec({ dependencies: ["jq", "node@22", "jq"] })).toThrowError(/duplicate entry/)
	})

	// Parity pin, NOT a laxity bug: the client grammar must stay
	// byte-identical to the server's buf.validate patterns, which also
	// accept a bare "@". Diverging here would make the client reject tool
	// references the server accepts. Install-time failure (if any)
	// surfaces server-side — same as any accepted-but-uninstallable entry.
	it("accepts a bare @ (parity pin with the server grammar)", () => {
		expect(resolveWorkspaceSpec({ dependencies: ["@"] })).toEqual({ dependencies: ["@"] })
	})

	it("reports the grammar violation for every occurrence of a repeated invalid entry (no duplicate masking)", () => {
		try {
			resolveWorkspaceSpec({ dependencies: ["no de", "no de"] })
			expect.unreachable()
		} catch (err) {
			const message = (err as Error).message
			expect(message).toContain("dependencies[0]")
			expect(message).toContain("dependencies[1]")
			expect(message).not.toContain("duplicate")
		}
	})

	it("reports duplicates only for otherwise-valid entries", () => {
		try {
			resolveWorkspaceSpec({ dependencies: ["bad dep", "bad dep", "jq", "jq"] })
			expect.unreachable()
		} catch (err) {
			const message = (err as Error).message
			// [0], [1]: grammar violations (not masked as duplicates).
			expect(message).toContain('dependencies[0] value "bad dep"')
			expect(message).toContain('dependencies[1] value "bad dep"')
			// [2]: valid; [3]: the only duplicate.
			expect(message).toContain('dependencies[3] value "jq"')
			expect(message).toMatch(/duplicate/)
		}
	})
})

describe("resolveWorkspaceSpec egressPolicy", () => {
	it.each([
		{ denyByDefault: true },
		{ denyByDefault: false },
		{ allowed: ["github.com:443", "*.cast.ai"] },
		{ denied: ["10.0.0.0/8"] },
		{ denyByDefault: true, allowed: ["github.com"], denied: ["evil.example"] },
		// Grammar is not checked client-side: the operator is the authoritative
		// validator; kimchi mirrors API-edge bounds only.
		{ allowed: ["NOT-A-DOMAIN!!"] },
	])("accepts %j", (egressPolicy) => {
		expect(resolveWorkspaceSpec({ egressPolicy })).toEqual({ egressPolicy })
	})

	it("rejects a present-but-empty policy", () => {
		expect(() => resolveWorkspaceSpec({ egressPolicy: {} })).toThrowError(
			/set at least one of denyByDefault, allowed, denied/,
		)
	})

	it("treats empty allowed/denied lists as absent for the empty-policy check", () => {
		expect(() => resolveWorkspaceSpec({ egressPolicy: { allowed: [], denied: [] } })).toThrowError(
			/set at least one of denyByDefault, allowed, denied/,
		)
	})

	it("rejects more than 100 allowed entries", () => {
		const allowed = Array.from({ length: 101 }, (_, i) => `host-${String(i).padStart(3, "0")}.example`)
		expect(() => resolveWorkspaceSpec({ egressPolicy: { allowed } })).toThrowError(
			/egressPolicy\.allowed.*maximum of 100/,
		)
	})

	it("rejects more than 100 denied entries", () => {
		const denied = Array.from({ length: 101 }, (_, i) => `host-${String(i).padStart(3, "0")}.example`)
		expect(() => resolveWorkspaceSpec({ egressPolicy: { denied } })).toThrowError(
			/egressPolicy\.denied.*maximum of 100/,
		)
	})

	it("rejects an empty entry, naming list and index", () => {
		expect(() => resolveWorkspaceSpec({ egressPolicy: { allowed: [""] } })).toThrowError(
			/egressPolicy\.allowed\[0\].*empty entry/,
		)
	})

	it("rejects an entry exceeding 253 characters", () => {
		expect(() => resolveWorkspaceSpec({ egressPolicy: { denied: ["a".repeat(254)] } })).toThrowError(
			/egressPolicy\.denied\[0\].*entry exceeds 253 characters/,
		)
	})
})

describe("resolveWorkspaceSpec", () => {
	it("returns undefined for no config and for an empty config", () => {
		expect(resolveWorkspaceSpec(undefined)).toBeUndefined()
		expect(resolveWorkspaceSpec({})).toBeUndefined()
		expect(resolveWorkspaceSpec({ dependencies: [] })).toBeUndefined()
	})

	it("resolves a full template, preserving denyByDefault: false", () => {
		const spec = resolveWorkspaceSpec({
			resources: { cpu: "250m", memory: "1Gi" },
			dependencies: ["jq", "node@22"],
			egressPolicy: { denyByDefault: false, allowed: ["github.com:443"], denied: ["10.0.0.0/8"] },
		})
		expect(spec).toEqual({
			resources: { cpu: "250m", memory: "1Gi" },
			dependencies: ["jq", "node@22"],
			egressPolicy: { denyByDefault: false, allowed: ["github.com:443"], denied: ["10.0.0.0/8"] },
		})
	})

	it("reports every violation across sections in one WorkspaceSpecError", () => {
		let thrown: unknown
		try {
			resolveWorkspaceSpec({
				resources: { cpu: "abc", memory: "0" },
				dependencies: ["bad dep", "bad dep"],
				egressPolicy: { allowed: ["ok.example", ""] },
			})
		} catch (err) {
			thrown = err
		}
		expect(thrown).toBeInstanceOf(WorkspaceSpecError)
		const message = (thrown as Error).message
		expect(message).toContain('"abc"')
		expect(message).toContain("cpu")
		expect(message).toContain("memory")
		expect(message).toContain("dependencies[0]")
		expect(message).toContain("dependencies[1]")
		expect(message).toContain("egressPolicy.allowed[1]")
	})

	it("surfaces resource-only violations as WorkspaceSpecError too", () => {
		expect(() => resolveWorkspaceSpec({ resources: { cpu: "abc" } })).toThrowError(WorkspaceSpecError)
	})
})
