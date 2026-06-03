import { homedir } from "node:os"
import { join } from "node:path"

export const SUPERPOWERS_VERSION = "v5.1.0"
export const SUPERPOWERS_REPO = "obra/superpowers"

/**
 * Relative-to-home skill path, consistent with ALWAYS_SHOWN_SKILL_PATHS in config.ts.
 * Expanded to absolute by expandSkillPaths() at runtime.
 */
export const SUPERPOWERS_SKILL_PATH = join(".config", "kimchi", "vendor", "superpowers", "skills")

/** Absolute path to the vendor root (used by the installer for fs operations). */
export function getSuperpowersVendorDir(): string {
	return join(homedir(), ".config", "kimchi", "vendor", "superpowers")
}

export function getSuperpowersTarballUrl(): string {
	return `https://github.com/${SUPERPOWERS_REPO}/archive/refs/tags/${SUPERPOWERS_VERSION}.tar.gz`
}
