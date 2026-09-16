/**
 * One-shot local review server for the browser diff view — the same shape
 * plannotator uses (plannotator-browser.ts): kimchi hosts the page on a
 * random localhost port with a random single-use token; the page posts back
 * the human's decision (approve / request-changes / closed), and the caller
 * translates it into the same terminal actions the TUI dropdown maps to.
 *
 * Security posture: loopback only, random per-review token in the path, the
 * page and the decision endpoints are the ONLY routes. The server closes
 * itself once a decision is recorded (or on close() from the caller).
 */

import { randomBytes } from "node:crypto"
import { createServer, type Server } from "node:http"

export interface ReviewComment {
	file?: string
	line?: number
	side?: "old" | "new"
	code?: string
	text: string
}

export type ReviewDecision =
	| { kind: "approve" }
	| { kind: "request-changes"; summary?: string; comments: ReviewComment[] }
	| { kind: "closed" } // user pressed "Cancel & close" — return to the menu

export interface ReviewServer {
	/** Full URL the browser should open (includes the single-use token). */
	url: string
	/** Resolves once a decision has been posted. */
	decision: Promise<ReviewDecision>
	/** Tear down unconditionally (e.g. the caller took the TUI path instead). */
	close(): Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null
}

function parseComments(raw: unknown): ReviewComment[] {
	if (!Array.isArray(raw)) return []
	const out: ReviewComment[] = []
	for (const entry of raw) {
		if (!isRecord(entry) || typeof entry.text !== "string" || !entry.text.trim()) continue
		const comment: ReviewComment = { text: entry.text.trim() }
		if (typeof entry.file === "string") comment.file = entry.file
		if (typeof entry.line === "number" && Number.isFinite(entry.line)) comment.line = entry.line
		if (entry.side === "old" || entry.side === "new") comment.side = entry.side
		if (typeof entry.code === "string") comment.code = entry.code.slice(0, 500)
		out.push(comment)
	}
	return out
}

/**
 * Serves `html` at http://127.0.0.1:<port>/<token>/ and
 * POST <same path>/decision. `buildDecisionPayload` field names match the
 * page's JS: { action: "approve" | "request-changes" | "closed", summary?,
 * comments? }.
 */
export async function startReviewServer(opts: { html: string }): Promise<ReviewServer> {
	const token = randomBytes(16).toString("hex")
	const pathPrefix = `/${token}`

	let resolveDecision: ((decision: ReviewDecision) => void) | undefined
	const decision = new Promise<ReviewDecision>((resolve) => {
		resolveDecision = resolve
	})
	let settled = false
	const server: Server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1")
		const normalizedPath = url.pathname.replace(/\/+$/, "")
		if (req.method === "GET" && normalizedPath === pathPrefix) {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
			res.end(opts.html)
			return
		}
		if (req.method === "POST" && normalizedPath === `${pathPrefix}/decision`) {
			if (settled) {
				res.writeHead(409, { "content-type": "application/json" })
				res.end(JSON.stringify({ ok: false, duplicate: true }))
				return
			}
			const chunks: Buffer[] = []
			req.on("data", (c: Buffer) => chunks.push(c))
			req.on("end", () => {
				let body: Record<string, unknown> = {}
				try {
					body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}") as Record<string, unknown>
				} catch {
					// malformed body — treated as an empty decision below
				}
				let outcome: ReviewDecision
				if (body.action === "approve") {
					outcome = { kind: "approve" }
				} else if (body.action === "request-changes") {
					outcome = {
						kind: "request-changes",
						summary: typeof body.summary === "string" ? body.summary.slice(0, 20_000) : undefined,
						comments: parseComments(body.comments),
					}
				} else {
					outcome = { kind: "closed" }
				}
				settled = true
				resolveDecision?.(outcome)
				res.writeHead(200, { "content-type": "application/json" })
				res.end(JSON.stringify({ ok: true, action: outcome.kind }))
				// One-shot: the decision page is static from here on.
				setTimeout(() => {
					server.close()
				}, 300).unref()
			})
			return
		}
		res.writeHead(404, { "content-type": "text/plain" })
		res.end("not found")
	})

	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen)
		server.listen(0, "127.0.0.1", () => resolveListen())
	})
	const address = server.address()
	const port = typeof address === "object" && address ? address.port : 0

	return {
		url: `http://127.0.0.1:${port}${pathPrefix}/`,
		decision,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve())
			}),
	}
}
