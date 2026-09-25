import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Shared test fixtures for the package-command dispatcher suites — one
 * on-disk layout (agent dir + settings.json + npm/node_modules package)
 * reused by package-commands.test.ts, dispatch.test.ts, and help.test.ts
 * so the three suites cannot drift.
 */

/** Create an isolated agent dir with a deterministic fake-package layout. */
export function setupFakeAgentDir(): string {
	return mkdtempSync(join(tmpdir(), "kimchi-pkg-cmds-test-"))
}

export function teardownFakeAgentDir(dir: string): void {
	rmSync(dir, { recursive: true, force: true })
}

/**
 * Install a fake package declaring kimchi.commands into the agent dir.
 * Each value in `modules` maps a relative file path to its file content.
 */
export function installFakePackage(
	agentDir: string,
	packageName: string,
	commands: Record<string, string>,
	modules: Record<string, string> = {},
): void {
	writeSettings(agentDir, [`npm:${packageName}`])

	const pkgRoot = join(agentDir, "npm", "node_modules", packageName)
	mkdirSync(join(pkgRoot, "dist"), { recursive: true })
	writeFileSync(
		join(pkgRoot, "package.json"),
		JSON.stringify({ name: packageName, type: "module", kimchi: { commands } }),
	)
	for (const [relPath, content] of Object.entries(modules)) {
		const target = join(pkgRoot, relPath)
		mkdirSync(join(target, ".."), { recursive: true })
		writeFileSync(target, content)
	}
}

/** Write or merge a settings.json with the given packages array. */
export function writeSettings(agentDir: string, packages: string[]): void {
	mkdirSync(agentDir, { recursive: true })
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages }, null, 2))
}

/** A minimal command module that echoes its args and exits 7. */
export const ECHO_MODULE = `
export async function run(args) {
	console.log("package ran: " + args.join(" "))
	return 7
}
`
