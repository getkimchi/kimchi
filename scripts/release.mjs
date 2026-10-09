// Release preparation: stamp CHANGELOG.md, bump package.json, commit on the
// default branch, and tag the release commit (see docs/releases.md).
//
// Adapted from https://github.com/earendil-works/pi (Apache-2.0).
//
// Usage:
//   node scripts/release.mjs <x.y.z> [--dry-run]
//
// Flow (non-dry-run, must start on the default branch with a clean tree):
//   1. Validate: semver version, run from the repo root, clean working tree,
//      current branch == default branch, CHANGELOG.md has "## [Unreleased]"
//      with content ("nothing to release" otherwise), tag v<x.y.z> free.
//   2. Stamp "[Unreleased]" -> "[X.Y.Z] - YYYY-MM-DD", bump package.json,
//      commit "Release vX.Y.Z" (NO [skip ci]: this commit is what the tag
//      points at, and a skip keyword there would suppress the tag-triggered
//      Release workflow), tag v<x.y.z> on that commit.
//   3. Reseed a fresh "## [Unreleased]" section, commit
//      "Start next cycle [skip ci]" (suppresses ci.yml on the master push;
//      this commit is never tagged).
//   4. Print instructions: push the default branch and the tag (the script
//      itself never pushes). The CI "Release prepare" workflow
//      (.github/workflows/release-prep.yml) automates the whole flow; the
//      [skip ci] marker on the Start next cycle commit keeps the pushed
//      master commits from re-triggering ci.yml.
//
// --dry-run computes and prints everything without touching files or git.

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import process from "node:process"
import { pathToFileURL } from "node:url"

const UNRELEASED_HEADER = "## [Unreleased]"
const DEFAULT_BRANCH_FALLBACK = "master"

const SEMVER_RE = /^\d+\.\d+\.\d+$/

function fail(message) {
	throw new Error(message)
}

function git(args, cwd) {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trimEnd()
}

function todayStamp() {
	const now = new Date()
	const pad = (value) => String(value).padStart(2, "0")
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export function parseReleaseArgs(argv) {
	let version
	let dryRun = false
	for (const arg of argv) {
		if (arg === "--dry-run") {
			dryRun = true
		} else if (arg.startsWith("--")) {
			fail(`Unknown option: ${arg}`)
		} else if (version === undefined) {
			version = arg
		} else {
			fail(`Unexpected extra argument: ${arg}`)
		}
	}
	return { dryRun, version }
}

// Split the changelog into: preamble (before Unreleased), the Unreleased body,
// and the rest (previously released sections).
function splitChangelog(content) {
	const lines = content.split("\n")
	const unreleasedIndex = lines.indexOf(UNRELEASED_HEADER)
	if (unreleasedIndex === -1) {
		fail(`CHANGELOG.md has no "${UNRELEASED_HEADER}" section. Nothing to stamp.`)
	}
	const nextSectionIndex = lines.findIndex((line, index) => index > unreleasedIndex && line.startsWith("## "))
	const unreleasedBody = lines
		.slice(unreleasedIndex + 1, nextSectionIndex === -1 ? lines.length : nextSectionIndex)
		.join("\n")
	const rest = nextSectionIndex === -1 ? "" : lines.slice(nextSectionIndex).join("\n")
	const preamble = lines.slice(0, unreleasedIndex).join("\n")
	return { preamble, rest, unreleasedBody }
}

function assertValidVersion(version) {
	if (version === undefined) {
		fail("Usage: node scripts/release.mjs <x.y.z> [--dry-run]")
	}
	if (!SEMVER_RE.test(version)) {
		fail(`Invalid semver version: "${version}" (expected x.y.z)`)
	}
}

function assertRepoRoot(cwd) {
	if (!existsSync(path.join(cwd, "package.json")) || !existsSync(path.join(cwd, "CHANGELOG.md"))) {
		fail("Run this script from the repository root (package.json and CHANGELOG.md not found).")
	}
}

function assertCleanTree(cwd) {
	const status = git(["status", "--porcelain"], cwd)
	if (status !== "") {
		fail(`Working tree is not clean:\n${status}\nCommit or stash your changes before releasing.`)
	}
}

function defaultBranch(cwd) {
	try {
		const ref = git(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd)
		return ref.replace(/^origin\//, "")
	} catch {
		return DEFAULT_BRANCH_FALLBACK
	}
}

function assertOnDefaultBranch(cwd) {
	const current = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd)
	const expected = defaultBranch(cwd)
	if (current !== expected) {
		fail(`Releases run on the default branch "${expected}", but HEAD is on "${current}".`)
	}
}

function assertTagFree(tag, cwd) {
	try {
		git(["rev-parse", "-q", "--verify", `refs/tags/${tag}`], cwd)
		fail(`Tag ${tag} already exists.`)
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Tag ")) {
			throw error
		}
	}
}

function bumpPackageVersion(cwd, version) {
	const packageJsonPath = path.join(cwd, "package.json")
	const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"))
	const previous = pkg.version
	pkg.version = version
	writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, "\t")}\n`)
	return previous
}

// Compute the stamped (released) changelog content and the reseeded content
// that follows the tag commit.
function computeChangelogMutation(changelogContent, version, dateStamp) {
	const { preamble, rest, unreleasedBody } = splitChangelog(changelogContent)
	const content = unreleasedBody.trim()
	if (content === "") {
		fail('Nothing to release: the "## [Unreleased]" section has no entries.')
	}
	const versionSection = `## [${version}] - ${dateStamp}\n\n${content}\n`
	const stamped = `${preamble}\n${versionSection}\n${rest}`.replace(/\n*$/, "\n")
	const reseeded = `${preamble}\n${UNRELEASED_HEADER}\n\n${versionSection}${rest}`.replace(/\n*$/, "\n")
	return { releasedBody: content, reseeded, stamped }
}

export function runRelease(version, { cwd = process.cwd(), dryRun = false } = {}) {
	assertValidVersion(version)
	assertRepoRoot(cwd)

	const tag = `v${version}`
	const changelogPath = path.join(cwd, "CHANGELOG.md")
	const changelogContent = readFileSync(changelogPath, "utf-8")
	const pkg = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf-8"))
	const dateStamp = todayStamp()

	// Mutation guards. A dry run never mutates, so hard tree/branch checks are
	// downgraded to warnings there.
	if (dryRun) {
		const status = git(["status", "--porcelain"], cwd)
		if (status !== "") {
			console.warn("Warning: working tree is not clean (dry run ignores this).")
		}
		const current = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd)
		if (current !== defaultBranch(cwd)) {
			console.warn(`Warning: HEAD is on "${current}", not the default branch (dry run ignores this).`)
		}
	} else {
		assertCleanTree(cwd)
		assertOnDefaultBranch(cwd)
	}

	const mutation = computeChangelogMutation(changelogContent, version, dateStamp)
	const previousVersion = pkg.version

	if (dryRun) {
		console.log(`Dry run for release ${version} (no changes written):\n`)
		console.log("CHANGELOG.md would become:\n")
		console.log(mutation.reseeded)
		console.log(`package.json: version ${previousVersion} -> ${version}`)
		console.log(
			`\nThen: commit "Release ${tag}", tag ${tag}, reseed [Unreleased], commit "Start next cycle [skip ci]".`,
		)
		return { dryRun: true, tag }
	}

	assertTagFree(tag, cwd)

	writeFileSync(changelogPath, mutation.stamped)
	bumpPackageVersion(cwd, version)
	git(["add", "CHANGELOG.md", "package.json"], cwd)
	git(["commit", "-m", `Release ${tag}`], cwd)
	git(["tag", tag], cwd)

	writeFileSync(changelogPath, mutation.reseeded)
	git(["add", "CHANGELOG.md"], cwd)
	git(["commit", "-m", "Start next cycle [skip ci]"], cwd)

	console.log(`Released ${version}: stamped CHANGELOG.md, bumped package.json ${previousVersion} -> ${version}.`)
	console.log(
		`Created commits "Release ${tag}" (tagged ${tag}) and "Start next cycle [skip ci]" on ${defaultBranch(cwd)} (fresh [Unreleased] reseeded on top).`,
	)
	console.log("\nNext steps:")
	console.log(`  git push origin ${defaultBranch(cwd)}`)
	console.log(`  git push origin ${tag}   # points at the "Release ${tag}" commit`)
	console.log("The tag push triggers the release workflow (see docs/releases.md).")
	console.log('The CI "Release prepare" workflow (.github/workflows/release-prep.yml) automates this whole flow.')
	return { dryRun: false, releasedBody: mutation.releasedBody, tag }
}

function main() {
	let parsed
	try {
		parsed = parseReleaseArgs(process.argv.slice(2))
		runRelease(parsed.version, { dryRun: parsed.dryRun })
	} catch (error) {
		console.error(error instanceof Error ? error.message : error)
		process.exit(1)
	}
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main()
}
