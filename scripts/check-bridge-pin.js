#!/usr/bin/env node
/**
 * check-bridge-pin — fail when the kimchi-bridge library pin and the bundled
 * bridge release drift apart (reconcile-out-of-process plan, K1: "One schema
 * implementation": Kimchi's capture path and the shipped bridge bundle must
 * come from the same bridge commit).
 *
 * The library pin is the `@getkimchi/kimchi-bridge` spec in package.json
 * (`github:getkimchi/kimchi-bridge#<full-sha>`); the bundled release is the
 * `VERSION` pin in scripts/bundle-bridge.sh. The check resolves the release
 * tag's commit with `git ls-remote` and compares.
 *
 * Usage:
 *   node scripts/check-bridge-pin.js [--self-test]
 * Exit codes: 1 pin mismatch / not pinned / cannot verify (fails closed),
 *             2 usage or local I/O error.
 *
 * --self-test runs the fixture suite below (match, mismatch, development link,
 * unresolvable tag, network failure) without touching the network — the same
 * convention as check-acp-wire.mjs, because `vitest run --dir src` does not
 * crawl scripts/.
 */

import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const BRIDGE_REPO = "https://github.com/getkimchi/kimchi-bridge"
/** A stalled `git ls-remote` must fail closed within this bound, not hang the job. */
const LS_REMOTE_TIMEOUT_MS = 30_000

/** Read the bundled release VERSION from scripts/bundle-bridge.sh. */
export function parseBundledVersion(bundleScript) {
	const match = bundleScript.match(/^VERSION=(\S+)$/m)
	if (!match) return undefined
	const version = match[1]
	return version ? version : undefined
}

/**
 * The commit the package.json pin names. Only `github:getkimchi/kimchi-bridge#<full 40-hex sha>`
 * is a valid pin; anything else (link:, file:, a bare version, another host) is reported as
 * unpinned rather than guessed at.
 */
export function pinCommit(spec) {
	if (spec === undefined) return { error: "package.json has no @getkimchi/kimchi-bridge dependency" }
	if (spec.startsWith("link:") || spec.startsWith("file:"))
		return { development: true, location: spec.replace(/^(link|file):/, "") }
	const match = spec.match(/^github:getkimchi\/kimchi-bridge#([0-9a-f]+)$/)
	if (!match)
		return {
			error: `unsupported @getkimchi/kimchi-bridge spec "${spec}": pin the release commit as github:getkimchi/kimchi-bridge#<full-sha>`,
		}
	const sha = match[1]
	if (sha.length !== 40)
		return {
			error: `the bridge pin "${spec}" must be a full 40-hex commit sha, not a short revision`,
		}
	return { sha }
}

/** Resolve a release tag to its commit; undefined when the tag does not exist. */
export function resolveTagCommit(version, runLsRemote = lsRemote) {
	const ref = `refs/tags/${version}^{}`
	let output
	try {
		output = runLsRemote(ref)
	} catch (error) {
		return { error: `could not resolve tag ${version}: ${error.message}` }
	}
	const line = output
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l.length > 0)
	if (!line) return { error: `tag ${version} not found on ${BRIDGE_REPO}` }
	const [sha, listedRef] = line.split(/\s+/)
	if (!/^[0-9a-f]{40}$/.test(sha ?? "") || listedRef !== ref)
		return { error: `unexpected ls-remote output for ${ref}: ${line}` }
	return { sha }
}

/**
 * One `git ls-remote`. `git` and the timeout are injectable so the self-test
 * can drive the real execFileSync timeout against a hanging fake executable.
 */
function lsRemote(ref, { git = "git", timeoutMs = LS_REMOTE_TIMEOUT_MS } = {}) {
	return execFileSync(git, ["ls-remote", BRIDGE_REPO, ref], {
		encoding: "utf8",
		maxBuffer: 1024 * 1024,
		// Fail closed instead of stalling the whole CI job on a hung network call.
		timeout: timeoutMs,
	})
}

/**
 * The one decision this check makes. Returns { ok: true } or
 * { ok: false, reason } — reasons are printed verbatim by the CLI.
 */
export function evaluate({ packageJsonSpec, bundleScript, runLsRemote = lsRemote }) {
	const version = parseBundledVersion(bundleScript)
	if (!version) return { ok: false, reason: "scripts/bundle-bridge.sh has no VERSION pin" }
	const pin = pinCommit(packageJsonSpec)
	if (pin.error) return { ok: false, reason: pin.error }
	if (pin.development)
		return {
			ok: false,
			reason: `development link, not pinned: @getkimchi/kimchi-bridge points at a local checkout (${pin.location}); pin the release commit for ${version} with github:getkimchi/kimchi-bridge#<full-sha>`,
		}
	const tag = resolveTagCommit(version, runLsRemote)
	if (tag.error) return { ok: false, reason: tag.error }
	if (tag.sha !== pin.sha)
		return {
			ok: false,
			reason: `bridge pin mismatch: package.json pins ${pin.sha} but release ${version} is ${tag.sha}`,
		}
	return { ok: true, reason: `bridge pin matches release ${version} (${tag.sha})` }
}

function main() {
	const selfTest = process.argv.includes("--self-test")
	if (process.argv.length > 2 && !selfTest) usage()
	if (selfTest) return runSelfTest()
	let spec
	let packageJson
	try {
		packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"))
		spec = packageJson.dependencies?.["@getkimchi/kimchi-bridge"]
	} catch (error) {
		fatal(`could not read package.json: ${error.message}`, 2)
	}
	let bundleScript
	try {
		bundleScript = readFileSync(join(REPO_ROOT, "scripts", "bundle-bridge.sh"), "utf8")
	} catch (error) {
		fatal(`could not read scripts/bundle-bridge.sh: ${error.message}`, 2)
	}
	const result = evaluate({ packageJsonSpec: spec, bundleScript })
	if (result.ok) {
		console.log(`check-bridge-pin: ${result.reason}`)
		return 0
	}
	console.error(`check-bridge-pin: ${result.reason}`)
	return 1
}

function usage() {
	console.error("Usage: node scripts/check-bridge-pin.js [--self-test]")
	process.exit(2)
}

function fatal(message, code) {
	console.error(`check-bridge-pin: ${message}`)
	process.exit(code)
}

const BUNDLED = "VERSION=v0.1.0-rc.30\nSHA256=abc\n"
const PIN_A = "0123456789abcdef0123456789abcdef01234567"
const PIN_B = "fedcba9876543210fedcba9876543210fedcba98"

function runSelfTest() {
	const fixtures = [
		{
			name: "matching pin passes",
			given: { packageJsonSpec: `github:getkimchi/kimchi-bridge#${PIN_A}`, bundleScript: BUNDLED },
			lsRemote: () => `${PIN_A}\trefs/tags/v0.1.0-rc.30^{}\n`,
			expect: (r) => r.ok === true,
		},
		{
			name: "mismatched pin fails",
			given: { packageJsonSpec: `github:getkimchi/kimchi-bridge#${PIN_B}`, bundleScript: BUNDLED },
			lsRemote: () => `${PIN_A}\trefs/tags/v0.1.0-rc.30^{}\n`,
			expect: (r) => r.ok === false && r.reason.includes("mismatch") && r.reason.includes(PIN_A),
		},
		{
			name: "development link fails as not pinned",
			given: {
				packageJsonSpec: "link:../kimchi-bridge-k1pin",
				bundleScript: BUNDLED,
			},
			lsRemote: () => {
				throw new Error("must not hit the network for a link: spec")
			},
			expect: (r) => r.ok === false && r.reason.includes("development link, not pinned"),
		},
		{
			name: "file: spec fails as not pinned",
			given: { packageJsonSpec: "file:./vendor/bridge", bundleScript: BUNDLED },
			lsRemote: () => {
				throw new Error("must not hit the network for a file: spec")
			},
			expect: (r) => r.ok === false && r.reason.includes("development link, not pinned"),
		},
		{
			name: "network failure fails closed",
			given: {
				packageJsonSpec: `github:getkimchi/kimchi-bridge#${PIN_A}`,
				bundleScript: BUNDLED,
			},
			lsRemote: () => {
				throw new Error("network unreachable")
			},
			expect: (r) => r.ok === false && r.reason.includes("network unreachable"),
		},
		{
			name: "missing release tag fails",
			given: {
				packageJsonSpec: `github:getkimchi/kimchi-bridge#${PIN_A}`,
				bundleScript: BUNDLED,
			},
			lsRemote: () => "",
			expect: (r) => r.ok === false && r.reason.includes("not found"),
		},
		{
			name: "short sha pin fails",
			given: {
				packageJsonSpec: "github:getkimchi/kimchi-bridge#0123456",
				bundleScript: BUNDLED,
			},
			lsRemote: () => `${PIN_A}\trefs/tags/v0.1.0-rc.30^{}\n`,
			expect: (r) => r.ok === false && r.reason.includes("full 40-hex"),
		},
		{
			name: "registry spec fails as unsupported",
			given: { packageJsonSpec: "^0.1.0", bundleScript: BUNDLED },
			lsRemote: () => {
				throw new Error("must not hit the network for a registry spec")
			},
			expect: (r) => r.ok === false && r.reason.includes("unsupported"),
		},
		{
			name: "bundle script without VERSION fails",
			given: { packageJsonSpec: `github:getkimchi/kimchi-bridge#${PIN_A}`, bundleScript: "#!/bin/sh\n" },
			lsRemote: () => {
				throw new Error("must not hit the network without a bundled version")
			},
			expect: (r) => r.ok === false && r.reason.includes("no VERSION pin"),
		},
	]
	let failures = 0
	for (const fixture of fixtures) {
		const result = evaluate({ ...fixture.given, runLsRemote: fixture.lsRemote })
		if (!fixture.expect(result)) {
			failures++
			console.error(`check-bridge-pin --self-test: fixture "${fixture.name}" failed: ${JSON.stringify(result)}`)
		}
	}
	if (failures) {
		console.error(`check-bridge-pin --self-test: ${failures}/${fixtures.length} fixtures failed`)
		process.exit(1)
	}
	console.log(`check-bridge-pin --self-test: ${fixtures.length} fixtures OK`)
	if (!assertLsRemoteTimeoutFailsClosed()) process.exit(1)
	console.log("check-bridge-pin --self-test: ls-remote timeout fails closed within its bound")
	return 0
}

/**
 * A stalled `git ls-remote` must be killed within the timeout and fail closed,
 * not hang the CI job: drive the real default lsRemote (not an injected stub)
 * against a fake git that never answers.
 */
function assertLsRemoteTimeoutFailsClosed() {
	const dir = mkdtempSync(join(tmpdir(), "check-bridge-pin-timeout-"))
	const fakeGit = join(dir, "git")
	writeFileSync(fakeGit, "#!/bin/sh\nsleep 30\n", { mode: 0o755 })
	const timeoutMs = 500
	const startedAt = Date.now()
	try {
		const result = resolveTagCommit("v0.1.0-rc.30", (ref) => lsRemote(ref, { git: fakeGit, timeoutMs }))
		const elapsed = Date.now() - startedAt
		if (result.ok || !result.error || !/could not resolve tag/.test(result.error)) {
			console.error(`check-bridge-pin --self-test: ls-remote timeout did not fail closed: ${JSON.stringify(result)}`)
			return false
		}
		if (elapsed >= 10_000) {
			console.error(`check-bridge-pin --self-test: ls-remote timeout took ${elapsed}ms, not bounded`)
			return false
		}
		return true
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

process.exit(main())
