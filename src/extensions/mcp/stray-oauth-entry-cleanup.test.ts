import { describe, expect, it } from "vitest"
import type { SecurityToolRunner } from "./keyring-require-bridge.js"
import { cleanupStrayMcpOAuthEntries, parseDumpedAccounts } from "./stray-oauth-entry-cleanup.js"

const SERVICE = "dev.kimchi.mcp.oauth"
const ATLASSIAN = "sha256-651b2c67d53613630734935b1b7ac642f500543630d5833c277383eb12e5f182"
const CHUNK = `${ATLASSIAN}.chunk.0123456789abcdef.0`

function entry(service: string, account: string): string {
	return `class: "genp"
attributes:
    0x00000007 <blob>="${service}"
    "acct"<blob>="${account}"
    "cdat"<timedate>=0x00  "20261001000000Z\\000"
    "mdat"<timedate>=0x00  "20261001000000Z\\000"
    "svce"<blob>="${service}"
keychain: "/Users/test/Library/Keychains/login.keychain-db"
version: 512
`
}

describe("parseDumpedAccounts", () => {
	it("collects accounts for the target service only", () => {
		const output = [
			entry(SERVICE, ATLASSIAN),
			entry("com.apple.assistant", "62DC7CBC-8E02-4EAB-B353-E6C91326A565 - Assistant Identifier"),
			entry(SERVICE, "Bearer"),
		].join("\n")
		expect(parseDumpedAccounts(output, SERVICE)).toEqual([ATLASSIAN, "Bearer"])
	})

	it("handles accounts with spaces and mixed content", () => {
		const output = entry(SERVICE, "some account with spaces")
		expect(parseDumpedAccounts(output, SERVICE)).toEqual(["some account with spaces"])
	})

	it("returns nothing for empty output", () => {
		expect(parseDumpedAccounts("", SERVICE)).toEqual([])
	})
})

describe("cleanupStrayMcpOAuthEntries", () => {
	function runnerWith(dump: string, deleted: string[]): SecurityToolRunner {
		return (args) => {
			if (args[0] === "dump-keychain") return { stdout: dump, stderr: "", status: 0, error: undefined }
			if (args[0] === "delete-generic-password") {
				deleted.push(args[args.indexOf("-a") + 1])
				return { stdout: "", stderr: "", status: 0, error: undefined }
			}
			return { stdout: "", stderr: "", status: 1, error: undefined }
		}
	}

	it("removes only accounts that do not match kimchi's key shapes", () => {
		const dump = [entry(SERVICE, ATLASSIAN), entry(SERVICE, CHUNK), entry(SERVICE, "Bearer")].join("\n")
		const deleted: string[] = []
		const result = cleanupStrayMcpOAuthEntries(runnerWith(dump, deleted))
		expect(deleted).toEqual(["Bearer"])
		expect(result).toEqual({ scanned: 3, removed: ["Bearer"], failed: false })
	})

	it("leaves a healthy keychain untouched", () => {
		const dump = entry(SERVICE, ATLASSIAN)
		const deleted: string[] = []
		const result = cleanupStrayMcpOAuthEntries(runnerWith(dump, deleted))
		expect(deleted).toEqual([])
		expect(result.removed).toEqual([])
	})

	it("reports failure when dump-keychain fails", () => {
		const result = cleanupStrayMcpOAuthEntries(() => ({ stdout: "", stderr: "err", status: 1, error: undefined }))
		expect(result).toEqual({ scanned: 0, removed: [], failed: true })
	})
})
