import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import {
	buildValidationCatalog,
	filterExpectedOutputs,
	gitStatusPorcelain,
	hashPatchFiles,
	patchFilesChanged,
	restorePatchFiles,
	snapshotPatchFiles,
	validationCatalogForPrompt,
	validationCommand,
} from "./validation.js"

const execFileAsync = promisify(execFile)

const roots: string[] = []

async function fixture(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "council-validation-"))
	roots.push(root)
	return root
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("Council validation catalog", () => {
	it("derives typed direct checks from simple package scripts", async () => {
		const root = await fixture()
		await writeFile(
			join(root, "package.json"),
			JSON.stringify({
				scripts: {
					test: "vitest run --dir src",
					typecheck: "tsc --noEmit",
					lint: "biome check src",
					build: "tsc && node build.js",
				},
			}),
		)
		await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")

		const catalog = buildValidationCatalog(root, [])

		expect(catalog.map(({ id }) => id)).toEqual(["package.test", "package.typecheck", "package.lint"])
		expect(catalog[0]).toMatchObject({
			kind: "test",
			cwd: ".",
			executable: "pnpm",
			args: ["exec", "vitest", "run", "--dir", "src"],
			mutationPolicy: "read-only",
		})
		expect(validationCommand(catalog[0])).toBe("pnpm exec vitest run --dir src")
	})

	it("keeps exact arguments private from model-facing catalog metadata", async () => {
		const root = await fixture()
		const secret = "castai_v1_abcdefgh123456"
		const catalog = buildValidationCatalog(root, [
			{
				id: "harness.test",
				kind: "test",
				cwd: ".",
				executable: "node",
				args: ["verify.mjs", "--token", secret],
				timeoutMs: 30_000,
				mutationPolicy: "read-only",
				expectedOutputs: [],
			},
		])

		expect(validationCommand(catalog[0])).toContain(secret)
		expect(validationCatalogForPrompt(catalog)).toEqual([
			expect.objectContaining({
				id: "harness.test",
				description: "node test check",
			}),
		])
		expect(JSON.stringify(validationCatalogForPrompt(catalog))).not.toContain(secret)
	})

	it("rejects chained, mutating, downloading, and escaping explicit checks", async () => {
		const root = await fixture()
		await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run && rm -rf ." } }))

		const catalog = buildValidationCatalog(root, [
			{
				id: "unsafe.write",
				kind: "lint",
				cwd: ".",
				executable: "biome",
				args: ["check", "--write", "."],
				timeoutMs: 30_000,
				mutationPolicy: "read-only",
				expectedOutputs: [],
			},
			{
				id: "unsafe.download",
				kind: "test",
				cwd: ".",
				executable: "npx",
				args: ["vitest", "run"],
				timeoutMs: 30_000,
				mutationPolicy: "read-only",
				expectedOutputs: [],
			},
			{
				id: "unsafe.cwd",
				kind: "test",
				cwd: "..",
				executable: "pytest",
				args: ["-q"],
				timeoutMs: 30_000,
				mutationPolicy: "read-only",
				expectedOutputs: [],
			},
		])

		expect(catalog).toEqual([])
	})

	it("accepts explicit expected outputs only when paths stay inside the workspace", async () => {
		const root = await fixture()
		const catalog = buildValidationCatalog(root, [
			{
				id: "build.docs",
				kind: "build",
				cwd: ".",
				executable: "node",
				args: ["scripts/build-docs.js"],
				timeoutMs: 500_000,
				mutationPolicy: "expected-output-only",
				expectedOutputs: ["dist/docs"],
			},
		])

		expect(catalog).toEqual([
			expect.objectContaining({
				id: "build.docs",
				timeoutMs: 120_000,
				expectedOutputs: ["dist/docs"],
			}),
		])
	})
})

describe("Council patch-file snapshots", () => {
	it("restores only the touched files that were changed or deleted", async () => {
		const root = await fixture()
		await mkdir(join(root, "nested"))
		await writeFile(join(root, "kept.txt"), "before\n")
		await writeFile(join(root, "nested", "deleted.txt"), "before\n")
		const touched = ["kept.txt", "nested/deleted.txt"]
		const before = await snapshotPatchFiles(root, touched)

		await writeFile(join(root, "kept.txt"), "changed\n")
		await rm(join(root, "nested", "deleted.txt"))

		expect(patchFilesChanged(before, await snapshotPatchFiles(root, touched))).toBe(true)
		await restorePatchFiles(root, before)

		expect(await readFile(join(root, "kept.txt"), "utf8")).toBe("before\n")
		expect(await readFile(join(root, "nested", "deleted.txt"), "utf8")).toBe("before\n")
		expect(patchFilesChanged(before, await snapshotPatchFiles(root, touched))).toBe(false)
		expect(hashPatchFiles(await snapshotPatchFiles(root, touched))).toBe(hashPatchFiles(before))
	})

	it("ignores untouched files entirely when comparing snapshots", async () => {
		const root = await fixture()
		await writeFile(join(root, "touched.txt"), "before\n")
		await writeFile(join(root, "other.txt"), "unrelated\n")
		const before = await snapshotPatchFiles(root, ["touched.txt"])

		await writeFile(join(root, "other.txt"), "changed elsewhere\n")

		expect(patchFilesChanged(before, await snapshotPatchFiles(root, ["touched.txt"]))).toBe(false)
	})

	it("detects a newly created file via git status without touching untracked snapshot state", async () => {
		const root = await fixture()
		await execFileAsync("git", ["init", "-q"], { cwd: root })
		await writeFile(join(root, "tracked.txt"), "before\n")
		await execFileAsync("git", ["add", "-A"], { cwd: root })
		await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: root })

		const before = await gitStatusPorcelain(root)
		expect(before).toBe("")

		await writeFile(join(root, "leaked.txt"), "leak\n")
		const after = await gitStatusPorcelain(root)

		expect(after).not.toBe(before)
		expect(after).toContain("leaked.txt")
	})

	it("returns an empty status outside a git repository instead of throwing", async () => {
		const root = await fixture()
		await expect(gitStatusPorcelain(root)).resolves.toBe("")
	})

	it("filterExpectedOutputs drops only lines fully inside a typed expected-output path", () => {
		const porcelain = ["?? target/debug/build.log", "?? target/", " M src/main.rs", "?? notes.txt"].join("\n")

		expect(filterExpectedOutputs(porcelain, ["target"])).toBe([" M src/main.rs", "?? notes.txt"].join("\n"))
		expect(filterExpectedOutputs(porcelain, [])).toBe(porcelain)
		expect(filterExpectedOutputs("", ["target"])).toBe("")
	})

	it("filterExpectedOutputs only drops a rename line when both sides are expected outputs", () => {
		const insideRename = "R  target/source.bin -> target/new.bin"
		const crossRename = "R  target/source.bin -> src/leaked.bin"

		expect(filterExpectedOutputs(insideRename, ["target"])).toBe("")
		expect(filterExpectedOutputs(crossRename, ["target"])).toBe(crossRename)
	})

	it("filterExpectedOutputs unquotes C-style quoted paths before matching", () => {
		const quoted = '?? "target/weird name.bin"'

		expect(filterExpectedOutputs(quoted, ["target"])).toBe("")
	})
})
