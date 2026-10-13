import { readdir, readFile, stat } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { stripTerminalSequences } from "@earendil-works/pi-tui"
import { DEFAULT_SLUG, derivePlanTitle } from "../../shared/planning/plan-markdown.js"
import { isWorkId } from "../../shared/work-id.js"
import { mergePullRequestLinks, pullRequestLabel } from "../pull-request-status/links.js"
import { storedPullRequests } from "../pull-request-status/provider-records.js"
import type { WorkPullRequest } from "../pull-request-status/pull-requests.js"
import type { WorkDetailsRequest } from "../work-attribution.js"
import { costDetailLines, type knownSpend } from "./cost-details.js"
import { decimalNanos, roundedUsd, time } from "./costs.js"
import { readWorkHead, type WorkHead } from "./row-log.js"
import { object } from "./summary.js"

/** Besides the current work, the panel lists works with activity this recent. */
const RECENT_MS = 35 * 24 * 60 * 60_000
const MAX_WORKS = 30
/** Larger files are skipped rather than read; a plan is read only for its title. */
const MAX_TOTALS_BYTES = 8 * 1024 * 1024
const MAX_PLAN_BYTES = 256 * 1024

type Spend = ReturnType<typeof knownSpend>
type Link = Pick<WorkPullRequest, "provider" | "number" | "state" | "url">

/** One work's saved files; any of them can be missing or damaged. Each stays small however long the work runs. */
export interface SavedWork {
	workId: string
	/** The `work.json` manifest. */
	head?: WorkHead
	/** Parsed `cost-totals.json`. */
	totals?: unknown
	planTitle?: string
	/** `work.json` modification time, used when the summary has no timestamps. */
	modifiedAt?: number
}

export interface WorkRow {
	workId: string
	/** Plain text; the panel styles and shortens it. */
	label: string
	value: string
	description: string
	/** The text `/work` prints for this work. */
	details: string
}

export interface WorkBrowser {
	/** The current work first, then the others by last activity. */
	rows: WorkRow[]
	/** Spend across the listed works; connected works share requests, which count once. */
	spend: string
}

/** Reads only local files, so opening the panel never waits for the network. */
export async function readWorkBrowser(
	agentDir: string,
	current: WorkDetailsRequest,
	now = Date.now(),
): Promise<WorkBrowser> {
	const directory = join(agentDir, "work")
	// Recording any activity commits a new work.json, so its modification time bounds what is read.
	const modified = new Map<string, number>()
	await Promise.all(
		(await readdir(directory).catch(() => [])).filter(isWorkId).map(async (workId) => {
			const info = await stat(join(directory, workId, "work.json")).catch(() => undefined)
			if (info) modified.set(workId, info.mtimeMs)
		}),
	)

	const candidates = [...modified]
		.filter(([workId, at]) => workId !== current.workId && at >= now - RECENT_MS)
		.map(([workId]) => workId)
	const [own, ...others] = await Promise.all(
		[current.workId, ...candidates].map(
			async (workId): Promise<SavedWork> => ({
				workId,
				head: await readWorkHead(agentDir, workId),
				modifiedAt: modified.get(workId),
			}),
		),
	)
	// Cost passes rewrite work.json weeks after the last request, so saved activity times pick the works listed.
	// Reading deletes a work.json that is not a manifest; that work is listed again once an update rebuilds it.
	const recent = others
		.filter((work) => work.head)
		.map((work) => ({ work, activity: lastActivity(work) ?? 0 }))
		.filter(({ activity }) => activity >= now - RECENT_MS)
		.sort((left, right) => right.activity - left.activity || left.work.workId.localeCompare(right.work.workId))
		.slice(0, MAX_WORKS - 1)
		.map(({ work }) => work)
	const works = await Promise.all(
		[own, ...recent].map(async (work): Promise<SavedWork> => {
			const folder = join(directory, work.workId)
			const [totals, planTitle] = await Promise.all([
				readJson(join(folder, "cost-totals.json")),
				work.head && readPlanTitle(folder, work.head),
			])
			return { ...work, totals, planTitle }
		}),
	)
	return buildWorkBrowser(agentDir, current, works)
}

/** Newest request start, native edit or retained plan; the file time when the manifest has none. */
function lastActivity(work: SavedWork): number | undefined {
	return time(work.head?.latest.activityAt) ?? work.modifiedAt
}

/** Rows from saved summaries. Only the current work has live PR lookup lines; the rest use their saved links. */
export function buildWorkBrowser(agentDir: string, current: WorkDetailsRequest, works: SavedWork[]): WorkBrowser {
	const built = works
		.map((work) => workRow(agentDir, work, work.workId === current.workId ? current : undefined))
		.sort(
			(left, right) =>
				Number(right.current) - Number(left.current) ||
				(right.activity ?? 0) - (left.activity ?? 0) ||
				left.row.workId.localeCompare(right.row.workId),
		)
	// Connected works' totals cover the same requests: count each group once, plus requests not priced yet.
	const groups = new Map<string, Spend>()
	const spend: Spend = { priced: 0, total: 0, nanos: 0n }
	for (const { group, unpriced } of built) {
		spend.total += unpriced
		if (group && !groups.has(group.key)) groups.set(group.key, group.spend)
	}
	for (const group of groups.values()) {
		spend.priced += group.priced
		spend.total += group.total
		spend.nanos += group.nanos
	}
	return {
		rows: built.map(({ row }) => row),
		spend: spendText(
			spend,
			built.some(({ partial }) => partial),
		),
	}
}

function spendOf(value: unknown): Spend | undefined {
	return object(value) && typeof value.priced === "number" && typeof value.total === "number"
		? { priced: value.priced, total: value.total, nanos: decimalNanos(value.knownCostUsd) ?? 0n }
		: undefined
}

/** A work's saved `cost-totals.json`, when it is readable. */
function costTotals(value: unknown, workId: string) {
	if (!object(value) || value.workId !== workId || !Array.isArray(value.group) || !Array.isArray(value.pullRequests))
		return undefined
	const own = spendOf(value.requests)
	const group = spendOf(value.groupRequests)
	if (!own || !group || !object(value.requests) || typeof value.requests.recorded !== "number") return undefined
	return {
		own,
		recorded: value.requests.recorded,
		group: { key: JSON.stringify(value.group), spend: group },
	}
}

function workRow(agentDir: string, work: SavedWork, current?: WorkDetailsRequest) {
	const { workId } = work
	const folder = join(agentDir, "work", workId)
	const { head } = work
	const totals = costTotals(work.totals, workId)
	const requests = head?.logs.requests?.rows ?? 0
	// Requests recorded after the last cost pass are not in the totals yet; they count as unpriced.
	const unpriced = head ? Math.max(0, requests - (totals?.recorded ?? 0)) : 0
	const spent: Spend | undefined = totals
		? { ...totals.own, total: totals.own.total + unpriced }
		: head && { priced: 0, total: unpriced, nanos: 0n }
	const links: Link[] = head ? mergePullRequestLinks(storedPullRequests(head.pullRequests)) : []
	const latest = head?.latest
	const activity = lastActivity(work)
	const path =
		latest?.edit?.repository ?? latest?.commit?.repository ?? latest?.request?.repository ?? latest?.request?.cwd
	const name = path === undefined ? undefined : repositoryName(path)
	const branch = latest?.branch?.branch
	const title = plain(work.planTitle ?? [name, branch].filter(Boolean).join(" · "))
	const pullRequests = current ? current.lines : links.map((pr) => `${pullRequestLabel(pr)}: ${pr.url}`)
	const costLines = costDetailLines(work.totals, join(folder, "costs.json"))
	const context = head
		? [
				`Repository: ${name ? plain(name) : "unknown"}${branch ? ` · branch ${plain(branch)}` : ""}`,
				`Last activity: ${activity === undefined ? "unknown" : localTime(activity)} · ${requests} request${requests === 1 ? "" : "s"}`,
			]
		: [`Summary unavailable: ${join(folder, "work.json")}`]
	const row: WorkRow = {
		workId,
		label: `${current ? "●" : " "} ${workId.slice(0, 8)} ${title || (head ? "untitled work" : "summary unavailable")}`,
		value: `${spendText(spent)} · ${pullRequestState(links)}`,
		description: [`Work ID: ${workId}`, ...context, ...pullRequests, ...costLines].join("\n"),
		details: [`Work ID: ${workId}`, ...pullRequests, ...costLines].join("\n"),
	}
	return {
		row,
		current: current !== undefined,
		activity,
		partial: !spent,
		unpriced,
		group: totals?.group,
	}
}

/** `/src/app/.git` and `/srv/app.git` name `app`; a working directory names itself. */
function repositoryName(path: string): string {
	const name = basename(path)
	return name === ".git" ? basename(dirname(path)) : name.replace(/\.git$/, "")
}

/** Compact for the list, with exact amounts left to the description. Unpriced spend never shows as $0. */
function spendText(spend: Spend | undefined, partial = false): string {
	if (!spend) return "cost unknown"
	const complete = !partial && spend.priced === spend.total
	if (complete && !spend.total) return "no requests"
	if (!spend.nanos && !complete) return "cost unknown"
	return `${roundedUsd(spend.nanos)}${complete ? "" : " known so far"}`
}

function pullRequestState(links: Link[]): string {
	if (links.length === 1) return pullRequestLabel(links[0])
	if (!links.length) return "no PR"
	return `${links.length} ${links.every((pr) => pr.provider === "gitlab") ? "MRs" : "PRs"}`
}

function localTime(at: number): string {
	const date = new Date(at)
	const pad = (value: number) => String(value).padStart(2, "0")
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Saved names come from model and Git output; keep them to one printable line. */
function plain(text: string): string {
	return stripTerminalSequences(text)
		.replace(/\p{Cc}+/gu, " ")
		.trim()
}

/** Missing, special and oversized files read as undefined. */
async function readText(path: string, limit: number): Promise<string | undefined> {
	try {
		const info = await stat(path)
		return info.isFile() && info.size <= limit ? await readFile(path, "utf8") : undefined
	} catch {
		return undefined
	}
}

async function readJson(path: string): Promise<unknown> {
	const text = await readText(path, MAX_TOTALS_BYTES)
	try {
		return text === undefined ? undefined : JSON.parse(text)
	} catch {
		return undefined
	}
}

/** The latest plan's title, read from its retained copy inside this work's folder. */
async function readPlanTitle(folder: string, head: WorkHead): Promise<string | undefined> {
	const snapshot = head.latest.plan?.snapshotPath
	if (typeof snapshot !== "string") return undefined
	const text = await readText(join(folder, "plans", basename(snapshot)), MAX_PLAN_BYTES)
	const title = text === undefined ? undefined : derivePlanTitle(text)
	return title === DEFAULT_SLUG ? undefined : title
}
