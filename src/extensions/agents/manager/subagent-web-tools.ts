/**
 * Web tools for subagent sessions.
 *
 * The Kimchi CLI registers the bundled web extensions as inline factories in
 * the parent session only, and a child session's DefaultResourceLoader does
 * not discover repo-native extensions — so unless the runner registers them
 * here, the documented extension-tool inheritance (personas with
 * `extensions: true` receive the child session's registered tools) had
 * nothing to inherit and even the built-in Researcher ran without web access.
 *
 * `WEB_TOOL_MANAGED_FACTORIES` is the single source of truth: the parent CLI
 * registers the same entries, so main-session and subagent gating cannot
 * drift. Gating goes through the same `tools.web_search` / `tools.web_fetch`
 * resource toggles in both places.
 */

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent"
import { enabledExtensionFactories, type ManagedExtensionFactory } from "../../../resources/filter.js"
import webFetchExtension from "../../web-fetch/index.js"
import webSearchExtension from "../../web-search/index.js"

export const WEB_TOOL_MANAGED_FACTORIES: ManagedExtensionFactory[] = [
	{ id: "tools.web_fetch", factory: webFetchExtension },
	{ id: "tools.web_search", factory: webSearchExtension },
]

// web-fetch's cache + Playwright browser pool are process-global module
// singletons, torn down by the extension's session_shutdown handler. A child
// session must never own that teardown: a subagent ending would wipe the
// shared cache and kill the shared browser while the parent (or a sibling
// subagent) may still be mid-fetch. The parent session keeps the default
// (cleanup bound); children opt out.
const childSafeWebFetch: ExtensionFactory = (pi) => webFetchExtension(pi, { cleanupOnShutdown: false })

export function subagentWebToolFactories(): ExtensionFactory[] {
	return enabledExtensionFactories(
		WEB_TOOL_MANAGED_FACTORIES.map((entry) =>
			entry.id === "tools.web_fetch" ? { ...entry, factory: childSafeWebFetch } : entry,
		),
	)
}
