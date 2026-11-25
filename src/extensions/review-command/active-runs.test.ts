import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createCommandContext, sendTerminalInput } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { acquireReviewOperation } from "./active-runs.js"
import reviewCommandExtension from "./index.js"
import { currentReviewHost, currentReviewOwnerIdentity } from "./owner-identity.js"
import { createLocalReviewRunDirectory } from "./run-directory.js"

const temporaryDirectories: string[] = []

afterEach(() => {
	for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function sandbox(): { root: string; outputRoot: string; checkoutPath: string } {
	const root = mkdtempSync(join(tmpdir(), "review-active-runs-"))
	temporaryDirectories.push(root)
	return { root, outputRoot: join(root, "review-output"), checkoutPath: root }
}

describe("active local review runs", () => {
	it("uses distinct directories, rejects concurrency, and releases its persistent lock after cleanup", async () => {
		const ctx = createCommandContext()
		const { outputRoot, checkoutPath } = sandbox()
		const firstDir = await createLocalReviewRunDirectory(outputRoot)
		const first = await acquireReviewOperation(ctx, checkoutPath, firstDir)
		expect(existsSync(join(outputRoot, "active-review.json"))).toBe(true)
		const competingDir = await createLocalReviewRunDirectory(outputRoot)
		expect(competingDir).not.toBe(firstDir)
		await expect(acquireReviewOperation(ctx, checkoutPath, competingDir)).rejects.toMatchObject({
			code: "review_in_progress",
		})
		await first.finish()
		await expect(first.completion).resolves.toBeUndefined()
		expect(existsSync(join(outputRoot, "active-review.json"))).toBe(false)
		const second = await acquireReviewOperation(ctx, checkoutPath, competingDir)
		await second.finish()
	})

	it("waits for active cleanup during session shutdown", async () => {
		const ctx = createCommandContext()
		const { outputRoot, checkoutPath } = sandbox()
		const { api, emit } = createExtensionApi()
		reviewCommandExtension(api)
		const runDir = await createLocalReviewRunDirectory(outputRoot)
		const operation = await acquireReviewOperation(ctx, checkoutPath, runDir)
		const shutdown = emit("session_shutdown", {}, ctx)
		expect(operation.cancelled).toBe(true)
		await operation.finish()
		await expect(shutdown).resolves.toBeDefined()
	})

	it.each(["\u001b", "\u0003"])("aborts the active operation on terminal input %j", async (sequence) => {
		const ctx = createCommandContext()
		const { outputRoot, checkoutPath } = sandbox()
		const runDir = await createLocalReviewRunDirectory(outputRoot)
		const operation = await acquireReviewOperation(ctx, checkoutPath, runDir)
		sendTerminalInput(ctx, sequence)
		expect(operation.cancelled).toBe(true)
		await operation.finish()
	})

	it("reclaims PID reuse when the current process has a different start identity", async () => {
		const ctx = createCommandContext()
		const { outputRoot, checkoutPath } = sandbox()
		const runDir = await createLocalReviewRunDirectory(outputRoot)
		writeFileSync(
			join(outputRoot, "active-review.json"),
			JSON.stringify({
				token: "reused-pid-owner",
				pid: process.pid,
				owner_host: currentReviewHost(),
				owner_start: "different-process-start",
				checkoutPath,
				runDir,
			}),
		)
		const operation = await acquireReviewOperation(ctx, checkoutPath, runDir)
		const current = JSON.parse(readFileSync(join(outputRoot, "active-review.json"), "utf8"))
		expect(current.token).not.toBe("old-process-start")
		await operation.finish()
	})

	it("preserves another host's lock even when its PID cannot exist locally", async () => {
		const ctx = createCommandContext()
		const { outputRoot, checkoutPath } = sandbox()
		const runDir = await createLocalReviewRunDirectory(outputRoot)
		const lockPath = join(outputRoot, "active-review.json")
		writeFileSync(
			lockPath,
			JSON.stringify({
				token: "foreign-owner",
				pid: 2 ** 30,
				owner_host: "another-host.invalid",
				owner_start: "different-process-start",
				checkoutPath,
				runDir,
			}),
		)
		await expect(acquireReviewOperation(ctx, checkoutPath, runDir)).rejects.toThrow(
			/another host|remove only this file/,
		)
		expect(JSON.parse(readFileSync(lockPath, "utf8")).token).toBe("foreign-owner")
	})

	it("blocks a live local lock whose host and process-start identity match", async () => {
		const ctx = createCommandContext()
		const { outputRoot, checkoutPath } = sandbox()
		const runDir = await createLocalReviewRunDirectory(outputRoot)
		const owner = await currentReviewOwnerIdentity()
		const lockPath = join(outputRoot, "active-review.json")
		writeFileSync(
			lockPath,
			JSON.stringify({
				token: "live-owner",
				pid: process.pid,
				owner_host: owner.hostname,
				owner_start: owner.startIdentity,
				checkoutPath,
				runDir,
			}),
		)
		await expect(acquireReviewOperation(ctx, checkoutPath, runDir)).rejects.toMatchObject({
			code: "review_in_progress",
		})
		expect(JSON.parse(readFileSync(lockPath, "utf8")).token).toBe("live-owner")
	})

	it("reclaims a stale lock left by a dead process without deleting old run artifacts", async () => {
		const ctx = createCommandContext()
		const { outputRoot, checkoutPath } = sandbox()
		const runDir = await createLocalReviewRunDirectory(outputRoot)
		const oldArtifact = join(runDir, "summary.json")
		writeFileSync(oldArtifact, "{}")
		writeFileSync(
			join(outputRoot, "active-review.json"),
			JSON.stringify({
				token: "dead-owner",
				pid: 2 ** 30,
				owner_host: currentReviewHost(),
				owner_start: "dead-process-start",
				checkoutPath,
				runDir,
			}),
		)
		const operation = await acquireReviewOperation(ctx, checkoutPath, runDir)
		expect(existsSync(oldArtifact)).toBe(true)
		const current = JSON.parse(readFileSync(join(outputRoot, "active-review.json"), "utf8"))
		expect(current.token).not.toBe("dead-owner")
		await operation.finish()
		expect(existsSync(oldArtifact)).toBe(true)
	})
})
