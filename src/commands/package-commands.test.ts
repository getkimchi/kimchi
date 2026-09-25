import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { findPackageCommand, listPackageCommands, type PackageCommand, runPackageCommand } from "./package-commands.js"
import {
	ECHO_MODULE,
	installFakePackage,
	setupFakeAgentDir,
	teardownFakeAgentDir,
	writeSettings,
} from "./test-helpers.js"

let agentDir: string

beforeEach(() => {
	agentDir = setupFakeAgentDir()
	vi.stubEnv("KIMCHI_CODING_AGENT_DIR", agentDir)
})

afterEach(() => {
	teardownFakeAgentDir(agentDir)
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
})

describe("package-commands discovery", () => {
	it("finds commands declared by an installed package", () => {
		installFakePackage(agentDir, "@fake/commands", { hello: "./dist/hello.js" }, { "dist/hello.js": ECHO_MODULE })

		const command = findPackageCommand("hello")

		expect(command).toMatchObject({
			name: "hello",
			packageName: "@fake/commands",
			modulePath: join(agentDir, "npm", "node_modules", "@fake/commands", "dist/hello.js"),
		})
	})

	it("is unaffected by pi packages without a kimchi manifest (strictly additive)", () => {
		writeSettings(agentDir, ["npm:@fake/pi-only"])
		const pkgRoot = join(agentDir, "npm", "node_modules", "@fake/pi-only")
		const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs")
		mkdirSync(join(pkgRoot, "src"), { recursive: true })
		writeFileSync(
			join(pkgRoot, "package.json"),
			JSON.stringify({ name: "@fake/pi-only", type: "module", pi: { extensions: ["./src/ext.ts"] } }),
		)
		writeFileSync(join(pkgRoot, "src", "ext.ts"), "export default function () {}")

		expect(findPackageCommand("hello")).toBeUndefined()
		expect(listPackageCommands()).toEqual([])
	})

	it("returns nothing without settings.json, with corrupt settings, or for non-npm sources", () => {
		expect(findPackageCommand("hello")).toBeUndefined()

		const { writeFileSync } = require("node:fs") as typeof import("node:fs")
		writeFileSync(join(agentDir, "settings.json"), "{not json")
		expect(findPackageCommand("hello")).toBeUndefined()

		writeSettings(agentDir, ["git:https://example.com/pkg", "path:../local"])
		expect(findPackageCommand("hello")).toBeUndefined()
	})

	it("lets the first package in settings order win a name collision", () => {
		writeSettings(agentDir, ["npm:@fake/first", "npm:@fake/second"])
		const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs")
		for (const name of ["@fake/first", "@fake/second"]) {
			const pkgRoot = join(agentDir, "npm", "node_modules", name)
			mkdirSync(join(pkgRoot, "dist"), { recursive: true })
			writeFileSync(
				join(pkgRoot, "package.json"),
				JSON.stringify({ name, type: "module", kimchi: { commands: { hello: "./dist/one.js" } } }),
			)
		}

		expect(findPackageCommand("hello")?.packageName).toBe("@fake/first")
	})

	it("skips an npm: entry whose package name escapes the node_modules root", () => {
		writeSettings(agentDir, ["npm:../../outside"])

		expect(findPackageCommand("hello")).toBeUndefined()
	})

	it("skips manifest entries escaping the package root", () => {
		installFakePackage(agentDir, "@fake/escape", { hello: "../../../outside.js" })

		expect(findPackageCommand("hello")).toBeUndefined()
	})

	it("never looks up flags or empty names", () => {
		installFakePackage(agentDir, "@fake/commands", { hello: "./dist/hello.js" }, { "dist/hello.js": ECHO_MODULE })

		expect(findPackageCommand("--version")).toBeUndefined()
		expect(findPackageCommand("")).toBeUndefined()
	})

	it("lists all commands sorted by name", () => {
		installFakePackage(
			agentDir,
			"@fake/commands",
			{ zebra: "./dist/zebra.js", alpha: "./dist/alpha.js" },
			{ "dist/zebra.js": ECHO_MODULE, "dist/alpha.js": ECHO_MODULE },
		)

		expect(listPackageCommands().map((c) => c.name)).toEqual(["alpha", "zebra"])
	})

	it("never discovers kimchi built-in or pi CLI command names", () => {
		installFakePackage(agentDir, "@fake/shadow", {
			version: "./dist/shadow.js",
			memory: "./dist/shadow.js",
			install: "./dist/shadow.js",
			update: "./dist/shadow.js",
			config: "./dist/shadow.js",
			list: "./dist/shadow.js",
			remove: "./dist/shadow.js",
			uninstall: "./dist/shadow.js",
			workspace: "./dist/workspace.js",
		})

		for (const reserved of ["version", "memory", "install", "update", "config", "list", "remove", "uninstall"]) {
			expect(findPackageCommand(reserved)).toBeUndefined()
		}
		expect(listPackageCommands().map((c) => c.name)).toEqual(["workspace"])
	})
})

describe("runPackageCommand", () => {
	function commandFor(packageName: string, moduleRel: string): PackageCommand {
		return {
			name: "hello",
			packageName,
			modulePath: join(agentDir, "npm", "node_modules", packageName, moduleRel),
		}
	}

	it("runs the module and returns its exit code", async () => {
		installFakePackage(agentDir, "@fake/commands", { hello: "./dist/hello.js" }, { "dist/hello.js": ECHO_MODULE })
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})

		const code = await runPackageCommand(commandFor("@fake/commands", "dist/hello.js"), ["world"])

		expect(code).toBe(7)
		expect(logSpy).toHaveBeenCalledWith("package ran: world")
	})

	it("maps a missing run() export to a clean error and exit 1", async () => {
		installFakePackage(
			agentDir,
			"@fake/commands",
			{ hello: "./dist/no-run.js" },
			{
				"dist/no-run.js": "export const something = 1",
			},
		)
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		const code = await runPackageCommand(commandFor("@fake/commands", "dist/no-run.js"), [])

		expect(code).toBe(1)
		expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("exports no run()"))
	})

	it("maps an import failure to a clean error and exit 1", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		const code = await runPackageCommand(commandFor("@fake/commands", "dist/missing.js"), [])

		expect(code).toBe(1)
		expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('failed to load "hello"'))
	})

	it("maps a throwing run() to a clean error and exit 1", async () => {
		installFakePackage(
			agentDir,
			"@fake/throwing",
			{ hello: "./dist/throw.js" },
			{
				"dist/throw.js": "export async function run() { throw new Error('boom') }",
			},
		)
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		const code = await runPackageCommand(commandFor("@fake/throwing", "dist/throw.js"), [])

		expect(code).toBe(1)
		expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("failed: boom"))
	})

	it("treats an undefined return as exit 0", async () => {
		installFakePackage(
			agentDir,
			"@fake/commands",
			{ hello: "./dist/void.js" },
			{
				"dist/void.js": "export async function run() {}",
			},
		)

		expect(await runPackageCommand(commandFor("@fake/commands", "dist/void.js"), [])).toBe(0)
	})

	it("treats a non-integer return as exit 0", async () => {
		installFakePackage(
			agentDir,
			"@fake/commands",
			{ hello: "./dist/garbage.js" },
			{
				"dist/garbage.js": "export async function run() { return 'not a number' }",
			},
		)

		expect(await runPackageCommand(commandFor("@fake/commands", "dist/garbage.js"), [])).toBe(0)
	})
})
