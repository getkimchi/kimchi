// Tests for scripts/release.mjs (run via: node --test scripts/)
//
// Each test works inside its own temporary git repository (git init + a
// scaffold CHANGELOG.md and package.json), so nothing outside the temp dir is
// mutated.

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import { runRelease } from "./release.mjs"

function git(dir, ...args) {
	return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trimEnd()
}

function commitAll(dir, message) {
	git(dir, "add", "-A")
	git(dir, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", message)
}

function makeTempRepo() {
	const dir = mkdtempSync(path.join(tmpdir(), "release-test-"))
	git(dir, "init", "-b", "master")
	git(dir, "config", "user.name", "test")
	git(dir, "config", "user.email", "test@example.com")
	writeFileSync(
		path.join(dir, "CHANGELOG.md"),
		`# Changelog

All notable user-facing changes.

## [Unreleased]

### Added

- New folder browser.
`,
	)
	writeFileSync(
		path.join(dir, "package.json"),
		`${JSON.stringify({ name: "fixture", version: "0.1.0" }, null, "\t")}\n`,
	)
	commitAll(dir, "initial")
	return dir
}

function todayStamp() {
	const now = new Date()
	const pad = (value) => String(value).padStart(2, "0")
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

test("release stamps the changelog, bumps the version, commits, tags, and reseeds [Unreleased]", () => {
	const dir = makeTempRepo()
	try {
		const result = runRelease("1.2.3", { cwd: dir })
		assert.equal(result.tag, "v1.2.3")

		const changelog = readFileSync(path.join(dir, "CHANGELOG.md"), "utf-8")
		assert.ok(changelog.includes("## [Unreleased]"), "fresh [Unreleased] section seeded")
		assert.ok(!changelog.includes("<!--"), "no HTML comment scaffold in output")
		assert.ok(changelog.includes(`## [1.2.3] - ${todayStamp()}`), "versioned section stamped with today's date")
		assert.ok(changelog.includes("- New folder browser."), "release body preserved")
		assert.ok(changelog.indexOf("## [Unreleased]") < changelog.indexOf("## [1.2.3]"), "Unreleased stays on top")
		assert.ok(
			!changelog.includes(`## [1.2.3] - ${todayStamp()}\n\n<!--`),
			"scaffold comment not stamped into the release section",
		)

		const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf-8"))
		assert.equal(pkg.version, "1.2.3")

		const log = git(dir, "log", "--format=%s")
		assert.ok(log.includes("Release v1.2.3 [skip ci]"))
		assert.ok(log.includes("Start next cycle [skip ci]"))
		assert.deepEqual(git(dir, "tag"), "v1.2.3")

		// The tag points at the release commit (stamped changelog, bumped
		// version), not at the reseed commit that follows it.
		const taggedChangelog = git(dir, "show", "v1.2.3:CHANGELOG.md")
		assert.ok(!taggedChangelog.includes("## [Unreleased]"), "tagged tree has the stamped changelog")
		assert.ok(taggedChangelog.includes("## [1.2.3]"))
		const taggedPkg = JSON.parse(git(dir, "show", "v1.2.3:package.json"))
		assert.equal(taggedPkg.version, "1.2.3")
		assert.equal(git(dir, "rev-parse", "v1.2.3^{commit}"), git(dir, "rev-parse", "HEAD^"))

		// The tree stays clean afterwards, so the next release can run.
		assert.equal(git(dir, "status", "--porcelain"), "")
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

test("release refuses to run on a dirty working tree", () => {
	const dir = makeTempRepo()
	try {
		writeFileSync(path.join(dir, "uncommitted.txt"), "dirty")
		assert.throws(() => runRelease("1.2.3", { cwd: dir }), /not clean/)
		assert.equal(git(dir, "log", "--oneline", "--format=%s"), "initial")
		assert.equal(git(dir, "tag"), "")
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

test("release refuses to run when the tag already exists", () => {
	const dir = makeTempRepo()
	try {
		git(dir, "tag", "v1.2.3")
		assert.throws(() => runRelease("1.2.3", { cwd: dir }), /already exists/)
		assert.equal(git(dir, "log", "--oneline", "--format=%s"), "initial")
		// Refusal must happen before any file mutation.
		assert.ok(readFileSync(path.join(dir, "CHANGELOG.md"), "utf-8").includes("## [Unreleased]"))
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

test("release refuses when there is nothing to release", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "release-test-"))
	try {
		git(dir, "init", "-b", "master")
		git(dir, "config", "user.name", "test")
		git(dir, "config", "user.email", "test@example.com")
		writeFileSync(
			path.join(dir, "CHANGELOG.md"),
			`# Changelog

## [Unreleased]
`,
		)
		writeFileSync(
			path.join(dir, "package.json"),
			`${JSON.stringify({ name: "fixture", version: "0.1.0" }, null, "\t")}\n`,
		)
		commitAll(dir, "initial")
		assert.throws(() => runRelease("1.2.3", { cwd: dir }), /Nothing to release/)
		assert.equal(git(dir, "log", "--oneline", "--format=%s"), "initial")
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

test("release refuses a non-semver version", () => {
	const dir = makeTempRepo()
	try {
		assert.throws(() => runRelease("1.2", { cwd: dir }), /Invalid semver/)
		assert.throws(() => runRelease(undefined, { cwd: dir }), /Usage/)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

test("release refuses to run off the default branch", () => {
	const dir = makeTempRepo()
	try {
		git(dir, "checkout", "-b", "feature-branch")
		assert.throws(() => runRelease("1.2.3", { cwd: dir }), /default branch/)
		assert.equal(git(dir, "log", "--oneline", "--format=%s"), "initial")
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

test("dry run prints a preview and mutates nothing", () => {
	const dir = makeTempRepo()
	try {
		const beforeChangelog = readFileSync(path.join(dir, "CHANGELOG.md"), "utf-8")
		const beforePkg = readFileSync(path.join(dir, "package.json"), "utf-8")

		const result = runRelease("1.2.3", { cwd: dir, dryRun: true })
		assert.equal(result.dryRun, true)

		assert.equal(readFileSync(path.join(dir, "CHANGELOG.md"), "utf-8"), beforeChangelog)
		assert.equal(readFileSync(path.join(dir, "package.json"), "utf-8"), beforePkg)
		assert.equal(git(dir, "log", "--oneline", "--format=%s"), "initial", "no commits created")
		assert.equal(git(dir, "tag"), "", "no tag created")
		assert.equal(git(dir, "status", "--porcelain"), "", "no files modified")

		// A dry run on a dirty tree only warns; it must still not mutate.
		writeFileSync(path.join(dir, "uncommitted.txt"), "dirty")
		assert.doesNotThrow(() => runRelease("1.2.3", { cwd: dir, dryRun: true }))
		assert.equal(git(dir, "log", "--oneline", "--format=%s"), "initial")
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

test("release preserves sections older than [Unreleased]", () => {
	const dir = makeTempRepo()
	try {
		writeFileSync(
			path.join(dir, "CHANGELOG.md"),
			`# Changelog

## [Unreleased]

- Fresh fix.

## [0.1.0] - 2026-01-01

- Initial release.
`,
		)
		commitAll(dir, "add older section")
		runRelease("1.0.0", { cwd: dir })
		const changelog = readFileSync(path.join(dir, "CHANGELOG.md"), "utf-8")
		assert.ok(changelog.includes("## [0.1.0] - 2026-01-01"))
		assert.ok(changelog.includes("- Initial release."))
		assert.ok(changelog.indexOf("## [1.0.0]") < changelog.indexOf("## [0.1.0]"), "new section above older ones")
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})
