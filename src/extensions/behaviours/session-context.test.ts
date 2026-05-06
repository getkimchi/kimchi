import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	type ResolverIO,
	collectProbes,
	parseRemoteHost,
	resolveSessionContext,
	walkAndMatch,
} from "./session-context.js"
import { path, all, any, cli, gitRemote } from "./triggers.js"

describe("parseRemoteHost", () => {
	const cases: Array<{ url: string; expected: string | undefined }> = [
		{ url: "git@github.com:owner/repo.git", expected: "github.com" },
		{ url: "git@gitlab.com:group/sub/repo.git", expected: "gitlab.com" },
		{ url: "https://github.com/owner/repo.git", expected: "github.com" },
		{ url: "https://user:token@gitlab.com/owner/repo", expected: "gitlab.com" },
		{ url: "ssh://git@github.com/owner/repo.git", expected: "github.com" },
		{ url: "", expected: undefined },
		{ url: "not-a-url", expected: undefined },
	]
	for (const { url, expected } of cases) {
		it(`parses ${JSON.stringify(url)}`, () => {
			expect(parseRemoteHost(url)).toBe(expected)
		})
	}
})

describe("walkAndMatch", () => {
	let cwd: string

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "kimchi-walk-"))
	})

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true })
	})

	function touch(rel: string): void {
		const abs = join(cwd, rel)
		mkdirSync(join(abs, ".."), { recursive: true })
		writeFileSync(abs, "")
	}

	it("matches a file at depth 1", () => {
		touch("setup.py")
		const matches = walkAndMatch(cwd, new Set(["**/*.py"]), 3)
		expect([...matches]).toEqual(["**/*.py"])
	})

	it("matches a file at depth 2", () => {
		touch("src/app.py")
		const matches = walkAndMatch(cwd, new Set(["**/*.py"]), 3)
		expect([...matches]).toEqual(["**/*.py"])
	})

	it("matches a file at depth 3", () => {
		touch("src/pkg/mod.py")
		const matches = walkAndMatch(cwd, new Set(["**/*.py"]), 3)
		expect([...matches]).toEqual(["**/*.py"])
	})

	it("does not match a file buried at depth 4", () => {
		touch("src/pkg/deep/mod.py")
		const matches = walkAndMatch(cwd, new Set(["**/*.py"]), 3)
		expect(matches.size).toBe(0)
	})

	it("returns empty when no file matches", () => {
		touch("README.md")
		touch("src/index.ts")
		const matches = walkAndMatch(cwd, new Set(["**/*.py"]), 3)
		expect(matches.size).toBe(0)
	})

	it("ignores files inside the standard ignore list", () => {
		touch("node_modules/some-pkg/index.py")
		touch(".git/hooks/pre-commit.py")
		touch("dist/bundle.py")
		touch("__pycache__/x.py")
		const matches = walkAndMatch(cwd, new Set(["**/*.py"]), 3)
		expect(matches.size).toBe(0)
	})

	it("matches multiple distinct globs in a single walk", () => {
		touch("pyproject.toml")
		touch("Cargo.toml")
		const matches = walkAndMatch(cwd, new Set(["pyproject.toml", "Cargo.toml"]), 3)
		expect(matches.has("pyproject.toml")).toBe(true)
		expect(matches.has("Cargo.toml")).toBe(true)
	})

	it("returns empty when the cwd does not exist", () => {
		const missing = join(cwd, "nope")
		const matches = walkAndMatch(missing, new Set(["**/*"]), 3)
		expect(matches.size).toBe(0)
	})
})

describe("collectProbes", () => {
	it("flattens nested any/all combinators into leaf probes", () => {
		const probe = any(cli("gh"), all(gitRemote("github.com"), path("**/*.py")))
		const probes = collectProbes([probe.__spec])
		expect([...probes.cliCommands]).toEqual(["gh"])
		expect(probes.needGitRemote).toBe(true)
		expect([...probes.pathGlobs]).toEqual(["**/*.py"])
	})

	it("deduplicates probes shared across behaviours", () => {
		const a = any(cli("gh"))
		const b = any(cli("gh"), cli("glab"))
		const probes = collectProbes([a.__spec, b.__spec])
		expect([...probes.cliCommands].sort()).toEqual(["gh", "glab"])
	})

	it("never flags gitRemote when no behaviour declares it", () => {
		const probes = collectProbes([cli("gh").__spec])
		expect(probes.needGitRemote).toBe(false)
	})
})

describe("resolveSessionContext", () => {
	function fakeIO(opts: {
		clis?: ReadonlySet<string>
		gitRemoteHost?: string | undefined
		inGitRepo?: boolean
		paths?: ReadonlySet<string>
	}): ResolverIO {
		const clis = opts.clis ?? new Set<string>()
		const paths = opts.paths ?? new Set<string>()
		return {
			hasCli: (name) => clis.has(name),
			readGitRemoteHost: () => opts.gitRemoteHost,
			isGitRepo: () => opts.inGitRepo ?? false,
			walkPaths: (_cwd, globs) => {
				const out = new Set<string>()
				for (const g of globs) if (paths.has(g)) out.add(g)
				return out
			},
		}
	}

	it("flags only present CLIs", () => {
		const probe = any(cli("gh"), cli("glab"))
		const ctx = resolveSessionContext([probe.__spec], "/x", fakeIO({ clis: new Set(["gh"]) }))
		expect([...ctx.cliPresent]).toEqual(["gh"])
		expect(probe(ctx)).toBe(true)
	})

	it("returns undefined gitRemoteHost when no remote is configured", () => {
		const probe = gitRemote("github.com")
		const ctx = resolveSessionContext([probe.__spec], "/x", fakeIO({ gitRemoteHost: undefined }))
		expect(ctx.gitRemoteHost).toBeUndefined()
		expect(probe(ctx)).toBe(false)
	})

	it("matches a github remote", () => {
		const probe = gitRemote("github.com")
		const ctx = resolveSessionContext([probe.__spec], "/x", fakeIO({ gitRemoteHost: "github.com" }))
		expect(probe(ctx)).toBe(true)
	})

	it("does not match a gitlab remote when probing for github", () => {
		const probe = gitRemote("github.com")
		const ctx = resolveSessionContext([probe.__spec], "/x", fakeIO({ gitRemoteHost: "gitlab.com" }))
		expect(probe(ctx)).toBe(false)
	})

	it("skips the git probe entirely when no behaviour declares one", () => {
		let called = false
		const ctx = resolveSessionContext([cli("gh").__spec], "/x", {
			hasCli: () => false,
			readGitRemoteHost: () => {
				called = true
				return "github.com"
			},
			isGitRepo: () => false,
			walkPaths: () => new Set(),
		})
		expect(called).toBe(false)
		expect(ctx.gitRemoteHost).toBeUndefined()
	})

	it("propagates path matches into the SessionContext", () => {
		const probe = path("**/*.py")
		const ctx = resolveSessionContext([probe.__spec], "/x", fakeIO({ paths: new Set(["**/*.py"]) }))
		expect(probe(ctx)).toBe(true)
	})
})
