import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
	buildValidationCatalog,
	captureWorkspaceSnapshot,
	restoreWorkspaceSnapshot,
	validationCatalogForPrompt,
	validationCommand,
} from "./validation.js"

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

describe("Council validation workspace snapshots", () => {
	it("restores changed, deleted, and newly-created paths", async () => {
		const root = await fixture()
		await mkdir(join(root, "nested"))
		await writeFile(join(root, "kept.txt"), "before\n")
		await writeFile(join(root, "nested", "deleted.txt"), "before\n")
		const before = await captureWorkspaceSnapshot(root)

		await writeFile(join(root, "kept.txt"), "changed\n")
		await rm(join(root, "nested", "deleted.txt"))
		await writeFile(join(root, "leak.txt"), "leak\n")

		await restoreWorkspaceSnapshot(root, before)

		expect(await readFile(join(root, "kept.txt"), "utf8")).toBe("before\n")
		expect(await readFile(join(root, "nested", "deleted.txt"), "utf8")).toBe("before\n")
		await expect(readFile(join(root, "leak.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
		expect((await captureWorkspaceSnapshot(root)).sha256).toBe(before.sha256)
	})

	it("excludes only typed expected-output paths from the workspace hash", async () => {
		const root = await fixture()
		await writeFile(join(root, "source.txt"), "source\n")
		const before = await captureWorkspaceSnapshot(root, ["dist"])
		await mkdir(join(root, "dist"))
		await writeFile(join(root, "dist", "report.json"), "{}\n")

		expect((await captureWorkspaceSnapshot(root, ["dist"])).sha256).toBe(before.sha256)

		await writeFile(join(root, "source.txt"), "changed\n")
		expect((await captureWorkspaceSnapshot(root, ["dist"])).sha256).not.toBe(before.sha256)
	})
})
