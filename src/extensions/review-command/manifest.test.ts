import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import {
	loadPreparedReviewManifest,
	parseReviewManifestDeadline,
	REVIEW_MANIFEST_SCHEMA_VERSION,
	readReviewManifest,
	validateReviewManifest,
} from "./manifest.js"

const exec = promisify(execFile)
const temporaryDirectories: string[] = []

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function validManifest() {
	return {
		schema_version: REVIEW_MANIFEST_SCHEMA_VERSION,
		base_sha: "a".repeat(40),
		head_sha: "b".repeat(40),
		checkout_path: "/tmp/repository",
		context_dir: "/tmp/review-context",
		output_dir: "/tmp/review-output",
		deadline: "2026-11-25T12:34:56.123Z",
	}
}

describe("review manifest validation", () => {
	it("accepts exactly the v1 fields and normalizes absolute paths", () => {
		expect(validateReviewManifest(validManifest())).toEqual(validManifest())
	})

	it("rejects missing and extra fields", async () => {
		const { output_dir: _output, ...missing } = validManifest()
		expect(() => validateReviewManifest(missing)).toThrow("missing fields: output_dir")
		expect(() => validateReviewManifest({ ...validManifest(), grace_seconds: 60 })).toThrow(
			"unexpected fields: grace_seconds",
		)
		const path = join(await mkdtemp(join(tmpdir(), "kimchi-manifest-")), "manifest.json")
		temporaryDirectories.push(join(path, ".."))
		await writeFile(path, JSON.stringify({ ...validManifest(), extra: true }))
		await expect(readReviewManifest(path)).rejects.toThrow("unexpected fields: extra")
	})

	it("rejects the wrong schema and malformed revision/path fields", () => {
		expect(() => validateReviewManifest({ ...validManifest(), schema_version: "review-manifest/v2" })).toThrow(
			"review-manifest/v1",
		)
		expect(() => validateReviewManifest({ ...validManifest(), base_sha: "main" })).toThrow("base_sha")
		expect(() => validateReviewManifest({ ...validManifest(), checkout_path: "repository" })).toThrow("absolute path")
	})

	it("accepts only real absolute UTC RFC 3339 deadlines", () => {
		expect(parseReviewManifestDeadline("2026-11-25T12:34:56.123456Z")).toBe(Date.parse("2026-11-25T12:34:56.123Z"))
		for (const deadline of [
			"2026-11-25T12:34:56+00:00",
			"2026-11-25 12:34:56Z",
			"2026-02-30T12:34:56Z",
			"2026-11-25T25:34:56Z",
			"2026-11-25T12:34:60Z",
			"tomorrow",
		]) {
			expect(() => parseReviewManifestDeadline(deadline)).toThrow("deadline")
		}
	})

	it("reads the shared contract fixture manifest", async () => {
		const fixture = join(__dirname, "..", "review-submit", "testdata", "v1", "review-context", "manifest.json")
		const manifest = await readReviewManifest(fixture)
		const provider = JSON.parse(
			await readFile(join(__dirname, "..", "review-submit", "testdata", "v1", "provider-diff.json"), "utf8"),
		)
		expect(manifest.base_sha).toBe(provider.merge_base_sha)
		expect(manifest.head_sha).toBe(provider.commit_sha)
	})
})

describe("prepared manifest checkout", () => {
	async function repositoryFixture() {
		const directory = await mkdtemp(join(tmpdir(), "kimchi-manifest-git-"))
		temporaryDirectories.push(directory)
		const checkout = join(directory, "checkout")
		const context = join(directory, "context")
		const output = join(directory, "output")
		await mkdir(checkout)
		await mkdir(context)
		await mkdir(output)
		await exec("git", ["init", checkout])
		await exec("git", ["-C", checkout, "config", "user.email", "review@example.invalid"])
		await exec("git", ["-C", checkout, "config", "user.name", "Review fixture"])
		await writeFile(join(checkout, "file.txt"), "base\n")
		await exec("git", ["-C", checkout, "add", "file.txt"])
		await exec("git", ["-C", checkout, "commit", "-m", "base"])
		const base = (await exec("git", ["-C", checkout, "rev-parse", "HEAD"])).stdout.trim()
		await writeFile(join(checkout, "file.txt"), "base\nhead\n")
		await exec("git", ["-C", checkout, "commit", "-am", "head"])
		const head = (await exec("git", ["-C", checkout, "rev-parse", "HEAD"])).stdout.trim()
		const manifest = validateReviewManifest({
			...validManifest(),
			base_sha: base,
			head_sha: head,
			checkout_path: checkout,
			context_dir: context,
			output_dir: output,
		})
		return { manifest, checkout, context, output, base, head }
	}

	it("verifies both SHAs and returns the common pinned target shape", async () => {
		const { manifest, checkout, context, base, head } = await repositoryFixture()
		const path = join(context, "manifest.json")
		await writeFile(path, JSON.stringify(manifest))
		const prepared = await loadPreparedReviewManifest(path)
		expect(prepared.target.scope.pinned).toEqual({ baseSha: base, headSha: head, tipSha: head })
		expect(prepared.target.scope.checkoutPath).toBe(prepared.manifest.checkout_path)
		expect(prepared.target.scope.checkoutPath).toContain(checkout.slice(1))
		expect(prepared.target.scope.contextDir).toBe(context)
		expect(prepared.target.scope.files).toEqual({ changed: 1, anchorable: 1, unanchorable: 0 })
		expect(prepared.deadlineMs).toBe(Date.parse(manifest.deadline))
	})

	it("rejects a SHA absent from the prepared checkout", async () => {
		const { manifest } = await repositoryFixture()
		const replaced = { ...manifest, head_sha: "c".repeat(40) }
		await expect(readFile(join(manifest.context_dir, "manifest.json"), "utf8")).rejects.toThrow()
		await expect(loadPreparedReviewManifest(await writeManifest(replaced))).rejects.toMatchObject({
			code: "manifest_revision_mismatch",
		})
	})

	it("rejects a base that is not the merge base of the head", async () => {
		const { manifest, base, head } = await repositoryFixture()
		await expect(
			loadPreparedReviewManifest(await writeManifest({ ...manifest, base_sha: head, head_sha: base })),
		).rejects.toMatchObject({
			code: "manifest_revision_mismatch",
		})
	})

	async function writeManifest(manifest: ReturnType<typeof validateReviewManifest>): Promise<string> {
		const path = join(manifest.context_dir, "manifest.json")
		await writeFile(path, JSON.stringify(manifest))
		return path
	}
})
