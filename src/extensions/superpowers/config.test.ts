import { homedir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
	SUPERPOWERS_REPO,
	SUPERPOWERS_SKILL_PATH,
	SUPERPOWERS_VERSION,
	getSuperpowersTarballUrl,
	getSuperpowersVendorDir,
} from "./config.js"

describe("superpowers config", () => {
	it("pins a semver version", () => {
		expect(SUPERPOWERS_VERSION).toMatch(/^v\d+\.\d+\.\d+$/)
	})

	it("SUPERPOWERS_SKILL_PATH is relative to home (no leading slash)", () => {
		expect(SUPERPOWERS_SKILL_PATH).not.toMatch(/^\//)
		expect(SUPERPOWERS_SKILL_PATH).toContain(join(".config", "kimchi", "vendor", "superpowers", "skills"))
	})

	it("getSuperpowersVendorDir returns absolute path under home", () => {
		const dir = getSuperpowersVendorDir()
		expect(dir).toBe(join(homedir(), ".config", "kimchi", "vendor", "superpowers"))
	})

	it("tarball URL contains repo and version", () => {
		const url = getSuperpowersTarballUrl()
		expect(url).toBe(`https://github.com/obra/superpowers/archive/refs/tags/${SUPERPOWERS_VERSION}.tar.gz`)
	})

	it("SUPERPOWERS_REPO is obra/superpowers", () => {
		expect(SUPERPOWERS_REPO).toBe("obra/superpowers")
	})
})
