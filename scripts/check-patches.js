#!/usr/bin/env node
/**
 * Verifies pnpm.patchedDependencies stays in sync with the declared
 * @earendil-works/* versions in package.json.
 *
 * Dependabot bumps those versions, but the patchedDependencies keys and the
 * patch files under patches/ are version-pinned — a bump without a matching
 * patch update breaks `pnpm install` for everyone. This fails fast instead.
 */
import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const PI_MONO_PREFIX = "@earendil-works/"

/**
 * Pure check: given package.json and a patch-file-exists predicate, returns
 * human-readable error strings. Empty array means in sync.
 */
export function findPatchHealthcheckErrors(pkg, patchExists) {
	const deps = {
		...(pkg.dependencies || {}),
		...(pkg.devDependencies || {}),
	}
	const patched = pkg.pnpm?.patchedDependencies || {}
	const errors = []

	// Every pi-mono dependency needs a version-matched patch entry + patch file.
	for (const [name, version] of Object.entries(deps)) {
		if (!name.startsWith(PI_MONO_PREFIX)) continue
		const expectedKey = `${name}@${version}`
		const patchPath = patched[expectedKey]
		if (!patchPath) {
			const staleKey = Object.keys(patched).find((k) => k.startsWith(`${name}@`) && k !== expectedKey)
			errors.push(
				staleKey
					? `Version mismatch for ${name}: package.json says ${version}, but patchedDependencies still has ${staleKey}. Bump the patchedDependencies key and regenerate the patch file.`
					: `Missing patchedDependencies entry for ${name}@${version}. Add \`${expectedKey}\` to pnpm.patchedDependencies and regenerate the patch.`,
			)
			continue
		}
		if (!patchExists(patchPath)) {
			errors.push(
				`Patch file not found: ${patchPath} (referenced by ${expectedKey}). Run \`pnpm patch ${name}@${version}\` to regenerate.`,
			)
		}
	}

	// Reverse direction: every pi-mono patch entry must match a declared dep.
	for (const key of Object.keys(patched)) {
		if (!key.startsWith(PI_MONO_PREFIX)) continue
		const atIdx = key.lastIndexOf("@")
		const name = key.slice(0, atIdx)
		const version = key.slice(atIdx + 1)
		const declared = deps[name]
		if (!declared) {
			errors.push(
				`patchedDependencies references ${key}, but ${name} is not declared in dependencies/devDependencies. Remove the stale entry.`,
			)
		} else if (declared !== version) {
			errors.push(
				`Version mismatch for ${name}: package.json declares ${declared}, but patchedDependencies has ${version}.`,
			)
		}
	}

	return errors
}

function main() {
	const __dirname = dirname(fileURLToPath(import.meta.url))
	const root = resolve(__dirname, "..")
	const pkgPath = resolve(root, "package.json")
	const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))

	const errors = findPatchHealthcheckErrors(pkg, (patchPath) => existsSync(resolve(root, patchPath)))

	if (errors.length > 0) {
		console.error("❌ Patch healthcheck failed:\n")
		for (const e of errors) console.error(`  - ${e}`)
		console.error(
			"\nTo fix: bump the patchedDependencies key in package.json to match the new version, then run `pnpm patch <name>@<version>` to regenerate the patch file (see the patches/ README / AGENTS.md for the patch workflow).",
		)
		process.exit(1)
	}

	console.error("✅ Patch files are in sync with @earendil-works/* dependencies.")
}

import.meta.url === `file://${process.argv[1]}` && main()
