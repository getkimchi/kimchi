import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	assembleReviewEnvironment,
	emptyReviewEnvironmentSpec,
	type PrepareReviewEnvironmentOptions,
	parseTrustedReviewEnvironment,
	prepareReviewEnvironment,
	REVIEW_ENVIRONMENT_PROMPT_LIMIT,
	type ReviewEnvironmentPlan,
	type ReviewEnvironmentReceipt,
	type ReviewEnvironmentSpec,
	resolveReviewEnvironmentPlan,
	reviewEnvironmentPromptNote,
} from "./environment.js"
import type { ReviewNetworkBoundary } from "./network-boundary.js"
import type { ReviewWorktree } from "./types.js"

function spec(overrides: Partial<ReviewEnvironmentSpec> = {}): ReviewEnvironmentSpec {
	return { ...emptyReviewEnvironmentSpec(), ...structuredClone(overrides) }
}

function command(required = true): { argv: string[]; cwd: string; timeoutMs: number; required: boolean } {
	return { argv: ["fixture-tool", "prepare"], cwd: ".", timeoutMs: 1000, required }
}

function probe(id: string, required = true): ReviewEnvironmentSpec["probes"][number] {
	return { id, argv: ["fixture-tool", "probe"], cwd: ".", timeoutMs: 1000, required }
}

const enforceable: ReviewNetworkBoundary = { kind: "sandbox-exec", wrap: (value) => value }
const fixtureProxyUrl = "https://fixture-user:" + "fixture-pass" + "@proxy.invalid"
const fixtureDsn = "postgres://fixture-user:" + "fixture-pass" + "@localhost/review"

describe("trusted review environments", () => {
	let root: string
	let protectedDir: string
	let cacheDir: string
	let worktree: PrepareReviewEnvironmentOptions["worktree"]

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "review-environment-unit-"))
		protectedDir = join(root, "protected")
		cacheDir = join(root, "shared-cache")
		mkdirSync(protectedDir)
		mkdirSync(cacheDir)
		writeFileSync(join(cacheDir, "artifact"), "cache-bytes")
		cacheDir = realpathSync(cacheDir)
		const base = join(root, "worktree")
		worktree = {
			id: "spec",
			kind: "reviewer",
			revision: "head",
			path: join(base, "checkout"),
			pinnedSha: "a".repeat(40),
			scratchDir: join(base, "scratch"),
			buildDir: join(base, "build"),
			cacheDir: join(base, "cache"),
			homeDir: join(base, "home"),
			gitAdminDir: join(root, "git-admin"),
		}
		for (const path of [worktree.path, worktree.scratchDir, worktree.buildDir, worktree.cacheDir, worktree.homeDir]) {
			mkdirSync(path, { recursive: true })
		}
	})

	afterEach(() => {
		vi.restoreAllMocks()
		rmSync(root, { recursive: true, force: true })
	})

	function planFor(
		requestedSpec: ReviewEnvironmentSpec,
		gaps: ReviewEnvironmentPlan["gaps"] = [],
	): ReviewEnvironmentPlan {
		return {
			profileApplied: true,
			requestedSpec,
			caches: [{ id: "shared", path: cacheDir }],
			toolchains: [{ id: "fixture", bin: [join(root, "tool-bin")] }],
			gaps,
		}
	}

	function preparation(
		requestedSpec: ReviewEnvironmentSpec,
		overrides: Partial<PrepareReviewEnvironmentOptions> = {},
	): PrepareReviewEnvironmentOptions {
		return {
			worktreeId: "reviewer:head:spec",
			worktree,
			privateEnv: {
				HOME: worktree.homeDir,
				TMPDIR: worktree.scratchDir,
				KIMCHI_REVIEW_WORKTREE: worktree.path,
				KIMCHI_REVIEW_SCRATCH_DIR: worktree.scratchDir,
			},
			plan: planFor(requestedSpec),
			boundary: {
				kind: "sandbox-exec",
				capabilities: { networkOff: true, filesystemConfinement: true, readOnlyMounts: true },
			},
			forbiddenCachePaths: [
				protectedDir,
				worktree.path,
				worktree.scratchDir,
				worktree.buildDir,
				worktree.cacheDir,
				worktree.homeDir,
			],
			baseEnv: {
				PATH: "/safe/bin:/usr/bin",
				GOPROXY: fixtureProxyUrl,
				HTTP_PROXY: fixtureProxyUrl,
				FIXTURE_AUTH_TOKEN: "placeholder",
			},
			execute: vi.fn(async () => ({ status: "passed" as const, exitCode: 0, elapsedMs: 1, output: "ok" })),
			resetToIsolated: vi.fn(async (failedWorktree: ReviewWorktree) => ({
				worktree: failedWorktree,
				privateEnv: { HOME: failedWorktree.homeDir, TMPDIR: failedWorktree.scratchDir },
			})),
			...overrides,
		}
	}

	it.each([
		["bad catalog ID", { caches: [{ id: "not valid", path: "/tmp" }] }],
		[
			"duplicate IDs",
			{
				caches: [
					{ id: "same", path: "/tmp" },
					{ id: "same", path: "/tmp" },
				],
			},
		],
		["forbidden parent interpolation", { profiles: { default: { env: { VALUE: "${env:HOME}" } } } }],
		["unterminated substitution", { profiles: { default: { env: { VALUE: "${cache:shared" } } } }],
		["oversized env", { profiles: { default: { env: { VALUE: "x".repeat(4097) } } } }],
		["spec PATH", { profiles: { default: { env: { PATH: "/unsafe" } } } }],
		["unknown key", { profiles: { default: { copyIgnoredFiles: { reason: "no" } } } }],
	])("rejects %s with a typed isolated fallback", (_name, environment) => {
		const parsed = parseTrustedReviewEnvironment(environment)
		expect(parsed.gaps[0]).toMatchObject({ kind: "invalid_environment_settings", name: "review.environment" })
		expect(parsed.settings.caches).toEqual([])
		expect(parsed.settings.profiles.default).toBeUndefined()
		expect(parsed.settings.profiles.repositories).toEqual({})
	})

	it("rejects missing and symlinked catalog paths without exposing them", async () => {
		const missing = parseTrustedReviewEnvironment({ caches: [{ id: "shared", path: join(root, "missing") }] })
		const unresolved = await resolveReviewEnvironmentPlan(missing.settings, protectedDir)
		expect(unresolved.caches).toEqual([])
		expect(unresolved.gaps[0]).toMatchObject({ kind: "invalid_environment_cache", name: "shared" })
		const parsed = parseTrustedReviewEnvironment({ caches: [{ id: "shared", path: cacheDir }] })
		const link = join(root, "cache-link")
		symlinkSync(cacheDir, link, "dir")
		const symlinkedCache = parsed.settings.caches[0]
		if (!symlinkedCache) throw new Error("expected the parsed cache fixture")
		symlinkedCache.path = link
		const linked = await resolveReviewEnvironmentPlan(parsed.settings, protectedDir)
		expect(linked.caches).toEqual([])
		expect(linked.gaps[0]?.note).toContain("symbolic link")
	})

	it("rejects cache overlap and private symlink traversal before executing setup", async () => {
		const overlap = await prepareReviewEnvironment(
			preparation(spec({ readOnlyCaches: ["shared"] }), {
				forbiddenCachePaths: [root],
			}),
		)
		expect(overlap.receipt).toMatchObject({ readiness: "unready", effectiveSpec: emptyReviewEnvironmentSpec() })
		expect(overlap.receipt.gaps.at(-1)).toMatchObject({ kind: "invalid_environment_spec" })
		expect(overlap.worktree.readOnlyCachePaths).toEqual([])
		expect(overlap.worktree.env).not.toHaveProperty("FIXTURE_AUTH_TOKEN")

		const outside = join(root, "outside-private")
		mkdirSync(outside)
		symlinkSync(outside, join(worktree.cacheDir, "linked"), "dir")
		const traversed = await prepareReviewEnvironment(
			preparation(spec({ privateDirs: [{ id: "private", root: "cache", path: "linked/child" }] })),
		)
		expect(traversed.receipt).toMatchObject({ readiness: "unready", effectiveSpec: emptyReviewEnvironmentSpec() })
		expect(traversed.receipt.gaps.at(-1)?.note).toContain("symbolic link")
	})

	it("assembles safe defaults, spec values, then mandatory offline values and trusted PATH", () => {
		const assembled = assembleReviewEnvironment({
			baseEnv: { PATH: "/safe/bin", HTTP_PROXY: fixtureProxyUrl },
			worktreeEnv: { HOME: worktree.homeDir, TMPDIR: worktree.scratchDir, GOTOOLCHAIN: "local", GOFLAGS: "-mod=mod" },
			specEnv: {
				GOTOOLCHAIN: "auto",
				GOPROXY: "direct",
				GOFLAGS: "-mod=readonly",
				NPM_CONFIG_REGISTRY: "https://registry.example.invalid/",
				CUSTOM_VALUE: "from-spec",
			},
			toolchain: { id: "fixture", bin: ["/trusted/one", "/trusted/two"] },
		})
		expect(assembled).toMatchObject({
			PATH: "/trusted/one:/trusted/two:/safe/bin",
			GOTOOLCHAIN: "auto",
			GOPROXY: "off",
			GOFLAGS: "-mod=readonly",
			NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
			NPM_CONFIG_OFFLINE: "true",
			GIT_TERMINAL_PROMPT: "0",
			CUSTOM_VALUE: "from-spec",
		})
		expect(assembled).not.toHaveProperty("HTTP_PROXY")
		expect(Object.values(assembled).join("\n")).not.toContain("fixture-pass")
		expect(() =>
			assembleReviewEnvironment({
				baseEnv: {},
				worktreeEnv: {},
				specEnv: { OPENAI_API_KEY: "ordinary-openai-fixture" },
			}),
		).toThrow("credential-like")
	})

	it.each([
		{ name: "OPENAI_API_KEY", value: "ordinary-openai-fixture" },
		{ name: "AWS_ACCESS_KEY_ID", value: "ordinary-access-fixture" },
		{ name: "PRIVATE_KEY", value: "ordinary-private-fixture" },
		{ name: "SESSION_COOKIE", value: "ordinary-cookie-fixture" },
		{ name: "GITHUB_PAT", value: "ordinary-pat-fixture" },
		{ name: "DATABASE_URL", value: fixtureDsn },
		{ name: "ORDINARY_VALUE", value: fixtureProxyUrl },
	])("rejects sensitive profile env $name with typed isolation", ({ name, value }) => {
		const parsed = parseTrustedReviewEnvironment({ profiles: { default: { env: { [name]: value } } } })
		expect(parsed.gaps[0]).toMatchObject({ kind: "invalid_environment_settings" })
		expect(parsed.settings.profiles.default).toBeUndefined()
	})

	it("does not execute or persist rejected credential values in any receipt field", async () => {
		const openAiValue = "ordinary-openai-fixture"
		const values = [openAiValue, fixtureDsn]
		const execute = vi.fn()
		const result = await prepareReviewEnvironment(
			preparation(
				spec({
					env: { OPENAI_API_KEY: openAiValue, DATABASE_URL: fixtureDsn },
					setup: [command()],
				}),
				{ execute },
			),
		)
		expect(result.receipt.readiness).toBe("unready")
		expect(result.receipt.gaps.at(-1)).toMatchObject({ kind: "sensitive_environment" })
		expect(result.receipt.requestedSpec.env).toEqual({
			OPENAI_API_KEY: "<rejected-credential>",
			DATABASE_URL: "<rejected-credential>",
		})
		expect(result.receipt.effectiveSpec).toEqual(emptyReviewEnvironmentSpec())
		for (const value of values) expect(JSON.stringify(result.receipt)).not.toContain(value)
		expect(execute).not.toHaveBeenCalled()
	})

	const aggregateCapBytes = 64 * 1024
	const aggregateEntryCount = 30

	function expandedAggregateFixture() {
		const names = Array.from({ length: aggregateEntryCount }, (_, index) => `VALUE_${index}`)
		const bytes = (entries: Iterable<readonly [string, string]>) => {
			let total = 0
			for (const [name, value] of entries) total += Buffer.byteLength(name) + Buffer.byteLength(value)
			return total
		}
		const fixedBytes = bytes(names.map((name) => [name, ""] as const))
		const expandedValueBytes = Buffer.byteLength(cacheDir)
		const totalBytes = (repetitions: number) => fixedBytes + aggregateEntryCount * repetitions * expandedValueBytes
		let overflow = 1
		while (totalBytes(overflow) <= aggregateCapBytes) overflow++
		expect(overflow * expandedValueBytes).toBeLessThanOrEqual(4096)
		expect(totalBytes(overflow)).toBeGreaterThan(aggregateCapBytes)
		expect(totalBytes(overflow - 1)).toBeLessThanOrEqual(aggregateCapBytes)
		return { names, overflow, underflow: overflow - 1 }
	}

	it("revalidates expanded env value and aggregate size limits", async () => {
		const fixture = expandedAggregateFixture()
		for (const [name, env] of [
			["per-value", { EXPANDED: "${cache:shared}".repeat(200) }],
			[
				"aggregate",
				Object.fromEntries(fixture.names.map((name) => [name, "${cache:shared}".repeat(fixture.overflow)])),
			],
		] as const) {
			const result = await prepareReviewEnvironment(preparation(spec({ readOnlyCaches: ["shared"], env })))
			expect(result.receipt, name).toMatchObject({ readiness: "unready", effectiveSpec: emptyReviewEnvironmentSpec() })
			expect(result.receipt.gaps.at(-1)?.note, name).toContain("Expanded environment")
		}
	})

	it("keeps the adjacent expanded aggregate within its cap ready", async () => {
		const fixture = expandedAggregateFixture()
		const env = Object.fromEntries(fixture.names.map((name) => [name, "${cache:shared}".repeat(fixture.underflow)]))
		const result = await prepareReviewEnvironment(preparation(spec({ readOnlyCaches: ["shared"], env })))

		expect(result.receipt.readiness).toBe("ready")
	})

	it("keeps logical digests stable across random worktree and private paths", async () => {
		const prepare = async (worktreeId: string, elapsedMs: number) => {
			const selected = spec({
				readOnlyCaches: ["shared"],
				privateDirs: [{ id: "writable", root: "cache", path: "writable" }],
				env: {
					CACHE_VALUE: "${cache:shared}",
					PRIVATE_VALUE: "${private:writable}",
					WORKTREE_VALUE: "${worktree}",
					SCRATCH_VALUE: "${scratch}",
				},
				setup: [command()],
				probes: [probe("read-cache")],
			})
			return prepareReviewEnvironment(
				preparation(selected, {
					worktreeId,
					execute: vi.fn(async () => ({
						status: "passed" as const,
						exitCode: 0,
						elapsedMs,
						output: `${Math.random()}`,
					})),
				}),
			)
		}
		const first = await prepare("reviewer:head:spec", 1)
		const firstJson = JSON.stringify(first.receipt)
		const secondOptions = preparation(first.receipt.requestedSpec, { worktreeId: "reviewer:head:spec" })
		secondOptions.worktree = {
			...worktree,
			path: join(root, "different", "checkout"),
			scratchDir: join(root, "different", "scratch"),
			buildDir: join(root, "different", "build"),
			cacheDir: join(root, "different", "cache"),
			homeDir: join(root, "different", "home"),
		}
		for (const path of [
			secondOptions.worktree.path,
			secondOptions.worktree.scratchDir,
			secondOptions.worktree.buildDir,
			secondOptions.worktree.cacheDir,
			secondOptions.worktree.homeDir,
		])
			mkdirSync(path, { recursive: true })
		secondOptions.privateEnv = {
			HOME: secondOptions.worktree.homeDir,
			TMPDIR: secondOptions.worktree.scratchDir,
			KIMCHI_REVIEW_WORKTREE: secondOptions.worktree.path,
			KIMCHI_REVIEW_SCRATCH_DIR: secondOptions.worktree.scratchDir,
		}
		secondOptions.execute = vi.fn(async () => ({
			status: "passed" as const,
			exitCode: 0,
			elapsedMs: 999,
			output: "different",
		}))
		const second = await prepareReviewEnvironment(secondOptions)
		expect(second.receipt.requestedSpecDigest).toBe(first.receipt.requestedSpecDigest)
		expect(second.receipt.receiptDigest).toBe(first.receipt.receiptDigest)
		expect(JSON.stringify(second.receipt)).not.toBe(firstJson)
		expect(second.receipt.receiptDigest).toMatch(/^[a-f0-9]{64}$/)
		expect(first.worktree.env.CACHE_VALUE).toBe(cacheDir)
		expect(first.receipt.nonHermeticInputs).toContain(`cache:shared=${cacheDir}`)
	})

	it("runs setup then probes in the prepared environment and returns ready receipt records", async () => {
		const calls: string[] = []
		const observations: Array<{ env: Record<string, string>; caches: readonly string[] }> = []
		const execute = vi.fn(async (executedWorktree: ReviewWorktree, executed: { argv: string[] }) => {
			calls.push(executed.argv.at(-1) ?? "")
			observations.push({
				env: { ...executedWorktree.env },
				caches: [...(executedWorktree.readOnlyCachePaths ?? [])],
			})
			return { status: "passed" as const, exitCode: 0, elapsedMs: 3, output: "x".repeat(20_000) }
		})
		const result = await prepareReviewEnvironment(
			preparation(
				spec({
					readOnlyCaches: ["shared"],
					env: { CACHE_VALUE: "${cache:shared}" },
					setup: [command()],
					probes: [probe("verify")],
				}),
				{ execute },
			),
		)
		expect(calls).toEqual(["prepare", "probe"])
		expect(observations[0]?.env.CACHE_VALUE).toBe(cacheDir)
		expect(observations[0]?.env.TMPDIR).toBe(worktree.scratchDir)
		expect(observations[0]?.caches).toEqual([cacheDir])
		expect(result.receipt.readiness).toBe("ready")
		expect(result.receipt.setup[0]?.output.length).toBeLessThanOrEqual(8192)
		expect(result.receipt.probes[0]).toMatchObject({ id: "verify", status: "passed" })
		expect(result.receipt.receiptDigest).toMatch(/^[a-f0-9]{64}$/)
	})

	it.each([
		{ phase: "setup", required: false, readiness: "degraded" },
		{ phase: "setup", required: true, readiness: "unready" },
		{ phase: "probe", required: false, readiness: "degraded" },
		{ phase: "probe", required: true, readiness: "unready" },
	] as const)("resets a failed $phase step to a clean fallback ($readiness)", async ({
		phase,
		required,
		readiness,
	}) => {
		const selected =
			phase === "setup"
				? spec({ setup: [command(required)], probes: [probe("not-run")] })
				: spec({ setup: [command()], probes: [probe("failed-probe", required), probe("not-run")] })
		const resetToIsolated = vi.fn(async (_worktree: ReviewWorktree) => ({
			worktree: _worktree,
			privateEnv: {},
		}))
		const result = await prepareReviewEnvironment(
			preparation(selected, {
				execute: vi.fn(async (_worktree: ReviewWorktree, executed: { argv: string[] }) =>
					executed.argv.at(-1) === "prepare" && phase === "probe"
						? { status: "passed" as const, exitCode: 0, elapsedMs: 1, output: "ok" }
						: { status: "failed" as const, exitCode: 9, elapsedMs: 1, output: "failure" },
				),
				resetToIsolated,
			}),
		)
		expect(result.receipt.readiness).toBe(readiness)
		expect(result.receipt.effectiveSpec).toEqual(emptyReviewEnvironmentSpec())
		expect(result.receipt.gaps.at(-1)).toMatchObject({ kind: `${phase}_failed` })
		expect(result.receipt.probes.at(-1)?.status).toBe(required || phase === "setup" ? "skipped" : "skipped")
		expect(resetToIsolated).toHaveBeenCalledOnce()
	})

	it("records timeouts and aborts as gaps instead of throwing", async () => {
		const timeout = await prepareReviewEnvironment(
			preparation(spec({ setup: [command(false)] }), {
				execute: vi.fn(async () => ({
					status: "cancelled" as const,
					elapsedMs: 1000,
					output: "aborted",
					timedOut: true,
				})),
			}),
		)
		expect(timeout.receipt.setup[0]?.status).toBe("timeout")
		expect(timeout.receipt.readiness).toBe("degraded")

		const abort = new AbortController()
		abort.abort(new Error("stop"))
		const aborted = await prepareReviewEnvironment(preparation(spec({ setup: [command()] }), { signal: abort.signal }))
		expect(aborted.receipt.setup[0]?.status).toBe("cancelled")
		expect(aborted.receipt).toMatchObject({ readiness: "unready" })
		expect(aborted.receipt.gaps.at(-1)).toMatchObject({ kind: "environment_aborted" })
	})

	it("records portable preparation containment when no PID namespace is available", async () => {
		const result = await prepareReviewEnvironment(
			preparation(spec({ setup: [command()] }), {
				boundary: {
					kind: "bwrap",
					capabilities: {
						networkOff: true,
						filesystemConfinement: true,
						readOnlyMounts: true,
						preparationPidNamespace: false,
					},
				},
			}),
		)

		expect(result.receipt.readiness).toBe("ready")
		expect(result.receipt.setup[0]?.status).toBe("passed")
		expect(result.receipt.gaps).toContainEqual(
			expect.objectContaining({ kind: "preparation_containment", name: "bwrap" }),
		)
	})

	it("does not expose caches or run setup without attested boundary capabilities", async () => {
		const execute = vi.fn()
		for (const kind of ["unshare-net", "outer-sandbox"] as const) {
			const result = await prepareReviewEnvironment(
				preparation(spec({ readOnlyCaches: ["shared"], setup: [command(false)] }), {
					boundary: {
						kind,
						capabilities: {
							networkOff: kind === "unshare-net",
							filesystemConfinement: false,
							readOnlyMounts: false,
						},
					},
					execute,
				}),
			)
			expect(result.receipt.gaps.at(-1)).toMatchObject({ kind: "environment_unsupported", name: kind })
			expect(result.worktree.readOnlyCachePaths).toEqual([])
			expect(result.receipt.setup[0]?.status).toBe("skipped")
		}
		expect(execute).not.toHaveBeenCalled()
	})

	it("projects a bounded note from the actual receipt without raw setup output", async () => {
		const result = await prepareReviewEnvironment(
			preparation(
				spec({
					readOnlyCaches: ["shared"],
					privateDirs: [{ id: "private", root: "scratch", path: "tmp" }],
					setup: [command()],
				}),
			),
		)
		const receipt: ReviewEnvironmentReceipt = structuredClone(result.receipt)
		const setupRecord = receipt.setup[0]
		if (!setupRecord) throw new Error("expected the setup record fixture")
		setupRecord.output = "raw output must not appear"
		receipt.gaps.push({ kind: "bounded", name: "long", note: "x".repeat(REVIEW_ENVIRONMENT_PROMPT_LIMIT * 2) })
		const note = reviewEnvironmentPromptNote(receipt)
		expect(note).toContain(cacheDir)
		expect(note).toContain("private")
		expect(note).toContain("Do not hand-link or download dependencies")
		expect(note).not.toContain("raw output must not appear")
		expect(note.length).toBeLessThanOrEqual(REVIEW_ENVIRONMENT_PROMPT_LIMIT)
	})

	it("uses the real boundary fixture only as a typed test double", () => {
		expect(enforceable.kind).toBe("sandbox-exec")
	})
})
