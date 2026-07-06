/**
 * Type declarations for scripts/check-patches.js — a standalone Node script
 * (no build step) whose exported `findPatchHealthcheckErrors` is exercised by
 * check-patches.test.ts.
 */

type PackageJson = {
	dependencies?: Record<string, string>
	devDependencies?: Record<string, string>
	pnpm?: { patchedDependencies?: Record<string, string> }
}

export declare const PI_MONO_PREFIX: "@earendil-works/"

export declare function findPatchHealthcheckErrors(
	pkg: PackageJson,
	patchExists: (patchPath: string) => boolean,
): string[]
