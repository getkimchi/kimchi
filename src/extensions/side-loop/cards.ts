/**
 * Signal → card. Each card is a surface (surface.ts) with its own data model;
 * a repeated signal for the same id becomes an update, so cards evolve.
 */
import { isAbsolute, relative } from "node:path"
import { pathToFileURL } from "node:url"
import { pullRequestSurface } from "./pr-watch.js"
import type { Signal } from "./signals.js"
import type { SideSurface } from "./surface.js"

export type CardSeed = Omit<SideSurface, "createdAt" | "updatedAt">

export function cardFor(signal: Signal, cwd: string): CardSeed {
	switch (signal.kind) {
		case "pr":
			return pullRequestSurface(signal.pr)
		case "artifact":
			return {
				id: `artifact:${signal.path}`,
				kind: "artifact",
				title: signal.name,
				summary: { path: "/summary" },
				tone: { path: "/tone" },
				link: pathToFileURL(signal.path).href,
				components: [{ id: "root", type: "kv", items: [{ label: "file", value: { path: "/path" } }] }],
				data: { path: displayPath(signal.path, cwd), origin: signal.origin, tone: "info", summary: "ready" },
			}
		case "tests": {
			const tone = signal.ok ? "ok" : "error"
			const summary = signal.failed
				? `✗ ${signal.failed} failed · ${signal.passed} passed`
				: `✓ ${signal.passed} passed`
			return {
				id: "tests",
				kind: "tests",
				title: "Tests",
				summary: { path: "/summary" },
				tone: { path: "/tone" },
				components: [
					{
						id: "root",
						type: "kv",
						items: [
							{ label: "result", value: { path: "/summary" } },
							{ label: "command", value: { path: "/command" } },
							{ label: "runs", value: { path: "/runs" } },
						],
					},
				],
				data: { tone, summary, command: signal.command },
			}
		}
		case "deploy":
			return {
				id: `deploy:${signal.target}`,
				kind: "deploy",
				title: `Deploy · ${signal.target}`,
				summary: { path: "/summary" },
				tone: { path: "/tone" },
				link: signal.url,
				components: [
					{
						id: "root",
						type: "kv",
						items: [
							{ label: "status", value: { path: "/summary" } },
							{ label: "command", value: { path: "/command" } },
						],
					},
				],
				data: {
					tone: signal.ok ? "ok" : "error",
					summary: signal.ok ? (signal.url ? "live" : "applied") : "failed",
					command: signal.command,
				},
			}
		case "message":
			return {
				id: `message:${signal.service}:${signal.channel}`,
				kind: "message",
				title: `${signal.service[0].toUpperCase()}${signal.service.slice(1)} · ${signal.channel}`,
				summary: { path: "/summary" },
				tone: "info",
				components: [{ id: "root", type: "text", text: { path: "/text" } }],
				data: { summary: signal.direction, text: signal.text },
			}
	}
}

/** Uncommitted work, like the /diff mod: `git diff --shortstat` against HEAD. */
export function changesCard(shortstat: string, files: number): CardSeed {
	return {
		id: "changes",
		kind: "changes",
		title: "Uncommitted",
		summary: { path: "/summary" },
		tone: "info",
		components: [{ id: "root", type: "text", text: { path: "/detail" } }],
		data: { summary: `${files} file${files === 1 ? "" : "s"}`, detail: shortstat.trim() || `${files} changed` },
	}
}

/** Context weather, like the token-weather mod: only once the window is filling up. */
export function contextCard(percent: number): CardSeed {
	const tone = percent >= 85 ? "error" : "warn"
	return {
		id: "context",
		kind: "context",
		title: "Context",
		summary: { path: "/summary" },
		tone: { path: "/tone" },
		components: [{ id: "root", type: "text", text: { path: "/advice" } }],
		data: {
			tone,
			summary: `${Math.round(percent)}% full`,
			advice: percent >= 85 ? "Compaction is near — /compact now keeps control of what survives." : "Filling up.",
		},
	}
}

/** Inside the project, the relative path is the one the user recognises. */
export function displayPath(path: string, cwd: string): string {
	const rel = relative(cwd, path)
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path
}
