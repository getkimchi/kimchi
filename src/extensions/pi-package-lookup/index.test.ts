import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	PI_PACKAGE_LOOKUP_RESOURCE_ID,
	type ResolvedPaths,
	getOriginalPiAgentDir,
	getOriginalPiConfiguredPackages,
	isOriginalPiPackageLookupEnabled,
	mergeResolvedPaths,
	resolveOriginalPiPackageResources,
} from "./index.js"

describe("original pi package lookup", () => {
	let dir: string
	let oldKimchiAgentDir: string | undefined
	let oldPiAgentDir: string | undefined
	let oldOriginalPiAgentDir: string | undefined
	let oldHome: string | undefined

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "kimchi-pi-package-lookup-"))
		oldKimchiAgentDir = process.env.KIMCHI_CODING_AGENT_DIR
		oldPiAgentDir = process.env.PI_CODING_AGENT_DIR
		oldOriginalPiAgentDir = process.env.KIMCHI_ORIGINAL_PI_CODING_AGENT_DIR
		oldHome = process.env.HOME
	})

	afterEach(() => {
		restoreEnv("KIMCHI_CODING_AGENT_DIR", oldKimchiAgentDir)
		restoreEnv("PI_CODING_AGENT_DIR", oldPiAgentDir)
		restoreEnv("KIMCHI_ORIGINAL_PI_CODING_AGENT_DIR", oldOriginalPiAgentDir)
		restoreEnv("HOME", oldHome)
		rmSync(dir, { recursive: true, force: true })
	})

	it("defaults pi package lookup off and honors the Kimchi resource override", () => {
		const agentDir = join(dir, "kimchi-agent")
		process.env.KIMCHI_CODING_AGENT_DIR = agentDir
		mkdirSync(agentDir, { recursive: true })

		expect(isOriginalPiPackageLookupEnabled()).toBe(false)

		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ resources: { [PI_PACKAGE_LOOKUP_RESOURCE_ID]: true } }),
		)

		expect(isOriginalPiPackageLookupEnabled()).toBe(true)
	})

	it("uses PI_CODING_AGENT_DIR when resolving the original pi agent dir", () => {
		process.env.PI_CODING_AGENT_DIR = "~/custom-pi-agent"

		expect(getOriginalPiAgentDir()).toContain("custom-pi-agent")
	})

	it("falls back to the default pi agent dir when PI_CODING_AGENT_DIR is Kimchi's shim", () => {
		const homeDir = join(dir, "home")
		const kimchiAgentDir = join(dir, "kimchi-agent")
		process.env.HOME = homeDir
		process.env.KIMCHI_CODING_AGENT_DIR = kimchiAgentDir
		process.env.PI_CODING_AGENT_DIR = kimchiAgentDir

		expect(getOriginalPiAgentDir()).toBe(join(homeDir, ".pi", "agent"))
	})

	it("discovers original pi packages when PI_CODING_AGENT_DIR is Kimchi's shim", () => {
		const homeDir = join(dir, "home")
		const kimchiAgentDir = join(dir, "kimchi-agent")
		const piAgentDir = join(homeDir, ".pi", "agent")
		process.env.HOME = homeDir
		process.env.KIMCHI_CODING_AGENT_DIR = kimchiAgentDir
		process.env.PI_CODING_AGENT_DIR = kimchiAgentDir
		mkdirSync(kimchiAgentDir, { recursive: true })
		mkdirSync(piAgentDir, { recursive: true })
		writeFileSync(
			join(kimchiAgentDir, "settings.json"),
			JSON.stringify({ resources: { [PI_PACKAGE_LOOKUP_RESOURCE_ID]: true } }),
		)
		writeFileSync(join(piAgentDir, "settings.json"), JSON.stringify({ packages: ["npm:@juicesharp/rpiv-todo"] }))

		expect(getOriginalPiConfiguredPackages(join(dir, "project"))).toEqual([
			{
				source: "npm:@juicesharp/rpiv-todo",
				scope: "user",
				filtered: false,
				origin: "pi",
				installedPath: undefined,
			},
		])
	})

	it("merges original pi resources behind native Kimchi resources without duplicating paths", () => {
		const primary = resolvedPaths({
			extensions: [
				{
					path: "/kimchi/pkg/extensions/index.js",
					enabled: true,
					metadata: { source: "npm:pkg", scope: "user", origin: "package" },
				},
			],
		})
		const secondary = resolvedPaths({
			extensions: [
				{
					path: "/kimchi/pkg/extensions/index.js",
					enabled: true,
					metadata: { source: "npm:pkg", scope: "user", origin: "package" },
				},
				{
					path: "/pi/pkg/extensions/index.js",
					enabled: true,
					metadata: { source: "npm:pi-only", scope: "user", origin: "package" },
				},
			],
		})

		expect(mergeResolvedPaths(primary, secondary).extensions.map((resource) => resource.path)).toEqual([
			"/kimchi/pkg/extensions/index.js",
			"/pi/pkg/extensions/index.js",
		])
	})

	it("resolves original pi project packages from .pi settings", async () => {
		const cwd = join(dir, "project")
		const kimchiAgentDir = join(dir, "kimchi-agent")
		const piAgentDir = join(dir, "pi-agent")
		const packageDir = join(cwd, ".pi", "local-package")
		const extensionPath = join(packageDir, "extensions", "index.js")
		process.env.KIMCHI_CODING_AGENT_DIR = kimchiAgentDir
		process.env.PI_CODING_AGENT_DIR = piAgentDir
		mkdirSync(join(packageDir, "extensions"), { recursive: true })
		mkdirSync(piAgentDir, { recursive: true })
		mkdirSync(kimchiAgentDir, { recursive: true })
		writeFileSync(
			join(kimchiAgentDir, "settings.json"),
			JSON.stringify({ resources: { [PI_PACKAGE_LOOKUP_RESOURCE_ID]: true } }),
		)
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: ["./local-package"] }))
		writeFileSync(join(packageDir, "package.json"), JSON.stringify({ pi: { extensions: ["./extensions/index.js"] } }))
		writeFileSync(extensionPath, "export default function noop() {}\n")

		const resolved = await resolveOriginalPiPackageResources(cwd, new Set())

		expect(resolved.extensions).toEqual([
			{
				path: extensionPath,
				enabled: true,
				metadata: {
					source: "./local-package",
					scope: "project",
					origin: "package",
					baseDir: packageDir,
				},
			},
		])
	})
})

function resolvedPaths(paths: Partial<ResolvedPaths>): ResolvedPaths {
	return {
		extensions: paths.extensions ?? [],
		skills: paths.skills ?? [],
		prompts: paths.prompts ?? [],
		themes: paths.themes ?? [],
	}
}

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name]
	} else {
		process.env[name] = value
	}
}
