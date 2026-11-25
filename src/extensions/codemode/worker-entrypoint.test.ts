/**
 * Contract test for the codemode sandbox worker in the compiled binary.
 *
 * pi's `getCodemodeWorkerSpecifier()` (dist/config.js) returns the
 * source-relative string "./src/extensions/codemode/worker.ts" when running
 * inside a Bun-compiled executable, and Bun resolves `new Worker(...)` in
 * compiled binaries by that build-relative string path. pi's own
 * `build:binary` therefore passes its src/extensions/codemode/worker.ts as an
 * extra `bun build --compile` entrypoint so the path exists in $bunfs.
 *
 * kimchi's build passed a single entrypoint, so the path was never embedded
 * and every codemode call failed with "Cannot find module
 * './src/extensions/codemode/worker.ts'" — the model fell back to direct tool
 * calls. The fix mirrors pi's recipe: a shim at
 * src/extensions/codemode/worker.ts (this directory), passed to
 * scripts/compile-binary.js alongside src/binary-entry.ts.
 *
 * If this test fails after a pi pin bump, check whether upstream changed the
 * bun-binary worker specifier in dist/config.js or moved the worker entry.
 */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

function read(path: string): string {
	return readFileSync(new URL(path, import.meta.url), "utf8")
}

function piDist(path: string): string {
	return read(`../../../node_modules/@earendil-works/pi-coding-agent/dist/${path}`)
}

describe("build: codemode worker entrypoint", () => {
	it("pi resolves the bun-binary worker to the source-relative path", () => {
		const config = piDist("config.js")
		expect(config).toContain('if (runtime === "bun-binary")')
		expect(config).toContain('return "./src/extensions/codemode/worker.ts"')
	})

	it("pi's own binary build embeds the worker as an entrypoint", () => {
		const scripts = JSON.parse(read("../../../node_modules/@earendil-works/pi-coding-agent/package.json")).scripts
		expect(scripts["build:binary"]).toContain("./src/extensions/codemode/worker.ts")
	})

	it("kimchi's shim mirrors pi's worker entry", () => {
		// pi's compiled worker is a bare re-export of pi-codemode's worker module.
		expect(piDist("extensions/codemode/worker.js")).toContain('import "@earendil-works/pi-codemode/worker"')
		expect(read("./worker.ts")).toContain('import "@earendil-works/pi-codemode/worker"')
	})

	it("the bun build passes the worker shim with its ./-prefixed path", () => {
		// Bun keys compiled-in entrypoints by the path string as given. pi spawns
		// new Worker("./src/extensions/codemode/worker.ts"); a bare "src/..."
		// arg gets the common-root (src/) prefix stripped in $bunfs and the spawn
		// fails with "Cannot find module" in the compiled binary.
		const build = read("../../../scripts/build-binary.js")
		expect(build).toContain("compile-binary.js src/binary-entry.ts ./src/extensions/codemode/worker.ts")
	})

	it("compile-binary accepts more than one entrypoint", () => {
		const compile = read("../../../scripts/compile-binary.js")
		expect(compile).not.toContain("exactly one entrypoint")
		expect(compile).toContain("entrypoints: positionals")
	})
})
