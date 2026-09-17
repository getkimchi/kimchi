// Release notes extraction from CHANGELOG.md.
//
// Adapted from https://github.com/earendil-works/pi (Apache-2.0).
//
// Usage:
//   node scripts/release-notes.mjs extract --version <x.y.z> --tag <vX.Y.Z> [--repo <owner/repo>] [--changelog <path>] [--out <path>]
//
// Extracts the "## [X.Y.Z]" section from CHANGELOG.md and rewrites relative
// links so they resolve on GitHub for the given tag. Fails with exit code 1
// when the version section is missing.

import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import process from "node:process"
import { pathToFileURL } from "node:url"

const DEFAULT_REPO = "getkimchi/kimchi"
const DEFAULT_CHANGELOG = "CHANGELOG.md"

const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i
const INLINE_MARKDOWN_LINK_RE = /(!?\[[^\]\n]+\]\()([^\s)]+)((?:\s+[^)]*)?\))/g

// Section headers must sit at column 0: the TUI parser discards indented
// headers, so an entry like "  ## [1.2.3]" is plain text, not a section.
const SECTION_HEADER_RE = /^## \[([^\]]+)\](.*)$/

export function normalizeTag(version) {
	return version.startsWith("v") ? version : `v${version}`
}

// Split a link target into path, query, and fragment parts.
function splitLocalTarget(target) {
	const hashIndex = target.indexOf("#")
	const beforeHash = hashIndex === -1 ? target : target.slice(0, hashIndex)
	const fragment = hashIndex === -1 ? "" : target.slice(hashIndex)
	const queryIndex = beforeHash.indexOf("?")
	if (queryIndex === -1) {
		return { fragment, pathPart: beforeHash, query: "" }
	}
	return {
		fragment,
		pathPart: beforeHash.slice(0, queryIndex),
		query: beforeHash.slice(queryIndex),
	}
}

// Resolve a relative link target against the repository root (the changelog
// lives at the repo root, so relative paths resolve from there).
function resolveRepositoryPath(targetPath) {
	const normalizedTarget = targetPath.replaceAll("\\", "/")
	const joined = path.posix.normalize(normalizedTarget.replace(/^\/+/, "").replace(/^\.\/+/, ""))
	if (joined === "." || joined === ".." || joined.startsWith("../")) {
		return undefined
	}
	return joined
}

// A target points at a directory when it ends with "/" or its basename has no
// file extension.
function isDirectoryTarget(originalPath, repositoryPath) {
	if (originalPath.endsWith("/")) {
		return true
	}
	const basename = path.posix.basename(repositoryPath)
	return !basename.includes(".")
}

// Rewrite a single changelog link target so it resolves on GitHub for `tag`.
// Absolute URLs, protocol-relative URLs, and bare anchors pass through
// unchanged. Existing GitHub blob/tree URLs pinned to main/master are re-pinned
// to the release tag so notes always link to the released tree.
export function normalizeChangelogLinkTarget(target, tag, repoSlug) {
	const repoUrl = `https://github.com/${repoSlug}`
	let canonicalTarget = target
	for (const route of ["blob", "tree"]) {
		for (const branch of ["main", "master"]) {
			const floatingRefPrefix = `${repoUrl}/${route}/${branch}/`
			if (canonicalTarget.startsWith(floatingRefPrefix)) {
				canonicalTarget = `${repoUrl}/${route}/${tag}/${canonicalTarget.slice(floatingRefPrefix.length)}`
			}
		}
	}
	if (canonicalTarget.startsWith("#") || canonicalTarget.startsWith("//") || URL_SCHEME_RE.test(canonicalTarget)) {
		return canonicalTarget
	}
	const { fragment, pathPart, query } = splitLocalTarget(canonicalTarget)
	if (!pathPart) {
		return canonicalTarget
	}
	const repositoryPath = resolveRepositoryPath(pathPart)
	if (!repositoryPath) {
		return canonicalTarget
	}
	const route = isDirectoryTarget(pathPart, repositoryPath) ? "tree" : "blob"
	return `${repoUrl}/${route}/${tag}/${encodeURI(repositoryPath)}${query}${fragment}`
}

// Rewrite every inline markdown link in `markdown` so relative targets point
// at the GitHub repository for the given tag.
export function normalizeChangelogLinks(markdown, tag, repoSlug = DEFAULT_REPO) {
	return markdown.replace(INLINE_MARKDOWN_LINK_RE, (_match, prefix, target, suffix) => {
		return `${prefix}${normalizeChangelogLinkTarget(target, tag, repoSlug)}${suffix}`
	})
}

// Extract the body of the "## [<version>]" section (up to the next column-0
// "## " header or EOF), trimmed. Returns undefined when the section is absent.
export function extractSection(changelogContent, version) {
	const lines = changelogContent.split("\n")
	const start = lines.findIndex((line) => {
		const match = line.match(SECTION_HEADER_RE)
		return match !== null && match[1] === version
	})
	if (start === -1) {
		return undefined
	}
	const end = lines.findIndex((line, index) => index > start && line.startsWith("## "))
	const body = lines
		.slice(start + 1, end === -1 ? lines.length : end)
		.join("\n")
		.trim()
	return body.length > 0 ? body : undefined
}

export function extractReleaseNotes({ changelog, version, tag, repo = DEFAULT_REPO }) {
	const section = extractSection(changelog, version)
	if (section === undefined) {
		throw new Error(
			`CHANGELOG.md has no "## [${version}]" section. Did you run "node scripts/release.mjs ${version}" and push the tag?`,
		)
	}
	return normalizeChangelogLinks(section, tag ?? normalizeTag(version), repo)
}

function parseArgs(argv) {
	const options = {
		changelog: DEFAULT_CHANGELOG,
		out: undefined,
		repo: DEFAULT_REPO,
		subcommand: undefined,
		tag: undefined,
		version: undefined,
	}
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		if (options.subcommand === undefined) {
			options.subcommand = arg
			continue
		}
		switch (arg) {
			case "--version":
				options.version = argv[++i]
				break
			case "--tag":
				options.tag = argv[++i]
				break
			case "--repo":
				options.repo = argv[++i]
				break
			case "--changelog":
				options.changelog = argv[++i]
				break
			case "--out":
				options.out = argv[++i]
				break
			default:
				throw new Error(`Unknown argument: ${arg}`)
		}
	}
	return options
}

function usage() {
	console.error(
		"Usage: node scripts/release-notes.mjs extract --version <x.y.z> --tag <vX.Y.Z> [--repo <owner/repo>] [--changelog <path>] [--out <path>]",
	)
}

function main(argv) {
	let options
	try {
		options = parseArgs(argv)
	} catch (error) {
		usage()
		console.error(error.message)
		process.exit(1)
	}
	if (options.subcommand !== "extract" || !options.version) {
		usage()
		process.exit(1)
	}
	const tag = options.tag ?? normalizeTag(options.version)
	let changelog
	try {
		changelog = readFileSync(options.changelog, "utf-8")
	} catch (error) {
		console.error(`Cannot read changelog at ${options.changelog}: ${error.message}`)
		process.exit(1)
	}
	let notes
	try {
		notes = extractReleaseNotes({ changelog, repo: options.repo, tag, version: options.version })
	} catch (error) {
		console.error(error.message)
		process.exit(1)
	}
	if (options.out) {
		writeFileSync(options.out, `${notes}\n`)
		console.log(`Wrote release notes for ${tag} to ${path.resolve(options.out)}`)
	} else {
		console.log(notes)
	}
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main(process.argv.slice(2))
}
