import { type SpawnSyncReturns, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

const scriptPath = fileURLToPath(new URL("./commit-pi-patch.js", import.meta.url))
const defaultPackage = "@earendil-works/pi-coding-agent"
const patchBody = "diff --git a/src/file.ts b/src/file.ts\n@@ -1 +1 @@\n-before\n+after\n"
const originalPatch = `# Tracking: existing change
# Removal: when upstream includes it
# Changes:
# Existing behavior

${patchBody}`
const additions = {
	tracking: "# Tracking: added maintenance record\n#\n# Removal: when the upstream proposal lands",
	changes: "# proxy-modes: preserve the generated hunk and add a comment-only record\n",
}

type FixtureOptions = {
	packageName?: string
	version?: string
	devDependency?: boolean
	patchFileName?: string
}

type Fixture = ReturnType<typeof createFixture>

function createFixture({
	packageName = defaultPackage,
	version = "^1.3.0",
	devDependency = false,
	patchFileName = "@earendil-works__pi-coding-agent@1.3.0.patch",
}: FixtureOptions = {}) {
	const root = mkdtempSync(join(tmpdir(), "commit-pi-patch-test-"))
	const patchPath = join(root, "patches", patchFileName)
	mkdirSync(join(root, "edits"), { recursive: true })
	mkdirSync(join(root, "inputs"), { recursive: true })
	mkdirSync(join(root, "patches"), { recursive: true })
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({
			type: "module",
			[devDependency ? "devDependencies" : "dependencies"]: { [packageName]: version },
		}),
	)
	writeFileSync(patchPath, originalPatch)
	const pnpmStub = join(root, "pnpm-stub.mjs")
	writeFileSync(
		pnpmStub,
		`import { readFileSync, writeFileSync } from "node:fs";
const path = process.env.TEST_PATCH_PATH;
if (process.argv[2] === "patch-commit") {
  const generated = readFileSync(path, "utf8");
  writeFileSync(path, "# discarded generated header\\n" + generated.slice(generated.indexOf("diff --git")));
}
`,
	)
	return {
		root,
		editDirectory: join(root, "edits"),
		patchPath,
		run(args: string[]): SpawnSyncReturns<string> {
			return spawnSync(process.execPath, [scriptPath, ...args], {
				cwd: root,
				env: { npm_execpath: pnpmStub, TEST_PATCH_PATH: patchPath },
				encoding: "utf8",
				timeout: 10_000,
			})
		},
		writeAdditions(value: unknown): string {
			const relativePath = "inputs/header-additions.json"
			writeFileSync(join(root, relativePath), JSON.stringify(value))
			return relativePath
		},
	}
}

function withFixture(run: (fixture: Fixture) => void, options?: FixtureOptions): void {
	const fixture = createFixture(options)
	try {
		run(fixture)
	} finally {
		rmSync(fixture.root, { recursive: true, force: true })
	}
}

it("preserves the default package patch when no additions are supplied", () => {
	withFixture((fixture) => {
		const result = fixture.run([fixture.editDirectory])
		expect(result.error).toBeUndefined()
		expect(result.stderr).toBe("")
		expect(result.status).toBe(0)
		expect(readFileSync(fixture.patchPath, "utf8")).toBe(originalPatch)
	})
})

it("applies comment-only additions through the custom package and relative header paths", () => {
	withFixture(
		(fixture) => {
			const headerPath = fixture.writeAdditions(additions)
			const result = fixture.run([fixture.editDirectory, "pi-mcp-adapter", headerPath])
			expect(result.error).toBeUndefined()
			expect(result.stderr).toBe("")
			expect(result.status).toBe(0)
			const patched = readFileSync(fixture.patchPath, "utf8")
			expect(patched).toContain(`${additions.tracking.trimEnd()}\n# Changes:\n${additions.changes.trimEnd()}\n`)
			expect(patched).toContain("# Tracking: existing change")
			expect(patched).not.toContain("discarded generated header")
			expect(patched.endsWith(patchBody)).toBe(true)
		},
		{
			packageName: "pi-mcp-adapter",
			version: "^5.3.2",
			devDependency: true,
			patchFileName: "pi-mcp-adapter@5.3.2.patch",
		},
	)
})

it.each(["tracking", "changes"] as const)("rejects a non-comment continuation in %s", (field) => {
	withFixture((fixture) => {
		const headerPath = fixture.writeAdditions({ ...additions, [field]: "# Valid comment\nnot-a-comment" })
		const result = fixture.run([fixture.editDirectory, defaultPackage, headerPath])
		expect(result.status).toBe(1)
		expect(result.stderr).toContain(`Header addition ${field} must be a text block containing comment lines`)
		expect(readFileSync(fixture.patchPath, "utf8")).toBe(originalPatch)
	})
})
