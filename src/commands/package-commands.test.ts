import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { findPackageCommand, listPackageCommands, type PackageCommand, runPackageCommand } from "./package-commands.js"

let agentDir: string

beforeEach(() => {
	agentDir = mkdtemp()
	vi.stubEnv("KIMCHI_CODING_AGENT_DIR", agentDir)
})

afterEach(() => {
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
})

function mkdtemp(): string {
	const dir = join(process.cwd(), ".tmp-package-commands-test", `${Date.now()}-${Math.random().toString(36).slice(2)}`)
	mkdirSync(dir, { recursive: true })
	return dir
}

function writePackage(name: string, manifest: Record<string, unknown>, modules: Record<string, string> = {}): void {
	const pkgRoot = join(agentDir, "npm", "node_modules", name)
	mkdirSync(pkgRoot, { recursive: true })
	writeFileSync(join(pkgRoot, "package.json"), JSON.stringify({ name, type: "module", ...manifest }, null, 2))
	for (const [relPath, content] of Object.entries(modules)) {
		const target = join(pkgRoot, relPath)
		mkdirSync(join(target, ".."), { recursive: true })
		writeFileSync(target, content)
	}
}

function writeSettings(packages: string[]): void {
	mkdirSync(agentDir, { recursive: true })
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages }, null, 2))
}

const HELLO_MODULE = `
export async function run(args) {
	console.log("hello " + args.join(" "))
	return 7
}
`

describe("package-commands discovery", () => {
	it("finds commands declared by an installed package", () => {
		writeSettings(["npm:@fake/commands"])
		writePackage(
			"@fake/commands",
			{ kimchi: { commands: { hello: "./dist/hello.js" } } },
			{ "dist/hello.js": HELLO_MODULE },
		)

		const command = findPackageCommand("hello")

		expect(command).toMatchObject({
			name: "hello",
			packageName: "@fake/commands",
			modulePath: join(agentDir, "npm", "node_modules", "@fake/commands", "dist/hello.js"),
		})
	})

	it("is unaffected by pi packages without a kimchi manifest (strictly additive)", () => {
		writeSettings(["npm:@fake/pi-only"])
		writePackage(
			"@fake/pi-only",
			{ pi: { extensions: ["./src/ext.ts"] } },
			{ "src/ext.ts": "export default function () {}" },
		)

		expect(findPackageCommand("hello")).toBeUndefined()
		expect(listPackageCommands()).toEqual([])
	})

	it("returns nothing without settings.json, with corrupt settings, or for non-npm sources", () => {
		expect(findPackageCommand("hello")).toBeUndefined()

		writeFileSync(join(agentDir, "settings.json"), "{not json")
		expect(findPackageCommand("hello")).toBeUndefined()

		writeSettings(["git:https://example.com/pkg", "path:../local"])
		expect(findPackageCommand("hello")).toBeUndefined()
	})

	it("lets the first package in settings order win a name collision", () => {
		writeSettings(["npm:@fake/first", "npm:@fake/second"])
		writePackage("@fake/first", { kimchi: { commands: { hello: "./dist/one.js" } } }, { "dist/one.js": HELLO_MODULE })
		writePackage("@fake/second", { kimchi: { commands: { hello: "./dist/two.js" } } }, { "dist/two.js": HELLO_MODULE })

		expect(findPackageCommand("hello")?.packageName).toBe("@fake/first")
	})

	it("never discovers kimchi built-in or pi CLI command names", () => {
		writeSettings(["npm:@fake/shadow"])
		writePackage("@fake/shadow", {
			kimchi: {
				commands: {
					version: "./dist/version.js", // kimchi built-in
					memory: "./dist/memory.js", // kimchi built-in
					install: "./dist/install.js", // pi installer
					update: "./dist/update.js", // pi updater
					config: "./dist/config.js", // pi config TUI
					list: "./dist/list.js", // pi list
					remove: "./dist/remove.js", // pi remove
					uninstall: "./dist/uninstall.js", // pi uninstall alias
					workspace: "./dist/workspace.js", // allowed
				},
			},
		})

		for (const reserved of ["version", "memory", "install", "update", "config", "list", "remove", "uninstall"]) {
			expect(findPackageCommand(reserved)).toBeUndefined()
		}
		expect(listPackageCommands().map((c) => c.name)).toEqual(["workspace"])
	})

	it("skips manifest entries escaping the package root", () => {
		writeSettings(["npm:@fake/escape"])
		writePackage("@fake/escape", { kimchi: { commands: { hello: "../../../outside.js" } } })

		expect(findPackageCommand("hello")).toBeUndefined()
	})

	it("never looks up flags or empty names", () => {
		writeSettings(["npm:@fake/commands"])
		writePackage(
			"@fake/commands",
			{ kimchi: { commands: { hello: "./dist/hello.js" } } },
			{ "dist/hello.js": HELLO_MODULE },
		)

		expect(findPackageCommand("--version")).toBeUndefined()
		expect(findPackageCommand("")).toBeUndefined()
	})

	it("lists all commands sorted by name", () => {
		writeSettings(["npm:@fake/commands"])
		writePackage(
			"@fake/commands",
			{ kimchi: { commands: { zebra: "./dist/zebra.js", alpha: "./dist/alpha.js" } } },
			{ "dist/zebra.js": HELLO_MODULE, "dist/alpha.js": HELLO_MODULE },
		)

		expect(listPackageCommands().map((c) => c.name)).toEqual(["alpha", "zebra"])
	})
})

describe("runPackageCommand", () => {
	it("runs the module and returns its exit code", async () => {
		writeSettings(["npm:@fake/commands"])
		writePackage(
			"@fake/commands",
			{ kimchi: { commands: { hello: "./dist/hello.js" } } },
			{ "dist/hello.js": HELLO_MODULE },
		)
		const command: PackageCommand = {
			name: "hello",
			packageName: "@fake/commands",
			modulePath: join(agentDir, "npm", "node_modules", "@fake/commands", "dist/hello.js"),
		}
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})

		const code = await runPackageCommand(command, ["world"])

		expect(code).toBe(7)
		expect(logSpy).toHaveBeenCalledWith("hello world")
	})

	it("maps a missing run() export to a clean error and exit 1", async () => {
		writeSettings(["npm:@fake/commands"])
		writePackage(
			"@fake/commands",
			{ kimchi: { commands: { hello: "./dist/no-run.js" } } },
			{
				"dist/no-run.js": "export const something = 1",
			},
		)
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const command: PackageCommand = {
			name: "hello",
			packageName: "@fake/commands",
			modulePath: join(agentDir, "npm", "node_modules", "@fake/commands", "dist/no-run.js"),
		}

		const code = await runPackageCommand(command, [])

		expect(code).toBe(1)
		expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("exports no run()"))
	})

	it("maps an import failure to a clean error and exit 1", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const command: PackageCommand = {
			name: "hello",
			packageName: "@fake/commands",
			modulePath: join(agentDir, "npm", "node_modules", "@fake/commands", "dist/missing.js"),
		}

		const code = await runPackageCommand(command, [])

		expect(code).toBe(1)
		expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('failed to load "hello"'))
	})

	it("treats an undefined return as exit 0", async () => {
		writeSettings(["npm:@fake/commands"])
		writePackage(
			"@fake/commands",
			{ kimchi: { commands: { hello: "./dist/void.js" } } },
			{
				"dist/void.js": "export async function run() {}",
			},
		)
		const command: PackageCommand = {
			name: "hello",
			packageName: "@fake/commands",
			modulePath: join(agentDir, "npm", "node_modules", "@fake/commands", "dist/void.js"),
		}

		expect(await runPackageCommand(command, [])).toBe(0)
	})
})
