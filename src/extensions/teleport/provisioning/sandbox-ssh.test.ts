import { existsSync } from "node:fs"
import { stat } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import {
	buildSshArgv,
	buildSshCommandString,
	buildSshOptions,
	buildSshProxyEnv,
	shellQuote,
	withSshSession,
} from "./sandbox-ssh.js"

const POLICY = {
	proxyCommand: "node /opt/kimchi/teleport-proxy.js %h %p",
	knownHostsFile: "/tmp/k/known_hosts",
}

describe("shellQuote", () => {
	it("wraps in single quotes and escapes embedded quotes", () => {
		expect(shellQuote("abc")).toBe("'abc'")
		expect(shellQuote("it's")).toBe(String.raw`'it'\''s'`)
		expect(shellQuote("a b'c\"d $x `y`")).toBe("'a b'\\''c\"d $x `y`'")
	})
})

describe("buildSshOptions", () => {
	it("is the one policy: proxy tunnel, accept-new host key, no prompts, keepalive", () => {
		expect(buildSshOptions(POLICY)).toEqual([
			"-o",
			"ProxyCommand=node /opt/kimchi/teleport-proxy.js %h %p",
			"-o",
			"StrictHostKeyChecking=accept-new",
			"-o",
			"UserKnownHostsFile=/tmp/k/known_hosts",
			"-o",
			"BatchMode=yes",
			"-o",
			"ServerAliveInterval=15",
		])
	})
})

describe("buildSshArgv", () => {
	it("appends destination and remote command after the policy", () => {
		expect(buildSshArgv({ ...POLICY, destination: "u@h", remoteCommand: "mkdir -p /w" })).toEqual([
			...buildSshOptions(POLICY),
			"u@h",
			"mkdir -p /w",
		])
	})

	it("omits the remote command when undefined (connection probe)", () => {
		const argv = buildSshArgv({ ...POLICY, destination: "u@h" })
		expect(argv).toEqual([...buildSshOptions(POLICY), "u@h"])
	})
})

describe("buildSshCommandString", () => {
	it("composes the string form with single-quoted values", () => {
		expect(buildSshCommandString(POLICY)).toBe(
			"ssh -o ProxyCommand='node /opt/kimchi/teleport-proxy.js %h %p' -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile='/tmp/k/known_hosts' -o BatchMode=yes -o ServerAliveInterval=15",
		)
	})

	it("single-quote-wraps values containing spaces or apostrophes", () => {
		const got = buildSshCommandString({
			proxyCommand: "node /path with spaces/teleport-proxy.js %h %p",
			knownHostsFile: "/tmp/it's mine/known_hosts",
		})
		expect(got).toContain("ProxyCommand='node /path with spaces/teleport-proxy.js %h %p'")
		expect(got).toContain(String.raw`UserKnownHostsFile='/tmp/it'\''s mine/known_hosts'`)
	})
})

describe("buildSshProxyEnv", () => {
	it("passes an API key without an organization", () => {
		const env = buildSshProxyEnv({ credentials: { token: "key" }, authToken: "tok" })
		expect(env).toStrictEqual({ KIMCHI_API_KEY: "key", AUTH_TOKEN: "tok", KIMCHI_ORGANIZATION_ID: undefined })
	})

	it("passes the SSO organization with an SSO token", () => {
		const env = buildSshProxyEnv({ credentials: { token: "sso", organizationId: "org-picked" }, authToken: "tok" })
		expect(env).toStrictEqual({ KIMCHI_API_KEY: "sso", AUTH_TOKEN: "tok", KIMCHI_ORGANIZATION_ID: "org-picked" })
	})

	it("treats an empty organization as none", () => {
		const env = buildSshProxyEnv({ credentials: { token: "sso", organizationId: "" }, authToken: "tok" })
		expect(env.KIMCHI_ORGANIZATION_ID).toBeUndefined()
	})

	it("clears an organization inherited from the parent env when spread over it", () => {
		// The key must exist (set to undefined) so the spread overrides the parent value.
		const env = {
			KIMCHI_ORGANIZATION_ID: "stale",
			...buildSshProxyEnv({ credentials: { token: "key" }, authToken: "t" }),
		}
		expect(Object.hasOwn(env, "KIMCHI_ORGANIZATION_ID")).toBe(true)
		expect(env.KIMCHI_ORGANIZATION_ID).toBeUndefined()
	})
})

describe("withSshSession", () => {
	it("provides a private dir with an empty known_hosts, removed afterwards", async () => {
		let seen: { dir: string; knownHostsFile: string; knownHostsSize: number } | undefined
		await withSshSession(async (session) => {
			expect(existsSync(session.dir)).toBe(true)
			expect(existsSync(session.knownHostsFile)).toBe(true)
			seen = { ...session, knownHostsSize: (await stat(session.knownHostsFile)).size }
		})
		expect(seen?.knownHostsSize).toBe(0)
		expect(existsSync(seen?.dir ?? "")).toBe(false)
	})

	it("removes the dir and rethrows when the callback throws", async () => {
		let dir = ""
		const boom = new Error("boom")
		await expect(
			withSshSession(async (session) => {
				dir = session.dir
				throw boom
			}),
		).rejects.toBe(boom)
		expect(existsSync(dir)).toBe(false)
	})

	it("returns the callback's value", async () => {
		await expect(withSshSession(async () => 42)).resolves.toBe(42)
	})
})
