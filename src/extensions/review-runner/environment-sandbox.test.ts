import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createReviewExecutionController } from "./execution.js"
import { detectReviewNetworkBoundary, type ReviewNetworkBoundary } from "./network-boundary.js"
import type { ReviewWorktree } from "./types.js"

function quote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`
}

describe("read-only review cache sandbox", () => {
	let root: string
	let boundary: ReviewNetworkBoundary | undefined
	let worktree: ReviewWorktree
	let cacheDir: string
	let server: Server | undefined

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "review-cache-sandbox-"))
		boundary = await detectReviewNetworkBoundary()
		cacheDir = join(root, "shared-cache")
		mkdirSync(cacheDir)
		writeFileSync(join(cacheDir, "artifact.txt"), "original-cache-bytes\n")
		writeFileSync(join(cacheDir, "delete-me.txt"), "keep\n")
		cacheDir = realpathSync(cacheDir)
		const checkout = join(root, "checkout")
		const scratchDir = join(root, "scratch")
		const buildDir = join(root, "build")
		const privateCacheDir = join(root, "private-cache")
		const homeDir = join(root, "home")
		for (const path of [checkout, scratchDir, buildDir, privateCacheDir, homeDir]) mkdirSync(path)
		worktree = {
			id: "sandbox-fixture",
			kind: "reviewer",
			revision: "head",
			path: checkout,
			pinnedSha: "a".repeat(40),
			scratchDir,
			buildDir,
			cacheDir: privateCacheDir,
			homeDir,
			readOnlyCachePaths: [cacheDir],
			env: {
				HOME: homeDir,
				TMPDIR: scratchDir,
				TMP: scratchDir,
				TEMP: scratchDir,
				XDG_CACHE_HOME: join(privateCacheDir, "xdg"),
				XDG_CONFIG_HOME: join(homeDir, ".config"),
				XDG_DATA_HOME: join(homeDir, ".local", "share"),
			},
		}
	})

	afterEach(async () => {
		if (server) await new Promise<void>((resolve) => server?.close(() => resolve()))
		server = undefined
		rmSync(root, { recursive: true, force: true })
	})

	it("allows cache reads and private writes but no cache mutation or network", { timeout: 30_000 }, async (ctx) => {
		if (!boundary || boundary.kind === "unshare-net") {
			ctx.skip("A filesystem-confining sandbox-exec or bwrap boundary is required")
			return
		}
		const controller = createReviewExecutionController({ mode: "local", worktree, networkBoundary: boundary })
		const execute = (command: string) =>
			controller.execute({ command, cwd: worktree.path, intendedCheck: "read-only cache boundary" })

		const read = await execute(`cat ${quote(join(cacheDir, "artifact.txt"))}`)
		expect(read, JSON.stringify(read)).toMatchObject({ status: "passed", network: "offline" })
		expect(read.output).toContain("original-cache-bytes")

		for (const command of [
			`printf mutated > ${quote(join(cacheDir, "artifact.txt"))}`,
			`printf created > ${quote(join(cacheDir, "created.txt"))}`,
			`rm ${quote(join(cacheDir, "delete-me.txt"))}`,
		]) {
			const denied = await execute(command)
			expect(denied, JSON.stringify(denied)).toMatchObject({ status: "failed", network: "offline" })
		}
		expect(readFileSync(join(cacheDir, "artifact.txt"), "utf8")).toBe("original-cache-bytes\n")
		expect(readFileSync(join(cacheDir, "delete-me.txt"), "utf8")).toBe("keep\n")
		expect(existsSync(join(cacheDir, "created.txt"))).toBe(false)

		const privatePath = join(worktree.scratchDir, "private.txt")
		const privateWrite = await execute(`printf private > ${quote(privatePath)}`)
		expect(privateWrite, JSON.stringify(privateWrite)).toMatchObject({ status: "passed" })
		expect(readFileSync(privatePath, "utf8")).toBe("private")

		let requests = 0
		server = createServer((_request, response) => {
			requests += 1
			response.end("online")
		})
		await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve))
		const port = (server.address() as AddressInfo).port
		const script = `fetch('http://127.0.0.1:${port}').then(() => process.exit(0)).catch(() => process.exit(1))`
		const network = await execute(`${quote(process.execPath)} -e ${quote(script)}`)
		expect(network, JSON.stringify(network)).toMatchObject({ status: "failed", network: "offline" })
		expect(requests).toBe(0)
	})
})
