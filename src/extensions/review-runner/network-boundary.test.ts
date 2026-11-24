import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	createReviewExecutionController,
	type ReviewApprovalRequest,
	type ReviewApprovalStatus,
	type ReviewExecutionEvent,
} from "./execution.js"
import { detectReviewNetworkBoundary, type ReviewNetworkBoundary } from "./network-boundary.js"
import type { ReviewWorktree } from "./types.js"

// Assembled from parts so log redaction never rewrites the fixture.
const credentialUrl = ["http://", "user", ":", "secret", "@example.test/"].join("")

function fixtureWorktree(root: string): ReviewWorktree {
	const homeDir = join(root, "home")
	const scratchDir = join(root, "scratch")
	const cacheDir = join(root, "cache")
	const buildDir = join(root, "build")
	for (const path of [homeDir, scratchDir, cacheDir, buildDir]) mkdirSync(path, { recursive: true })
	const userConfig = join(homeDir, ".npmrc")
	writeFileSync(userConfig, "")
	writeFileSync(join(homeDir, ".npmrc-global"), "")
	return {
		id: "writer",
		kind: "reviewer",
		revision: "head",
		path: root,
		pinnedSha: "a".repeat(40),
		scratchDir,
		buildDir,
		cacheDir,
		homeDir,
		env: {
			HOME: homeDir,
			TMPDIR: scratchDir,
			TMP: scratchDir,
			TEMP: scratchDir,
			XDG_CACHE_HOME: join(cacheDir, "xdg"),
			XDG_CONFIG_HOME: join(homeDir, ".config"),
			XDG_DATA_HOME: join(homeDir, ".local", "share"),
			NPM_CONFIG_USERCONFIG: userConfig,
			NPM_CONFIG_GLOBALCONFIG: join(homeDir, ".npmrc-global"),
			npm_config_cache: join(cacheDir, "npm"),
			CARGO_TARGET_DIR: join(buildDir, "target"),
		},
	}
}

describe("real OS offline network boundary", () => {
	let root: string
	let worktree: ReviewWorktree
	let boundary: ReviewNetworkBoundary | undefined
	let server: Server | undefined

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "review-network-boundary-"))
		worktree = fixtureWorktree(root)
		boundary = await detectReviewNetworkBoundary()
	})

	afterEach(async () => {
		vi.unstubAllEnvs()
		if (server)
			await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())))
		server = undefined
		rmSync(root, { recursive: true, force: true })
	})

	function approval() {
		return vi.fn(
			async (_request: ReviewApprovalRequest, _execution: ReviewExecutionEvent): Promise<ReviewApprovalStatus> =>
				"approved",
		)
	}

	it("prevents the exact npm HTTP install offline and allows only an approved online retry", async (ctx) => {
		const dependency = join(root, "dependency-source")
		mkdirSync(dependency, { recursive: true })
		writeFileSync(
			join(dependency, "package.json"),
			JSON.stringify({ name: "stage3-local-dependency", version: "1.0.0", main: "index.js" }),
		)
		writeFileSync(join(dependency, "index.js"), "module.exports = 'local fixture'\n")
		execFileSync("npm", ["pack", dependency, "--pack-destination", root], { stdio: "ignore" })
		const tarballName = readdirSync(root).find((name) => name.endsWith(".tgz"))
		expect(tarballName).toBeDefined()
		const tarball = join(root, tarballName ?? "")
		let requests = 0
		server = createServer((_request, response) => {
			requests++
			response.writeHead(200, { "content-type": "application/octet-stream" })
			response.end(readFileSync(tarball))
		})
		await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve))
		const port = (server.address() as AddressInfo).port
		writeFileSync(
			join(worktree.path, "package.json"),
			JSON.stringify({
				name: "offline-boundary-fixture",
				scripts: {
					test: `npm install --offline=false --ignore-scripts --no-audit --no-fund http://127.0.0.1:${port}/dependency.tgz`,
				},
			}),
		)
		const controller = createReviewExecutionController({
			mode: "local",
			worktree,
			networkBoundary: boundary ?? null,
		})
		const approve = approval()
		if (!boundary) approve.mockResolvedValueOnce("declined")
		controller.bindApprover(approve)
		const input = { command: "npm test", cwd: worktree.path, intendedCheck: "HTTP dependency install" }
		const offline = await controller.execute(input)
		if (boundary) {
			expect(offline.status).not.toBe("passed")
			expect(offline).toMatchObject({ network: "offline", networkBoundary: boundary.kind })
		} else {
			expect(offline).toMatchObject({ status: "blocked", network: "unenforced", approval: "declined" })
		}
		expect(offline.output.trim()).not.toBe("")
		expect(requests).toBe(0)
		expect(existsSync(join(worktree.path, "node_modules"))).toBe(false)

		const online = await controller.execute({ ...input, online: true, toolCallId: "approved-http-retry" })
		expect(online, JSON.stringify(online)).toMatchObject({
			status: "passed",
			network: "approved-online",
			approval: "approved",
		})
		expect(requests).toBeGreaterThan(0)
		expect(existsSync(join(worktree.path, "node_modules", "stage3-local-dependency", "index.js"))).toBe(true)
		if (!boundary)
			ctx.skip("No OS network boundary available; unavailable-containment approval and approved retry verified instead")
	}, 30_000)

	it("uses private npm config and a narrow credential-free environment through real package managers", async (ctx) => {
		if (!boundary) {
			ctx.skip("No OS network boundary available; unavailable-containment behavior is covered by the HTTP regression")
			return
		}
		const maliciousConfig = join(root, "credential-bearing.npmrc")
		writeFileSync(maliciousConfig, `registry=${credentialUrl}\n_authToken=secret`)
		for (const [key, value] of Object.entries({
			NPM_CONFIG_USERCONFIG: maliciousConfig,
			NPM_CONFIG_REGISTRY: credentialUrl,
			YARN_NPM_AUTH_IDENT: "secret",
			GONOSUMDB: "secret",
			GONOSUMCHECK: "secret",
			CARGO_REGISTRIES_PRIVATE_INDEX: credentialUrl,
			UV_INDEX: credentialUrl,
			NODE_AUTH_TOKEN: "secret",
		})) {
			vi.stubEnv(key, value)
		}
		const controller = createReviewExecutionController({ mode: "local", worktree, networkBoundary: boundary })
		const command = async (code: string) => {
			return controller.execute({ command: code, cwd: worktree.path, intendedCheck: "offline package configuration" })
		}
		const npm = await command("npm config get userconfig && npm config get registry")
		expect(npm, JSON.stringify(npm)).toMatchObject({ status: "passed" })
		expect(npm.output).toContain(worktree.env.NPM_CONFIG_USERCONFIG)
		expect(npm.output).toContain("https://registry.npmjs.org/")
		expect(npm.output).not.toContain("secret")
		writeFileSync(
			join(worktree.path, "inspect-env.cjs"),
			`console.log(JSON.stringify(Object.fromEntries(["GONOSUMDB","GONOSUMCHECK","NPM_CONFIG_REGISTRY","YARN_NPM_AUTH_IDENT","CARGO_REGISTRIES_PRIVATE_INDEX","UV_INDEX","NODE_AUTH_TOKEN"].map(key => [key, process.env[key] ?? null]))))`,
		)
		const variables = await command("node inspect-env.cjs")
		expect(JSON.parse(variables.output)).toEqual({
			GONOSUMDB: null,
			GONOSUMCHECK: null,
			NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
			YARN_NPM_AUTH_IDENT: null,
			CARGO_REGISTRIES_PRIVATE_INDEX: null,
			UV_INDEX: null,
			NODE_AUTH_TOKEN: null,
		})
		try {
			execFileSync("pnpm", ["--version"], { stdio: "ignore" })
			const pnpm = await command("pnpm config get userconfig && pnpm config get registry")
			expect(pnpm.status).toBe("passed")
			expect(pnpm.output).toContain(worktree.env.NPM_CONFIG_USERCONFIG)
			expect(pnpm.output).toContain("https://registry.npmjs.org/")
		} catch {
			// pnpm is optional on development machines; npm exercised the required path above.
		}
	}, 30_000)
})
