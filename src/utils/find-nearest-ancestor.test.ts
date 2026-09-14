import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { findNearestAncestorPath } from "./find-nearest-ancestor.js"

let root: string

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "kimchi-find-ancestor-"))
})

afterEach(() => {
	rmSync(root, { recursive: true, force: true })
})

describe("findNearestAncestorPath", () => {
	it("finds the path in cwd itself", () => {
		writeFileSync(join(root, "marker.txt"), "")
		expect(findNearestAncestorPath(root, "marker.txt")).toBe(join(root, "marker.txt"))
	})

	it("walks up to ancestors when missing in cwd (monorepo subdirectory)", () => {
		writeFileSync(join(root, "conf.json"), "")
		const deep = join(root, "packages", "app", "src")
		mkdirSync(deep, { recursive: true })
		expect(findNearestAncestorPath(deep, "conf.json")).toBe(join(root, "conf.json"))
	})

	it("prefers the nearest ancestor over a farther one", () => {
		writeFileSync(join(root, "conf.json"), "")
		const mid = join(root, "packages", "app")
		mkdirSync(mid, { recursive: true })
		writeFileSync(join(mid, "conf.json"), "")
		expect(findNearestAncestorPath(join(mid, "src"), "conf.json")).toBe(join(mid, "conf.json"))
	})

	it("returns undefined when nothing matches up to the filesystem root", () => {
		expect(findNearestAncestorPath(root, "definitely-missing-8f3b2c71.json")).toBeUndefined()
	})
})
