/**
 * web_fetch extension — registers the tool with pi-mono.
 *
 * This is a thin registration shell. All business logic lives in
 * execute-handler.ts so it can be tested without pi-mono dependencies.
 */

import { StringEnum } from "@earendil-works/pi-ai"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Container, Spacer, Text } from "@earendil-works/pi-tui"
import { Type } from "typebox"
import { formatCount } from "../format.js"
import { type SpinnerState, clearSpinner, spinnerFrame, tickSpinner } from "../spinner.js"
import { shutdownBrowserPool } from "./browser-pool.js"
import { cacheClear } from "./cache.js"
import { type WebFetchDetails, executeWebFetch } from "./execute-handler.js"

type WebFetchState = SpinnerState

function formatDomain(url: string): string {
	try {
		return new URL(url).hostname
	} catch {
		return url
	}
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`
	return `${(ms / 1000).toFixed(1)}s`
}

export default function webFetchExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch a web page by URL and return its content. " +
			"Use this to read documentation, API references, or any web page. " +
			"Returns markdown by default, but can also return plain text or raw HTML.",
		parameters: Type.Object({
			url: Type.String({ description: "The URL to fetch (must start with http:// or https://)" }),
			format: Type.Optional(
				StringEnum(["markdown", "text", "html"] as const, {
					description:
						'Output format. "markdown" converts HTML to clean markdown (default), ' +
						'"text" extracts plain text, "html" returns raw HTML unchanged.',
					default: "markdown",
				}),
			),
			timeout: Type.Optional(
				Type.Number({
					description:
						"Timeout in seconds for the page fetch. Default is 30 seconds, maximum is 120 seconds. " +
						"Values above 120 are clamped to 120.",
				}),
			),
		}),

		async execute(_toolCallId, params, signal) {
			return executeWebFetch(params, signal)
		},

		renderCall(args, theme, context) {
			const state = context.state as WebFetchState

			const running = context.executionStarted && context.isPartial
			if (running) tickSpinner(state, context.invalidate)

			const spinner = running ? theme.fg("accent", spinnerFrame(state)) : theme.fg("muted", "-")

			const domain = formatDomain(args.url ?? "")
			const header = `${spinner} ${theme.fg("toolTitle", theme.bold("Web fetch"))}`
			const domainLine = `  ${theme.fg("muted", "domain:")} ${theme.fg("accent", "`")}${theme.fg("accent", domain)}${theme.fg("accent", "`")}`

			const component = context.lastComponent instanceof Container ? context.lastComponent : new Container()
			component.clear()
			component.addChild(new Text(`${header}\n${domainLine}`, 0, 0))
			return component
		},

		renderResult(result, options, theme, context) {
			const state = context.state as WebFetchState

			if (!options.isPartial) {
				clearSpinner(state)
			}

			const details = result.details as WebFetchDetails | undefined
			const component = context.lastComponent instanceof Container ? context.lastComponent : new Container()
			component.clear()

			if (details?.warning) {
				component.addChild(new Spacer(1))
				component.addChild(new Text(theme.fg("error", `  [WARNING] ${details.warning}`), 0, 0))
			}

			if (!options.isPartial && details !== undefined) {
				if (details.warning) component.addChild(new Spacer(1))
				const duration = theme.fg("dim", formatDuration(details.durationMs))
				const chars = theme.fg("dim", `↓${formatCount(details.words)}`)
				component.addChild(new Text(theme.fg("dim", `- ${duration}  ${chars}`), 0, 0))
			}

			return component
		},
	})

	pi.on("session_shutdown", () => {
		cacheClear()
		void shutdownBrowserPool()
	})
}
