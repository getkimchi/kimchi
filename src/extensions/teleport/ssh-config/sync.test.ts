import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../provisioning/proxy-command.js", () => ({
	buildProxyCommand: (target: string) => `kimchi --ssh-proxy ${target}`,
}))

import type { Workspace } from "../../../sandbox/cloud/types.js"
import type { TeleportContext } from "../types.js"
import { applyIncludeBlock, ensureIncludeDirective, syncSshConfig } from "./sync.js"

let tmp: string
const notifies: Array<{ msg: string; level: string }> = []

function makeCtx(): TeleportContext {
	return {
		apiKey: "k",
		cwd: "/work",
		signal: undefined,
		ui: {
			notify: (msg: string, level: string) => {
				notifies.push({ msg, level })
			},
			setStatus: () => {},
		} as unknown as TeleportContext["ui"],
	}
}

function ws(over: Partial<Workspace> & { id: string; name: string }): Workspace {
	return {
		createdAt: new Date("2026-01-01T00:00:00Z"),
		lastActivityAt: new Date("2026-01-01T00:00:00Z"),
		status: "active",
		host: "host.example",
		...over,
	}
}

beforeEach(async () => {
	tmp = await mkdtemp(join(tmpdir(), "kimchi-ssh-config-test-"))
	notifies.length = 0
})

afterEach(async () => {
	await rm(tmp, { recursive: true, force: true })
})

describe("syncSshConfig", () => {
	it("writes the managed file under XDG_CONFIG_HOME with mode 0600", async () => {
		const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, "xdg") }
		await syncSshConfig([ws({ id: "w-1", name: "alpha", host: "a.example" })], makeCtx(), { env })

		const managed = join(tmp, "xdg", "kimchi", "ssh_config")
		const body = await readFile(managed, "utf8")
		expect(body).toContain("Host kimchi-alpha")
		const st = await stat(managed)
		expect(st.mode & 0o777).toBe(0o600)
	})

	it("falls back to ~/.config when XDG_CONFIG_HOME is unset", async () => {
		const env = { HOME: tmp }
		await syncSshConfig([ws({ id: "w-1", name: "alpha", host: "a.example" })], makeCtx(), { env })
		const body = await readFile(join(tmp, ".config", "kimchi", "ssh_config"), "utf8")
		expect(body).toContain("Host kimchi-alpha")
	})

	it("warns instead of throwing on filesystem failure", async () => {
		// Point at a non-existent parent that we can't create (a file in place of a dir).
		const conflict = join(tmp, "conflict")
		await writeFile(conflict, "x")
		const env = { HOME: tmp, XDG_CONFIG_HOME: conflict }
		await expect(syncSshConfig([], makeCtx(), { env })).resolves.toBeUndefined()
		expect(notifies.some((n) => n.level === "warning")).toBe(true)
	})
})

describe("ensureIncludeDirective", () => {
	it("creates ~/.ssh/config with the fenced block when the file does not exist", async () => {
		const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, "xdg") }
		await ensureIncludeDirective(makeCtx(), { env })

		const cfg = await readFile(join(tmp, ".ssh", "config"), "utf8")
		expect(cfg).toContain("# >>> kimchi managed include >>>")
		expect(cfg).toContain(`Include ${join(tmp, "xdg", "kimchi", "ssh_config")}`)
		expect(cfg).toContain("# <<< kimchi managed include <<<")
	})

	it("is idempotent — no-op when the block already matches", async () => {
		const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, "xdg") }
		await ensureIncludeDirective(makeCtx(), { env })
		const cfgPath = join(tmp, ".ssh", "config")
		const first = await readFile(cfgPath, "utf8")
		await ensureIncludeDirective(makeCtx(), { env })
		const second = await readFile(cfgPath, "utf8")
		expect(second).toBe(first)
	})

	it("prepends the block to an existing file without touching user content", async () => {
		const cfgPath = join(tmp, ".ssh", "config")
		const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, "xdg") }
		await writeFile(cfgPath, "Host other.example\n    User bob\n", { mode: 0o600 }).catch(async (err) => {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
			const { mkdir } = await import("node:fs/promises")
			await mkdir(join(tmp, ".ssh"), { recursive: true })
			await writeFile(cfgPath, "Host other.example\n    User bob\n", { mode: 0o600 })
		})

		await ensureIncludeDirective(makeCtx(), { env })
		const cfg = await readFile(cfgPath, "utf8")
		expect(cfg.indexOf("# >>> kimchi managed include >>>")).toBeLessThan(cfg.indexOf("Host other.example"))
		expect(cfg).toContain("Host other.example")
		expect(cfg).toContain("    User bob")
	})

	it("replaces a stale block in place when present", async () => {
		const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, "xdg") }
		const stale = [
			"# unrelated header",
			"",
			"# >>> kimchi managed include >>>",
			"Include /old/stale/path",
			"# <<< kimchi managed include <<<",
			"",
			"Host other",
			"    User alice",
			"",
		].join("\n")
		const { mkdir } = await import("node:fs/promises")
		await mkdir(join(tmp, ".ssh"), { recursive: true })
		await writeFile(join(tmp, ".ssh", "config"), stale, { mode: 0o600 })

		await ensureIncludeDirective(makeCtx(), { env })

		const cfg = await readFile(join(tmp, ".ssh", "config"), "utf8")
		expect(cfg).not.toContain("/old/stale/path")
		expect(cfg).toContain(`Include ${join(tmp, "xdg", "kimchi", "ssh_config")}`)
		expect(cfg).toContain("# unrelated header")
		expect(cfg).toContain("Host other")
		expect(cfg).toContain("    User alice")
	})
})

describe("applyIncludeBlock", () => {
	const block = "# >>> kimchi managed include >>>\nInclude /m\n# <<< kimchi managed include <<<"

	it("creates a block-only file from empty input", () => {
		expect(applyIncludeBlock("", block)).toBe(`${block}\n`)
	})

	it("returns the input unchanged when the block already matches", () => {
		const existing = `${block}\n\nHost x\n`
		expect(applyIncludeBlock(existing, block)).toBe(existing)
	})

	it("replaces a mismatched block in place", () => {
		const stale = "# >>> kimchi managed include >>>\nInclude /old\n# <<< kimchi managed include <<<\n\nHost x\n"
		const result = applyIncludeBlock(stale, block)
		expect(result).toContain("Include /m")
		expect(result).not.toContain("Include /old")
		expect(result).toContain("Host x")
	})

	it("prepends the block when no block exists", () => {
		const result = applyIncludeBlock("Host x\n    User u\n", block)
		expect(result.startsWith(block)).toBe(true)
		expect(result).toContain("Host x")
	})
})
