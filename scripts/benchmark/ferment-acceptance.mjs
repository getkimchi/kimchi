#!/usr/bin/env node
/**
 * ferment-acceptance — L3 acceptance-evidence harvester.
 *
 * Collects the mechanical half of the A/B acceptance matrix (see
 * .kimchi/docs/session-analysis/ferment-quality-implementation-plan.md §L3):
 * for one built artifact directory it records
 *   layer-1  script-decidable checks (npm install state, build exit, test
 *            exit) — the gates the old pipeline ran;
 *   layer-2  native-medium observation — the artifact as users receive it:
 *            (a) served HTML fetched with curl-equivalent GET on demand after
 *                booting the artifact, no preconditions;
 *            (b) app-state JSON from a scripted probe executed *on the host
 *                app* via Playwright page.evaluate (DOM structure, text
 *                surface, custom window globals, data-testid hooks), plus an
 *                optional per-run probe module for interactive probing.
 *
 * Usage:
 *   node scripts/benchmark/ferment-acceptance.mjs <artifact-dir> --label <name>
 *     [--out <dir>] [--port <n>] [--settle <ms>] [--probe <file.mjs>]
 *     [--playwright <path>] [--skip-layer1]
 *
 * Output bundle: <out>/manifest.json, layer1.json, served.html, probe.json.
 * Layer-2 scoring happens over the bundle, not inside this script.
 */

import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { extname, join, resolve } from "node:path"

function parseArgs(argv) {
	const args = { port: 5193, settle: 4000, skipLayer1: false }
	const rest = []
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i]
		if (a.startsWith("--")) {
			const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
			const next = argv[i + 1]
			if (next === undefined || next.startsWith("--")) {
				args[key] = true
			} else {
				args[key] = next
				i++
			}
		} else rest.push(a)
	}
	if (rest.length !== 1 || !args.label) {
		console.error(
			"usage: ferment-acceptance.mjs <artifact-dir> --label <name> [--out dir] [--port n] [--settle ms] [--probe file] [--playwright path] [--skip-layer1]",
		)
		process.exit(2)
	}
	args.artifactDir = resolve(rest[0])
	args.port = Number(args.port)
	args.settle = Number(args.settle)
	args.out = resolve(args.out ?? join(".kimchi/docs/session-analysis/acceptance", args.label))
	return args
}

/** Run a command; resolves { ok, code, ms, tail }. Never throws. */
function run(cmd, cmdArgs, cwd, timeoutMs) {
	return new Promise((resolvePromise) => {
		const started = Date.now()
		const proc = spawn(cmd, cmdArgs, { cwd, stdio: ["ignore", "pipe", "pipe"] })
		let out = ""
		proc.stdout.on("data", (d) => {
			out += d
		})
		proc.stderr.on("data", (d) => {
			out += d
		})
		const timer = setTimeout(() => {
			proc.kill("SIGKILL")
			resolvePromise({
				ok: false,
				code: null,
				ms: Date.now() - started,
				tail: `TIMEOUT after ${timeoutMs}ms\n${out.slice(-4000)}`,
			})
		}, timeoutMs)
		proc.on("error", (err) => {
			clearTimeout(timer)
			resolvePromise({ ok: false, code: null, ms: Date.now() - started, tail: `spawn error: ${err.message}` })
		})
		proc.on("exit", (code) => {
			clearTimeout(timer)
			resolvePromise({ ok: code === 0, code, ms: Date.now() - started, tail: out.slice(-4000) })
		})
	})
}

/** Layer-1: the checks the old pipeline's gates ran — install/build/test. */
async function collectLayer1(artifactDir, skip) {
	const pkgPath = join(artifactDir, "package.json")
	if (!existsSync(pkgPath)) return { mode: "static", checks: {}, note: "no package.json — static artifact" }
	const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
	if (skip) return { mode: "npm", scripts: Object.keys(pkg.scripts ?? {}), checks: { skipped: true } }
	const checks = {}
	if (!existsSync(join(artifactDir, "node_modules"))) {
		checks.install = await run("npm", ["ci", "--no-audit", "--no-fund"], artifactDir, 600_000)
	}
	if (pkg.scripts?.build) checks.build = await run("npm", ["run", "build"], artifactDir, 480_000)
	if (pkg.scripts?.test) checks.test = await run("npm", ["test", "--if-present"], artifactDir, 480_000)
	return { mode: "npm", scripts: Object.keys(pkg.scripts ?? {}), checks }
}

const CONTENT_TYPES = {
	".html": "text/html",
	".js": "text/javascript",
	".mjs": "text/javascript",
	".css": "text/css",
	".json": "application/json",
	".png": "image/png",
	".jpg": "image/jpeg",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".woff": "font/woff",
}

function startStaticServer(root, port) {
	const server = createServer((req, res) => {
		const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0])
		const filePath = join(root, urlPath === "/" ? "index.html" : urlPath)
		if (!existsSync(filePath) || !filePath.startsWith(root)) {
			res.writeHead(404)
			res.end("not found")
			return
		}
		res.writeHead(200, { "content-type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream" })
		res.end(readFileSync(filePath))
	})
	return new Promise((resolvePromise) => {
		server.listen(port, () => resolvePromise({ server, url: `http://localhost:${port}` }))
	})
}

function startDevServer(artifactDir, pkg, port) {
	const script = pkg.scripts?.dev ? "dev" : "preview"
	const proc = spawn("npm", ["run", script, "--", "--port", String(port), "--strictPort"], {
		cwd: artifactDir,
		stdio: ["ignore", "pipe", "pipe"],
	})
	proc.stdout.on("data", () => {})
	proc.stderr.on("data", () => {})
	return { proc, url: `http://localhost:${port}`, script }
}

async function pollUntilReady(url, timeoutMs = 90_000) {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		try {
			const res = await fetch(url)
			if (res.ok) return
		} catch {
			// server not up yet — expected during boot; keep polling
		}
		if (Date.now() > deadline) throw new Error(`server at ${url} did not become ready within ${timeoutMs}ms`)
		await new Promise((r) => setTimeout(r, 250))
	}
}

function resolvePlaywright(args) {
	const candidates = []
	if (args.playwright) candidates.push(args.playwright)
	candidates.push(join(args.artifactDir, "package.json"), join(import.meta.dirname, "../../package.json"))
	for (const base of candidates) {
		try {
			const req = createRequire(base)
			return req("playwright")
		} catch {}
	}
	throw new Error("could not resolve playwright — pass --playwright <absolute path to its package dir>")
}

/** Default in-page probe: app-state JSON dumped from the host app itself. */
const DEFAULT_PROBE = `(() => {
	const counts = (sel) => document.querySelectorAll(sel).length
	let customGlobals = []
	try {
		const fresh = document.createElement("iframe")
		fresh.style.display = "none"
		document.body.appendChild(fresh)
		customGlobals = Object.getOwnPropertyNames(window).filter(
			(k) => !(k in fresh.contentWindow) && !/^webkit|chrome|on[a-z]+$/.test(k),
		)
		fresh.remove()
	} catch (e) {
		customGlobals = ["<iframe diff failed: " + String(e) + ">"]
	}
	const storeish = {}
	for (const k of customGlobals) {
		if (/store|state|zustand|redux|__APP|^OS$|^app/i.test(k)) {
			try {
				const v = window[k]
				storeish[k] = { type: typeof v, keys: v && typeof v === "object" ? Object.keys(v).slice(0, 40) : null }
			} catch { storeish[k] = { type: "unreadable" } }
		}
	}
	return {
		title: document.title,
		url: location.href,
		textLength: document.body?.innerText?.length ?? 0,
		bodyTextSample: (document.body?.innerText ?? "").slice(0, 1500),
		counts: {
			elements: counts("*"),
			svg: counts("svg"),
			img: counts("img"),
			buttons: counts('button,[role="button"]'),
			inputs: counts("input,textarea,select"),
			canvas: counts("canvas"),
			video: counts("video"),
			iframes: counts("iframe"),
			aria: counts("[role],[aria-label]"),
		},
		testIds: [...document.querySelectorAll("[data-testid]")].map((el) => el.getAttribute("data-testid")).slice(0, 200),
		customGlobals: customGlobals.slice(0, 250),
		storeish,
		consoleErrors: window.__harvestErrors ?? [],
		userAgent: navigator.userAgent,
	}
})()`

async function harvest(args) {
	if (!existsSync(args.artifactDir)) throw new Error(`artifact dir does not exist: ${args.artifactDir}`)
	mkdirSync(args.out, { recursive: true })

	// Preserve an existing layer-1 bundle when the caller asked to skip checks
	// (e.g. an interaction-probe re-run) instead of clobbering prior results.
	const layer1Path = join(args.out, "layer1.json")
	const reuseLayer1 = args.skipLayer1 && existsSync(layer1Path)
	const layer1 = reuseLayer1
		? JSON.parse(readFileSync(layer1Path, "utf8"))
		: await collectLayer1(args.artifactDir, args.skipLayer1)
	if (!reuseLayer1) writeFileSync(layer1Path, JSON.stringify(layer1, null, 2))

	// Boot the artifact on demand.
	let server = null
	let proc = null
	let url
	const pkgPath = join(args.artifactDir, "package.json")
	const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, "utf8")) : null
	if (!pkg || (!pkg.scripts?.dev && !pkg.scripts?.preview)) {
		const started = await startStaticServer(args.artifactDir, args.port)
		server = started.server
		url = started.url
	} else {
		const started = startDevServer(args.artifactDir, pkg, args.port)
		proc = started.proc
		url = started.url
	}
	await pollUntilReady(url)

	// (a) served HTML via on-demand GET — the medium users actually receive.
	const htmlRes = await fetch(url)
	const servedHtml = await htmlRes.text()
	writeFileSync(join(args.out, "served.html"), servedHtml)

	// (b) scripted app-state JSON probe executed on the host app.
	const playwright = resolvePlaywright(args)
	const browser = await playwright.chromium.launch()
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
	await page.addInitScript(() => {
		window.__harvestErrors = []
		window.addEventListener("error", (e) => {
			window.__harvestErrors.push(String(e.message ?? e))
		})
		console.error = new Proxy(console.error, {
			apply(target, thisArg, argv) {
				window.__harvestErrors.push(String(argv[0] ?? ""))
				return Reflect.apply(target, thisArg, argv)
			},
		})
	})
	await page.goto(url)
	await page.waitForTimeout(args.settle)
	const probe = { default: await page.evaluate(DEFAULT_PROBE) }
	if (args.probe) {
		const mod = await import(resolve(args.probe))
		probe.custom = await mod.default(page)
	}
	await browser.close()
	writeFileSync(join(args.out, "probe.json"), JSON.stringify(probe, null, 2))

	if (proc) proc.kill("SIGTERM")
	if (server) server.close()

	const manifest = {
		label: args.label,
		artifactDir: args.artifactDir,
		harvestedAt: new Date().toISOString(),
		url,
		servedHtmlBytes: servedHtml.length,
		node: process.version,
		layer1Ref: "layer1.json",
		probeRef: "probe.json",
		servedHtmlRef: "served.html",
	}
	writeFileSync(join(args.out, "manifest.json"), JSON.stringify(manifest, null, 2))

	const checkSummary = Object.entries(layer1.checks ?? {})
		.map(([k, v]) => `${k}:${v.ok === undefined ? "?" : v.ok ? "ok" : "FAIL"}`)
		.join(" ")
	console.log(
		`[${args.label}] layer1: ${checkSummary || layer1.note || "n/a"} | served ${servedHtml.length}B | probe: ${JSON.stringify(probe.default.counts)}`,
	)
	console.log(`bundle -> ${args.out}`)
}

harvest(parseArgs(process.argv)).catch((err) => {
	console.error(`harvest failed: ${err.message}`)
	process.exit(1)
})
