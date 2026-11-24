import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BashOperations } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	createReviewExecutionController,
	executeReviewCommand,
	isDirectInstallCommand,
	offlineEnvironment,
	type ReviewApprovalRequest,
	type ReviewExecutionController,
	type ReviewExecutionEvent,
	reviewExecutionMode,
} from "./execution.js"
import type { ReviewNetworkBoundary } from "./network-boundary.js"
import type { ReviewWorktree } from "./types.js"

const testBoundary: ReviewNetworkBoundary = { kind: "sandbox-exec", wrap: (command) => command }

function fixtureWorktree(root: string): ReviewWorktree {
	const worktree = {
		id: "writer",
		kind: "reviewer",
		revision: "head",
		path: root,
		pinnedSha: "a".repeat(40),
		scratchDir: join(root, ".scratch"),
		buildDir: join(root, ".build"),
		cacheDir: join(root, ".cache"),
		homeDir: join(root, ".home"),
	} as const
	for (const path of [worktree.scratchDir, worktree.buildDir, worktree.cacheDir, worktree.homeDir])
		mkdirSync(path, { recursive: true })
	return {
		...worktree,
		env: {
			TMPDIR: worktree.scratchDir,
			HOME: worktree.homeDir,
			CARGO_TARGET_DIR: join(worktree.buildDir, "target"),
		},
	}
}

describe("review execution mode selection", () => {
	it("keeps local print fail-closed and headless only for a trusted sandbox or override", () => {
		vi.stubEnv("KIMCHI_SANDBOX", "")
		expect(reviewExecutionMode()).toBe("local")
		vi.stubEnv("KIMCHI_SANDBOX", "true")
		expect(reviewExecutionMode()).toBe("headless")
		vi.stubEnv("KIMCHI_SANDBOX", "")
		expect(reviewExecutionMode("headless")).toBe("headless")
		vi.unstubAllEnvs()
	})
})

describe("review command installation detection", () => {
	it.each([
		"npm install",
		"pnpm add package && pnpm test",
		"yarn",
		"bun install",
		"python3 -m pip install package",
		"uv pip install package",
		"go install example.test/tool@latest",
		"cargo add package",
		"bundle install",
		"composer require package/package",
		"npx some-package",
		"bash -c 'pnpm install'",
	])("requires approval for %s", (command) => expect(isDirectInstallCommand(command)).toBe(true))

	it.each([
		"npm test",
		"pnpm run build",
		"go test ./...",
		"cargo test",
		"echo 'npm install'",
		"git status && npm view package",
	])("keeps %s on the ordinary command path", (command) => expect(isDirectInstallCommand(command)).toBe(false))
})

describe("review execution policy", () => {
	let root: string
	let worktree: ReviewWorktree

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "review-execution-test-"))
		worktree = fixtureWorktree(root)
	})

	afterEach(() => {
		vi.unstubAllEnvs()
		rmSync(root, { recursive: true, force: true })
	})

	it("applies offline settings without relying on registry credentials", () => {
		vi.stubEnv("NODE_AUTH_TOKEN", "secret")
		vi.stubEnv("CARGO_REGISTRIES_PRIVATE_TOKEN", "secret")
		vi.stubEnv("GOFLAGS", "-tags=review")
		const environment = offlineEnvironment(process.env)
		expect(environment.npm_config_offline).toBe("true")
		expect(environment.YARN_ENABLE_NETWORK).toBe("0")
		expect(environment.GOPROXY).toBe("off")
		expect(environment.GOFLAGS).toBe("-tags=review -mod=mod")
		expect(environment.PIP_NO_INDEX).toBe("1")
		expect(environment.UV_OFFLINE).toBe("1")
		expect(environment.CARGO_NET_OFFLINE).toBe("true")
		expect(environment.COMPOSER_DISABLE_NETWORK).toBe("1")
		expect(environment.DENO_CACHED_ONLY).toBe("1")
		expect(environment.NODE_AUTH_TOKEN).toBeUndefined()
		expect(environment.CARGO_REGISTRIES_PRIVATE_TOKEN).toBeUndefined()
	})

	it("runs a script needing no network without an approval", async () => {
		const script = join(worktree.path, "no-network.cjs")
		writeFileSync(script, "require('node:fs').writeFileSync('ran', 'yes')")
		const controller = createReviewExecutionController({ mode: "local", worktree, networkBoundary: testBoundary })
		const approve = vi.fn(async () => "approved" as const)
		controller.bindApprover(approve)
		const result = await controller.execute({
			command: "node no-network.cjs",
			cwd: worktree.path,
			intendedCheck: "offline script",
		})
		expect(result).toMatchObject({ status: "passed", exitCode: 0, network: "offline", approval: "not-requested" })
		expect(readFileSync(join(worktree.path, "ran"), "utf8")).toBe("yes")
		expect(approve).not.toHaveBeenCalled()
	})

	it("fails a pretend install offline and installs only after one approved online rerun", async () => {
		writeFileSync(
			join(worktree.path, "pretend-install.cjs"),
			`if (process.env.npm_config_offline === 'true') { console.error('network required'); process.exit(9) }
require('node:fs').writeFileSync('installed', 'yes')`,
		)
		const controller = createReviewExecutionController({ mode: "local", worktree, networkBoundary: testBoundary })
		const approve = vi.fn(
			async (_request: ReviewApprovalRequest, _execution: ReviewExecutionEvent) => "approved" as const,
		)
		controller.bindApprover(approve)
		const input = { command: "node pretend-install.cjs", cwd: worktree.path, intendedCheck: "dependency-backed test" }
		const offline = await controller.execute(input)
		expect(offline).toMatchObject({ status: "failed", exitCode: 9, network: "offline" })
		expect(offline.output).toContain("network required")
		expect(existsSync(join(worktree.path, "installed"))).toBe(false)
		expect(approve).not.toHaveBeenCalled()

		const online = await controller.execute({ ...input, online: true, toolCallId: "rerun" })
		expect(online).toMatchObject({ status: "passed", exitCode: 0, network: "approved-online", approval: "approved" })
		expect(readFileSync(join(worktree.path, "installed"), "utf8")).toBe("yes")
		expect(approve).toHaveBeenCalledTimes(1)
		expect(approve.mock.calls[0][0]).toMatchObject({
			kind: "online-rerun",
			command: input.command,
			worktrees: [worktree.path],
		})
	})

	it("requires and honors direct-install approval", async () => {
		const controller = createReviewExecutionController({ mode: "local", worktree, networkBoundary: testBoundary })
		controller.bindApprover(async () => "approved")
		const environments: NodeJS.ProcessEnv[] = []
		const operations: BashOperations = {
			exec: async (_command, _cwd, options) => {
				environments.push(options.env ?? {})
				return { exitCode: 0 }
			},
		}
		const result = await executeReviewCommand(controller, {
			command: "npm install",
			cwd: worktree.path,
			intendedCheck: "install",
			worktree,
			operations,
		})
		expect(result).toMatchObject({ status: "passed", network: "approved-online", approval: "approved" })
		expect(environments[0]?.npm_config_offline).toBeUndefined()
	})

	it("leaves declined online work unrun", async () => {
		const controller = createReviewExecutionController({ mode: "local", worktree, networkBoundary: testBoundary })
		controller.bindApprover(async () => "declined")
		const operations = { exec: vi.fn() }
		const result = await executeReviewCommand(controller, {
			command: "npm install",
			cwd: worktree.path,
			intendedCheck: "install",
			worktree,
			operations,
		})
		expect(result).toMatchObject({ status: "blocked", approval: "declined", network: "unenforced" })
		expect(operations.exec).not.toHaveBeenCalled()
	})

	it("blocks local print without a sandbox when offline enforcement is unavailable", async () => {
		vi.stubEnv("KIMCHI_SANDBOX", "")
		const controller = createReviewExecutionController({
			mode: reviewExecutionMode(),
			worktree,
			networkBoundary: null,
		})
		const operations = { exec: vi.fn() }
		const result = await executeReviewCommand(controller, {
			command: "npm test",
			cwd: worktree.path,
			intendedCheck: "local print test",
			worktree,
			operations,
		})
		expect(result).toMatchObject({
			status: "blocked",
			network: "unenforced",
			approval: "unavailable",
		})
		expect(result.output).toContain("requires online approval")
		expect(operations.exec).not.toHaveBeenCalled()
	})

	it("runs sandbox-detected headless commands without offline variables or approval", async () => {
		vi.stubEnv("KIMCHI_SANDBOX", "true")
		const controller: ReviewExecutionController = createReviewExecutionController({
			mode: reviewExecutionMode(),
			worktree,
		})
		const approve = vi.fn(async () => "approved" as const)
		controller.bindApprover(approve)
		let environment: NodeJS.ProcessEnv | undefined
		const operations: BashOperations = {
			exec: async (_command, _cwd, options) => {
				environment = options.env
				return { exitCode: 23 }
			},
		}
		const result = await executeReviewCommand(controller, {
			command: "npm install",
			cwd: worktree.path,
			intendedCheck: "sandbox-controlled install",
			worktree,
			operations,
		})
		expect(result).toMatchObject({ status: "failed", exitCode: 23, network: "sandbox", approval: "not-requested" })
		expect(environment?.npm_config_offline).toBeUndefined()
		expect(environment?.GOPROXY).toBe(process.env.GOPROXY)
		expect(approve).not.toHaveBeenCalled()
	})
})
