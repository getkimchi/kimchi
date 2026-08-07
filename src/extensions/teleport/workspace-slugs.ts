import type { Workspace } from "../../sandbox/cloud/types.js"

/**
 * Slugifies a workspace name: lowercases, strips combining marks, collapses
 * non-alphanumeric runs to a single dash, and trims leading/trailing dashes.
 */
export function slugify(name: string): string {
	return name
		.toLowerCase()
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
}

/**
 * Assigns a unique slug per workspace. Same name → same slug deterministically;
 * collisions get an `-<id-prefix>` suffix (first 8 alphanumeric chars of the
 * workspace ID). Shared by SSH alias generation and workspace list display so
 * both disambiguate identically.
 */
export function assignWorkspaceSlugs(workspaces: Workspace[]): Map<string, string> {
	const slugs = new Map<string, string>()
	for (const ws of workspaces) {
		slugs.set(ws.id, slugify(ws.name) || ws.id.slice(0, 8).toLowerCase())
	}

	const counts = new Map<string, number>()
	for (const slug of slugs.values()) {
		counts.set(slug, (counts.get(slug) ?? 0) + 1)
	}

	const result = new Map<string, string>()
	for (const ws of workspaces) {
		const slug = slugs.get(ws.id) ?? ws.id.slice(0, 8)
		const needsSuffix = (counts.get(slug) ?? 0) > 1
		const idSuffix = ws.id
			.replace(/[^a-z0-9]/gi, "")
			.slice(0, 8)
			.toLowerCase()
		result.set(ws.id, needsSuffix && idSuffix ? `${slug}-${idSuffix}` : slug)
	}
	return result
}
