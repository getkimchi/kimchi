// Tests for scripts/release-notes.mjs (run via: node --test scripts/)

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import {
	extractReleaseNotes,
	extractSection,
	normalizeChangelogLinks,
	normalizeChangelogLinkTarget,
} from "./release-notes.mjs"

const SCRIPT = path.join(import.meta.dirname, "release-notes.mjs")

const MULTI_SECTION_CHANGELOG = `# Changelog

All notable user-facing changes.

## [Unreleased]

- Not released yet.

## [1.2.3] - 2026-09-17

### Added

- Auto-model default. See [the docs](docs/auto-model.md).
- Folder browser: [browse](src/tui/folder/).

### Fixed

- Crash on startup. Details in [README](README.md#install) and [docs](https://example.com/guide).

## [1.2.2] - 2026-08-01

- Older release.
`

test("extractSection returns the body of the requested version section", () => {
	const body = extractSection(MULTI_SECTION_CHANGELOG, "1.2.3")
	assert.ok(body.includes("### Added"), "should include section content")
	assert.ok(body.includes("Auto-model default"))
	assert.ok(!body.includes("Older release"), "must stop at the next section header")
	assert.ok(!body.includes("Not released yet"), "must not bleed into previous sections")
})

test("extractSection returns undefined for a missing version", () => {
	assert.equal(extractSection(MULTI_SECTION_CHANGELOG, "9.9.9"), undefined)
})

// Regression: the TUI parser requires headers at column 0; an indented header
// is plain text and must not be matched as a section.
test("extractSection ignores headers with leading whitespace", () => {
	const content = `## [1.0.0] - 2026-01-01

-real entry-

  ## [1.2.3] fake indented header
- body under indented header
`
	assert.equal(extractSection(content, "1.2.3"), undefined)
})

test("extractSection ignores headers without brackets", () => {
	const content = "## 1.2.3 - 2026-01-01\n- body\n"
	assert.equal(extractSection(content, "1.2.3"), undefined)
})

test("normalizeChangelogLinkTarget link rewriting matrix", () => {
	const tag = "v1.2.3"
	const repo = "getkimchi/kimchi"
	const cases = [
		// relative file path -> blob
		["docs/auto-model.md", "https://github.com/getkimchi/kimchi/blob/v1.2.3/docs/auto-model.md"],
		["./src/tui/app.ts", "https://github.com/getkimchi/kimchi/blob/v1.2.3/src/tui/app.ts"],
		// relative directory path -> tree
		["src/tui/", "https://github.com/getkimchi/kimchi/tree/v1.2.3/src/tui/"],
		["docs", "https://github.com/getkimchi/kimchi/tree/v1.2.3/docs"],
		// absolute URLs and anchors pass through
		["https://example.com/guide", "https://example.com/guide"],
		["#installation", "#installation"],
		["http://example.com/x?y=1#z", "http://example.com/x?y=1#z"],
		// protocol-relative URL passes through
		["//cdn.example.com/x.js", "//cdn.example.com/x.js"],
		// non-floating absolute GitHub URL passes through
		["https://github.com/getkimchi/kimchi/releases", "https://github.com/getkimchi/kimchi/releases"],
		// GitHub URL pinned to main is re-pinned to the release tag
		[
			"https://github.com/getkimchi/kimchi/blob/main/docs/setup.md",
			"https://github.com/getkimchi/kimchi/blob/v1.2.3/docs/setup.md",
		],
		// query and fragment preserved on rewritten links
		["docs/faq.md#why", "https://github.com/getkimchi/kimchi/blob/v1.2.3/docs/faq.md#why"],
	]
	for (const [target, expected] of cases) {
		assert.equal(normalizeChangelogLinkTarget(target, tag, repo), expected, `target: ${target}`)
	}
})

test("normalizeChangelogLinks rewrites inline markdown links only", () => {
	const markdown =
		"See [the docs](docs/auto-model.md) and [upstream](https://example.com). Text docs/auto-model.md stays."
	const result = normalizeChangelogLinks(markdown, "v2.0.0", "getkimchi/kimchi")
	assert.equal(
		result,
		"See [the docs](https://github.com/getkimchi/kimchi/blob/v2.0.0/docs/auto-model.md) and [upstream](https://example.com). Text docs/auto-model.md stays.",
	)
})

test("extractReleaseNotes extracts and rewrites the section", () => {
	const notes = extractReleaseNotes({ changelog: MULTI_SECTION_CHANGELOG, tag: "v1.2.3", version: "1.2.3" })
	assert.ok(notes.includes("[the docs](https://github.com/getkimchi/kimchi/blob/v1.2.3/docs/auto-model.md)"))
	assert.ok(notes.includes("[browse](https://github.com/getkimchi/kimchi/tree/v1.2.3/src/tui/folder/)"))
	assert.ok(!notes.includes("Older release"))
})

test("extractReleaseNotes defaults the tag to v<version> and rejects missing sections", () => {
	const notes = extractReleaseNotes({ changelog: MULTI_SECTION_CHANGELOG, version: "1.2.3" })
	assert.ok(notes.includes("https://github.com/getkimchi/kimchi/blob/v1.2.3/docs/auto-model.md"))
	assert.throws(
		() => extractReleaseNotes({ changelog: MULTI_SECTION_CHANGELOG, version: "4.5.6" }),
		/no "## \[4\.5\.6\]" section/,
	)
})

test("CLI extract writes notes to --out and exits 1 when the section is missing", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "release-notes-cli-"))
	const changelogPath = path.join(dir, "CHANGELOG.md")
	writeFileSync(changelogPath, MULTI_SECTION_CHANGELOG)

	const outPath = path.join(dir, "RELEASE_NOTES.md")
	execFileSync("node", [
		SCRIPT,
		"extract",
		"--version",
		"1.2.3",
		"--tag",
		"v1.2.3",
		"--changelog",
		changelogPath,
		"--out",
		outPath,
	])
	const notes = readFileSync(outPath, "utf-8")
	assert.ok(notes.includes("Auto-model default"))
	assert.ok(notes.endsWith("\n"))

	assert.throws(
		() => {
			execFileSync("node", [SCRIPT, "extract", "--version", "9.9.9", "--tag", "v9.9.9", "--changelog", changelogPath])
		},
		(error) => {
			assert.equal(error.status, 1)
			assert.match(error.stderr.toString(), /no "## \[9\.9\.9\]" section/)
			return true
		},
	)
})
