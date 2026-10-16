import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { defaultMcpAuthPath, forgetMcpGrant, mcpNamespace } from "./mcp-forget-grant.js"

function tempAuthStore(entries: Record<string, unknown>): { dir: string; authPath: string } {
	const dir = mkdtempSync(join(tmpdir(), "forget-grant-"))
	const authPath = defaultMcpAuthPath(dir)
	writeFileSync(authPath, JSON.stringify(entries))
	return { dir, authPath }
}

describe("mcpNamespace", () => {
	it("mirrors pi's namespace format: mcp__ prefix, dashes become underscores", () => {
		expect(mcpNamespace("atlassian")).toBe("mcp__atlassian")
		expect(mcpNamespace("krep-dev")).toBe("mcp__krep_dev")
		expect(mcpNamespace("__kimchi-studio-connector__slack")).toBe("mcp____kimchi_studio_connector__slack")
	})
})

describe("forgetMcpGrant", () => {
	it("removes the server's native-store keys (mcp__<name>|<url>) for every URL", () => {
		const { authPath } = tempAuthStore({
			"mcp__atlassian|https://mcp.atlassian.com/v1/mcp/authv2": { accessToken: "x" },
			"mcp__atlassian|https://other.example.com/mcp": { accessToken: "y" },
			"mcp__posthog|https://mcp.posthog.com/mcp": { accessToken: "z" },
		})
		const result = forgetMcpGrant("atlassian", authPath)
		expect(result.removed).toBe(2)
		expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual({
			"mcp__posthog|https://mcp.posthog.com/mcp": { accessToken: "z" },
		})
	})

	it("matches keys across dash/underscore spellings of the server name", () => {
		const { authPath } = tempAuthStore({
			"mcp__krep_dev|https://mcp.krep-dev.castai.co/mcp": { accessToken: "x" },
		})
		expect(forgetMcpGrant("krep-dev", authPath).removed).toBe(1)
		expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual({})
	})

	it("leaves other servers' keys and non-namespaced (legacy URL-only) keys alone", () => {
		const { authPath } = tempAuthStore({
			"mcp__atlassian|https://mcp.atlassian.com/v1/mcp/authv2": { accessToken: "x" },
			"mcp__posthog|https://mcp.posthog.com/mcp": { accessToken: "z" },
			"https://mcp.atlassian.com/v1/mcp/authv2": { accessToken: "legacy" },
		})
		const result = forgetMcpGrant("atlassian", authPath)
		expect(result.removed).toBe(1)
		expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual({
			"mcp__posthog|https://mcp.posthog.com/mcp": { accessToken: "z" },
			"https://mcp.atlassian.com/v1/mcp/authv2": { accessToken: "legacy" },
		})
	})

	it("reports removed=0 and writes nothing when no key matches", () => {
		const { authPath } = tempAuthStore({
			"mcp__posthog|https://mcp.posthog.com/mcp": { accessToken: "z" },
		})
		const before = readFileSync(authPath, "utf8")
		expect(forgetMcpGrant("atlassian", authPath).removed).toBe(0)
		expect(readFileSync(authPath, "utf8")).toBe(before)
	})

	it("reports removed=0 when the store file does not exist", () => {
		const dir = mkdtempSync(join(tmpdir(), "forget-grant-empty-"))
		expect(forgetMcpGrant("atlassian", defaultMcpAuthPath(dir)).removed).toBe(0)
	})
})
