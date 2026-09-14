import type { AgentDefinition } from "../../../agent-discovery/index.js"
import { AGENT_DEFINITIONS, discoverAgent } from "../../../agent-discovery/index.js"
import type { ServerEntry } from "../../../extensions/mcp-adapter/types.js"

/**
 * import_discover over ACP — a sessionless, read-only method that tells a
 * client everything it needs to render the whole import screen in one round
 * trip: the source apps that have something importable, each with its
 * enumerated skills and MCP servers. Nothing is written to disk; opening an
 * import screen must never change the user's configuration.
 *
 * Discovery is scoped to home-level roots (`discoverAgent`'s "home" scope):
 * onboarding runs before any workspace exists, and the harness inherits its
 * working directory from whichever process launched it — for a desktop-launched
 * app that is the filesystem root, so project-relative roots are meaningless
 * here and probing them risks an OS permission prompt.
 *
 * Source: castai/kimchi/kimchi-studio#370, ADR-0043/ADR-0044.
 */

/** One skill found in a source app, attributed to its source. */
export interface ImportDiscoverSkill {
	/** Invocation name (frontmatter `name`, falling back to the directory name). */
	name: string
	/** Description read from the skill's frontmatter. */
	description: string
	/** Absolute path to the skill's SKILL.md. */
	path: string
	/** Stable id of the source app this skill came from. */
	sourceAppId: string
	/** Display name of the source app this skill came from. */
	sourceAppName: string
}

/**
 * One MCP server found in a source app, attributed to its source. Only the
 * name and the command or URL are reported — args, env, headers and tokens
 * are deliberately left out. Entries with neither a command nor a URL give a
 * client nothing to act on and are dropped.
 *
 * URLs are redacted before leaving the harness: userinfo (user:pass@) and
 * the query string are stripped, since hosted MCP gateways commonly embed
 * credentials there. Credentials embedded in URL *path segments* cannot be
 * detected generically — clients must treat a server URL as potentially
 * sensitive and decide how to display and store it.
 */
export interface ImportDiscoverMcpServer {
	name: string
	command?: string
	url?: string
	/** Stable id of the source app this server came from. */
	sourceAppId: string
	/** Display name of the source app this server came from. */
	sourceAppName: string
}

/** One source app that has something importable. Apps with neither skills nor MCP servers are omitted. */
export interface ImportDiscoverSourceApp {
	id: string
	displayName: string
	skills: ImportDiscoverSkill[]
	mcpServers: ImportDiscoverMcpServer[]
}

/**
 * Type alias (not an interface) on purpose: object literal types get an
 * implicit index signature, so the extMethod handler can return it directly
 * as `Record<string, unknown>` without a cast or a spread.
 */
export type ImportDiscoverResult = {
	apps: ImportDiscoverSourceApp[]
}

/**
 * Strip the credential-carrying parts of a server URL before it leaves the
 * harness: userinfo (user:pass@) and the query string (API keys in ?key=…).
 * Path-embedded credentials cannot be detected generically — documented on
 * ImportDiscoverMcpServer — so the client contract treats URLs as potentially
 * sensitive regardless.
 */
function redactUrl(raw: string): string {
	try {
		const u = new URL(raw)
		u.username = ""
		u.password = ""
		u.search = ""
		return u.toString()
	} catch {
		// Not parseable as a URL — leave it; the entry is still actionable only
		// if the client can use it, and it carries no *added* exposure beyond
		// what the source config already holds.
		return raw
	}
}

function toImportDiscoverMcpServer(
	name: string,
	entry: ServerEntry,
	sourceAppId: string,
	sourceAppName: string,
): ImportDiscoverMcpServer | undefined {
	// Falsy, not undefined: an empty-string command or URL is just as
	// unactionable as an absent one, so junk values from source configs are
	// treated the same as missing ones.
	if (!entry.command && !entry.url) return undefined
	const server: ImportDiscoverMcpServer = { name, sourceAppId, sourceAppName }
	if (entry.command) server.command = entry.command
	if (entry.url) server.url = redactUrl(entry.url)
	return server
}

export function importDiscover(definitions: readonly AgentDefinition[] = AGENT_DEFINITIONS): ImportDiscoverResult {
	const apps: ImportDiscoverSourceApp[] = []
	for (const def of definitions) {
		const discovery = discoverAgent(def, { scope: "home" })
		const skills = discovery.skills.map((s) => ({
			name: s.name,
			description: s.description,
			path: s.path,
			sourceAppId: discovery.id,
			sourceAppName: discovery.displayName,
		}))
		const mcpServers = Object.entries(discovery.mcpServers)
			.map(([name, entry]) => toImportDiscoverMcpServer(name, entry, discovery.id, discovery.displayName))
			.filter((server) => server !== undefined)
		// An app with nothing importable is left out entirely, so a client never
		// has to filter empty rows — except when its skills directory could not
		// be read (skillCount === -1) or contains skill-looking entries whose
		// enumeration failed (skillCount > 0 with no readable skills). Report it
		// with an empty payload so the client can distinguish "nothing here"
		// from "couldn't read what is here".
		if (skills.length === 0 && mcpServers.length === 0 && discovery.skillCount === 0) continue
		apps.push({ id: discovery.id, displayName: discovery.displayName, skills, mcpServers })
	}
	return { apps }
}
