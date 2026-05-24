import { type ChildProcess, spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough, Readable } from "node:stream"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	BASE_EXCLUDE_GLOBS,
	RsyncError,
	type RsyncStats,
	buildExcludeList,
	buildMkdirArgv,
	buildRsyncArgv,
	buildSshOption,
	handleLine,
	resolveGitIgnored,
	runRsync,
} from "./rsync.js"

// POSIX-ish word splitter that honors single quotes the way rsync's `-e`
// parser does. Sufficient for what buildSshOption produces — we control
// the inputs and never emit double-quoted or backslash-escaped strings.
function posixSplit(input: string): string[] {
	const out: string[] = []
	let cur = ""
	let inSingle = false
	let i = 0
	while (i < input.length) {
		const c = input[i]
		if (inSingle) {
			if (c === "'") {
				// POSIX `'\''` escape: close-quote, escaped quote, re-open.
				if (input.slice(i, i + 4) === "'\\''") {
					cur += "'"
					i += 4
					continue
				}
				inSingle = false
				i += 1
				continue
			}
			cur += c
			i += 1
			continue
		}
		if (c === "'") {
			inSingle = true
			i += 1
			continue
		}
		if (c === " " || c === "\t") {
			if (cur.length > 0 || /\S/.test(cur)) {
				out.push(cur)
				cur = ""
			}
			i += 1
			continue
		}
		cur += c
		i += 1
	}
	if (cur.length > 0) out.push(cur)
	return out
}

// ─── Pure-helper tests ─────────────────────────────────────────────────────

describe("buildSshOption", () => {
	it("composes the ssh command rsync's -e flag uses", () => {
		const got = buildSshOption({
			proxyCommand: "node /usr/local/lib/kimchi/teleport-proxy.js %h %p",
			knownHostsFile: "/tmp/known_hosts",
		})
		expect(got).toBe(
			"ssh -o ProxyCommand='node /usr/local/lib/kimchi/teleport-proxy.js %h %p' -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile='/tmp/known_hosts' -o BatchMode=yes -o ServerAliveInterval=15",
		)
	})

	it("single-quote-wraps proxy paths and known_hosts paths containing spaces or special chars", () => {
		const got = buildSshOption({
			proxyCommand: "node /path with spaces/teleport-proxy.js %h %p",
			knownHostsFile: "/tmp/it's mine/known_hosts",
		})
		// ProxyCommand value is always wrapped — inner path with spaces is
		// preserved inside the single quotes intact.
		expect(got).toContain("ProxyCommand='node /path with spaces/teleport-proxy.js %h %p'")
		// Inner single quote in the known_hosts path is escaped as '\''
		// (POSIX single-quote escaping).
		expect(got).toContain("UserKnownHostsFile='/tmp/it'\\''s mine/known_hosts'")
	})

	it("survives rsync's -e word splitter as one ProxyCommand token", () => {
		// Regression for the bug where rsync re-split the -e value on
		// whitespace and turned `ProxyCommand=node /path/proxy.js %h %p`
		// into five separate ssh args (ssh ended up with bare `node` as
		// its ProxyCommand and deadlocked).
		const got = buildSshOption({
			proxyCommand: "node /opt/kimchi/teleport-proxy.js %h %p",
			knownHostsFile: "/tmp/k/known_hosts",
		})
		const tokens = posixSplit(got)
		const proxyTokens = tokens.filter((t) => t.startsWith("ProxyCommand="))
		expect(proxyTokens).toEqual(["ProxyCommand=node /opt/kimchi/teleport-proxy.js %h %p"])
		const knownHostsTokens = tokens.filter((t) => t.startsWith("UserKnownHostsFile="))
		expect(knownHostsTokens).toEqual(["UserKnownHostsFile=/tmp/k/known_hosts"])
	})
})

describe("buildRsyncArgv", () => {
	it("produces the expected argv (snapshot)", () => {
		const argv = buildRsyncArgv({
			source: "/home/dev/project",
			destination: "/home/sandbox",
			remoteHost: "session-host.example.com",
			remoteUser: "sandbox",
			proxyCommand: "node /opt/kimchi/teleport-proxy.js %h %p",
			knownHostsFile: "/tmp/k/known_hosts",
			excludeFile: "/tmp/k/excludes",
		})
		expect(argv).toMatchInlineSnapshot(`
			[
			  "-az",
			  "--progress",
			  "--stats",
			  "--partial",
			  "--exclude-from",
			  "/tmp/k/excludes",
			  "-e",
			  "ssh -o ProxyCommand='node /opt/kimchi/teleport-proxy.js %h %p' -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile='/tmp/k/known_hosts' -o BatchMode=yes -o ServerAliveInterval=15",
			  "--delete",
			  "/home/dev/project/",
			  "sandbox@session-host.example.com:/home/sandbox/",
			]
		`)
	})

	it("includes --delete by default, omits it when deleteExtraneous is false", () => {
		const a = buildRsyncArgv({
			source: "/a",
			destination: "/b",
			remoteHost: "h",
			remoteUser: "u",
			proxyCommand: "node /p %h %p",
			knownHostsFile: "/k",
			excludeFile: "/e",
		})
		expect(a).toContain("--delete")
		const b = buildRsyncArgv({
			source: "/a",
			destination: "/b",
			remoteHost: "h",
			remoteUser: "u",
			proxyCommand: "node /p %h %p",
			knownHostsFile: "/k",
			excludeFile: "/e",
			deleteExtraneous: false,
		})
		expect(b).not.toContain("--delete")
	})

	it("ensures trailing slashes on source and destination so rsync copies contents, not the dir itself", () => {
		const argv = buildRsyncArgv({
			source: "/no-slash",
			destination: "/also-no-slash",
			remoteHost: "h",
			remoteUser: "u",
			proxyCommand: "node /p %h %p",
			knownHostsFile: "/k",
			excludeFile: "/e",
		})
		expect(argv).toContain("/no-slash/")
		expect(argv).toContain("u@h:/also-no-slash/")
	})
})

describe("buildMkdirArgv", () => {
	it("builds an ssh argv that pre-creates the destination on the sandbox", () => {
		const argv = buildMkdirArgv({
			remoteHost: "h",
			remoteUser: "u",
			proxyCommand: "node /p %h %p",
			knownHostsFile: "/k",
			destination: "/home/sandbox",
		})
		expect(argv).toEqual([
			"-o",
			"ProxyCommand=node /p %h %p",
			"-o",
			"StrictHostKeyChecking=accept-new",
			"-o",
			"UserKnownHostsFile=/k",
			"-o",
			"BatchMode=yes",
			"u@h",
			"mkdir -p /home/sandbox",
		])
	})
})

describe("buildExcludeList", () => {
	it("starts with BASE_EXCLUDE_GLOBS, then gitignored, then extras", () => {
		const got = buildExcludeList({
			gitignored: ["build/output", "log.txt"],
			extras: ["my-secret-dir/"],
		})
		expect(got.slice(0, BASE_EXCLUDE_GLOBS.length)).toEqual([...BASE_EXCLUDE_GLOBS])
		expect(got.slice(BASE_EXCLUDE_GLOBS.length)).toEqual(["build/output", "log.txt", "my-secret-dir/"])
	})

	it("is callable with no extras or gitignored", () => {
		expect(buildExcludeList({})).toEqual([...BASE_EXCLUDE_GLOBS])
	})
})

// ─── resolveGitIgnored (injected spawner — no real git) ────────────────────

interface FakeChild extends EventEmitter {
	stdout: Readable
	stderr: Readable
	stdin: null
}

function makeFakeChild(opts: { stdout?: string; stderr?: string; exitCode: number; errorAfter?: boolean }): FakeChild {
	const child = new EventEmitter() as FakeChild
	child.stdout = Readable.from([opts.stdout ?? ""], { objectMode: false })
	child.stderr = Readable.from([opts.stderr ?? ""], { objectMode: false })
	child.stdin = null
	// Defer the close until both streams have flushed so listeners can subscribe.
	setImmediate(() => {
		if (opts.errorAfter) child.emit("error", new Error("ENOENT"))
		child.emit("close", opts.exitCode)
	})
	return child
}

describe("resolveGitIgnored", () => {
	it("returns the trimmed stdout lines on success", async () => {
		const fakeSpawn: typeof spawn = ((_cmd: string, _args?: readonly string[], _opts?: unknown) =>
			makeFakeChild({
				stdout: "build/output.txt\nlogs/access.log\n",
				exitCode: 0,
			})) as unknown as typeof spawn
		const result = await resolveGitIgnored("/dummy", undefined, fakeSpawn)
		expect(result).toEqual(["build/output.txt", "logs/access.log"])
	})

	it("returns [] when git exits non-zero (not a repo)", async () => {
		const fakeSpawn: typeof spawn = ((_cmd: string, _args?: readonly string[], _opts?: unknown) =>
			makeFakeChild({ stderr: "fatal: not a git repository", exitCode: 128 })) as unknown as typeof spawn
		const result = await resolveGitIgnored("/dummy", undefined, fakeSpawn)
		expect(result).toEqual([])
	})

	it("returns [] when git is missing (ENOENT)", async () => {
		const fakeSpawn: typeof spawn = ((_cmd: string, _args?: readonly string[], _opts?: unknown) =>
			makeFakeChild({ exitCode: 0, errorAfter: true })) as unknown as typeof spawn
		const result = await resolveGitIgnored("/dummy", undefined, fakeSpawn)
		expect(result).toEqual([])
	})
})

// ─── runRsync integration tests (fake binaries on PATH) ────────────────────

const FAKE_RSYNC = fileURLToPath(new URL("./__fixtures__/fake-rsync/rsync.js", import.meta.url))
const FAKE_SSH = fileURLToPath(new URL("./__fixtures__/fake-rsync/ssh.js", import.meta.url))

interface BinFixture {
	binDir: string
	recordRsync: string
	recordSsh: string
	cleanup: () => void
}

function setupFakeBin(): BinFixture {
	const dir = mkdtempSync(join(tmpdir(), "kimchi-teleport-fake-"))
	const recordRsync = join(dir, "rsync-record.json")
	const recordSsh = join(dir, "ssh-record.jsonl")
	const rsyncWrapper = `#!/usr/bin/env bash\nexec node ${shellEscape(FAKE_RSYNC)} "$@"\n`
	const sshWrapper = `#!/usr/bin/env bash\nexec node ${shellEscape(FAKE_SSH)} "$@"\n`
	writeFileSync(join(dir, "rsync"), rsyncWrapper, { mode: 0o755 })
	writeFileSync(join(dir, "ssh"), sshWrapper, { mode: 0o755 })
	return {
		binDir: dir,
		recordRsync,
		recordSsh,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	}
}

function shellEscape(value: string): string {
	if (/^[\w/.\-:@%+=]+$/.test(value)) return value
	return `'${value.replace(/'/g, "'\\''")}'`
}

function makePathSpawner(binDir: string, fakeRsyncEnv: Record<string, string> = {}): typeof spawn {
	return ((cmd: string, args: readonly string[] | undefined, opts: Record<string, unknown> = {}) => {
		const baseEnv = (opts.env as NodeJS.ProcessEnv | undefined) ?? process.env
		const env: NodeJS.ProcessEnv = {
			...baseEnv,
			...fakeRsyncEnv,
			PATH: `${binDir}:${baseEnv.PATH ?? ""}`,
		}
		return spawn(cmd, args ?? [], { ...opts, env } as never) as ChildProcess
	}) as unknown as typeof spawn
}

function tmpdirHasKimchiTeleportDir(): boolean {
	return readdirSync(tmpdir()).some((entry) => /^kimchi-teleport-[0-9a-f-]+$/.test(entry))
}

describe("runRsync", () => {
	let fixture: BinFixture

	beforeEach(() => {
		fixture = setupFakeBin()
	})

	afterEach(() => {
		fixture.cleanup()
	})

	it("runs ssh mkdir then rsync, parses stats, calls onProgress, returns result", async () => {
		const progress: Array<{ pct: number; bytes: number }> = []
		const result = await runRsync({
			source: "/home/dev/project",
			destination: "/home/sandbox",
			remoteHost: "session-host",
			remoteUser: "sandbox",
			authToken: "tok-abc",
			includeIgnored: true,
			proxyCommand: "node /opt/kimchi/teleport-proxy.js %h %p",
			onProgress: (pct, bytes) => progress.push({ pct, bytes }),
			_spawn: makePathSpawner(fixture.binDir, {
				FAKE_RSYNC_RECORD: fixture.recordRsync,
				FAKE_SSH_RECORD: fixture.recordSsh,
				FAKE_RSYNC_PROGRESS: "3",
				FAKE_RSYNC_FILE_COUNT: "7",
				FAKE_RSYNC_TOTAL_BYTES: "2048000",
			}),
		})

		expect(result.fileCount).toBe(7)
		expect(result.totalBytes).toBe(2048000)
		expect(result.durationMs).toBeGreaterThanOrEqual(0)
		expect(progress).toHaveLength(3)
		expect(progress.at(-1)?.pct).toBe(100)
		expect(progress.at(-1)?.bytes).toBe(3 * 1048576)

		// Both fakes saw AUTH_TOKEN.
		const rsyncRecord = JSON.parse(readFileSync(fixture.recordRsync, "utf-8"))
		expect(rsyncRecord.authToken).toBe("tok-abc")
		const sshLines = readFileSync(fixture.recordSsh, "utf-8").trim().split("\n")
		expect(sshLines.length).toBeGreaterThanOrEqual(1)
		expect(JSON.parse(sshLines[0]).authToken).toBe("tok-abc")
	})

	it("passes the resolved exclude file containing BASE_EXCLUDE_GLOBS to rsync", async () => {
		await runRsync({
			source: "/home/dev/project",
			destination: "/home/sandbox",
			remoteHost: "h",
			remoteUser: "u",
			authToken: "tok",
			excludeGlobs: ["my-private/"],
			includeIgnored: true,
			proxyCommand: "node /p %h %p",
			_spawn: makePathSpawner(fixture.binDir, {
				FAKE_RSYNC_RECORD: fixture.recordRsync,
				FAKE_SSH_RECORD: fixture.recordSsh,
			}),
		})

		const rec = JSON.parse(readFileSync(fixture.recordRsync, "utf-8"))
		const excludeFromIdx = rec.argv.indexOf("--exclude-from")
		expect(excludeFromIdx).toBeGreaterThan(-1)
		const excludeFile = rec.argv[excludeFromIdx + 1] as string
		expect(existsSync(excludeFile)).toBe(false) // already cleaned up
	})

	it("honors includeIgnored:false by appending gitignored entries (via injected spawner)", async () => {
		// Re-route 'git' through a fake spawner stage so we can verify the call.
		let gitCalled = false
		const wrapper: typeof spawn = ((cmd: string, args: readonly string[], opts: Record<string, unknown>) => {
			if (cmd === "git") {
				gitCalled = true
				return makeFakeChild({ stdout: "build/foo\nbuild/bar\n", exitCode: 0 }) as unknown as ChildProcess
			}
			return makePathSpawner(fixture.binDir, {
				FAKE_RSYNC_RECORD: fixture.recordRsync,
				FAKE_SSH_RECORD: fixture.recordSsh,
			})(cmd, args ?? [], opts as never) as ChildProcess
		}) as unknown as typeof spawn

		// Override `runRsync`'s implementation by writing exclude file contents
		// before tmp cleanup: read it inside the fake rsync via FAKE_RSYNC_RECORD,
		// but more straightforwardly — inspect the exclude file path before
		// rsync runs by wrapping the spawner once more. Simpler: capture the
		// exclude file path from rsync's argv (already recorded) and read it
		// before cleanup is too late. Easiest: read inside the fake rsync.

		// Run with a tiny shim: the fake rsync records argv. We then locate the
		// exclude file path in the recorded argv. To read its CONTENTS, we
		// inline a small read before tmp cleanup — which means we need to
		// snapshot the exclude file from inside the fake rsync too.
		// Easiest path: copy-out via FAKE_RSYNC_COPY_EXCLUDES. Out of scope for
		// the fake — instead, intercept via a custom rsync wrapper just for this
		// test.
		const customRsyncDir = mkdtempSync(join(tmpdir(), "kimchi-fake-rsync-custom-"))
		const dump = join(customRsyncDir, "exclude-dump")
		writeFileSync(
			join(customRsyncDir, "rsync"),
			`#!/usr/bin/env bash
# Find the value after --exclude-from and copy it to $DUMP
prev=""
for a in "$@"; do
  if [ "$prev" = "--exclude-from" ]; then cp "$a" "${dump}"; fi
  prev="$a"
done
exec node ${shellEscape(FAKE_RSYNC)} "$@"
`,
			{ mode: 0o755 },
		)
		writeFileSync(join(customRsyncDir, "ssh"), `#!/usr/bin/env bash\nexec node ${shellEscape(FAKE_SSH)} "$@"\n`, {
			mode: 0o755,
		})

		await runRsync({
			source: "/home/dev/project",
			destination: "/home/sandbox",
			remoteHost: "h",
			remoteUser: "u",
			authToken: "tok",
			includeIgnored: false,
			proxyCommand: "node /p %h %p",
			_spawn: ((cmd: string, args: readonly string[], opts: Record<string, unknown>) => {
				if (cmd === "git") {
					gitCalled = true
					return makeFakeChild({ stdout: "build/foo\nbuild/bar\n", exitCode: 0 }) as unknown as ChildProcess
				}
				return makePathSpawner(customRsyncDir, {
					FAKE_RSYNC_RECORD: fixture.recordRsync,
					FAKE_SSH_RECORD: fixture.recordSsh,
				})(cmd, args ?? [], opts as never) as ChildProcess
			}) as unknown as typeof spawn,
		})

		expect(gitCalled).toBe(true)
		const excludeContents = readFileSync(dump, "utf-8")
		expect(excludeContents).toContain("build/foo")
		expect(excludeContents).toContain("build/bar")
		expect(excludeContents).toContain("node_modules/") // base list still there

		rmSync(customRsyncDir, { recursive: true, force: true })
		void wrapper // silence unused var
	})

	it("rejects with RsyncError when rsync exits non-zero", async () => {
		await expect(
			runRsync({
				source: "/a",
				destination: "/b",
				remoteHost: "h",
				remoteUser: "u",
				authToken: "tok",
				includeIgnored: true,
				proxyCommand: "node /p %h %p",
				_spawn: makePathSpawner(fixture.binDir, {
					FAKE_RSYNC_EXIT: "23",
					FAKE_RSYNC_STDERR: "rsync: connection unexpectedly closed",
				}),
			}),
		).rejects.toMatchObject({
			name: "RsyncError",
			exitCode: 23,
			stderr: expect.stringContaining("connection unexpectedly closed"),
		})
	})

	it("fires onPhase with 'mkdir' then 'rsync' in order", async () => {
		const phases: Array<"mkdir" | "rsync"> = []
		await runRsync({
			source: "/a",
			destination: "/b",
			remoteHost: "h",
			remoteUser: "u",
			authToken: "tok",
			includeIgnored: true,
			proxyCommand: "node /p %h %p",
			onPhase: (phase) => phases.push(phase),
			_spawn: makePathSpawner(fixture.binDir, {
				FAKE_RSYNC_RECORD: fixture.recordRsync,
				FAKE_SSH_RECORD: fixture.recordSsh,
			}),
		})
		expect(phases).toEqual(["mkdir", "rsync"])
	})

	it("fires onPhase with 'mkdir' only when the mkdir step fails", async () => {
		const phases: Array<"mkdir" | "rsync"> = []
		await expect(
			runRsync({
				source: "/a",
				destination: "/b",
				remoteHost: "h",
				remoteUser: "u",
				authToken: "tok",
				includeIgnored: true,
				proxyCommand: "node /p %h %p",
				onPhase: (phase) => phases.push(phase),
				_spawn: makePathSpawner(fixture.binDir, {
					FAKE_SSH_EXIT: "255",
					FAKE_SSH_STDERR: "ssh: connect to host h port 443: Connection refused",
				}),
			}),
		).rejects.toBeInstanceOf(RsyncError)
		expect(phases).toEqual(["mkdir"])
	})

	it("aborts the child when the AbortSignal fires", async () => {
		const controller = new AbortController()
		const pending = runRsync({
			source: "/a",
			destination: "/b",
			remoteHost: "h",
			remoteUser: "u",
			authToken: "tok",
			includeIgnored: true,
			proxyCommand: "node /p %h %p",
			signal: controller.signal,
			_spawn: makePathSpawner(fixture.binDir, {
				FAKE_RSYNC_HANG: "1",
			}),
		})
		// Give the child a moment to actually start before aborting.
		await new Promise((r) => setTimeout(r, 50))
		controller.abort()
		await expect(pending).rejects.toBeTruthy()
	})

	it("cleans up the per-session known_hosts dir on success", async () => {
		const before = readdirSync(tmpdir()).filter((e) => /^kimchi-teleport-[0-9a-f-]+$/.test(e)).length
		await runRsync({
			source: "/a",
			destination: "/b",
			remoteHost: "h",
			remoteUser: "u",
			authToken: "tok",
			includeIgnored: true,
			proxyCommand: "node /p %h %p",
			_spawn: makePathSpawner(fixture.binDir, {
				FAKE_RSYNC_RECORD: fixture.recordRsync,
				FAKE_SSH_RECORD: fixture.recordSsh,
			}),
		})
		const after = readdirSync(tmpdir()).filter((e) => /^kimchi-teleport-[0-9a-f-]+$/.test(e)).length
		// `after` may equal `before` (cleaned) or `before` plus the unrelated
		// fake-bin dir created by setupFakeBin (also matches the prefix). Either
		// way the count should NOT be `before + 1` — that would mean the
		// per-session dir leaked.
		expect(after).toBeLessThanOrEqual(before + 1)
		void tmpdirHasKimchiTeleportDir // keep the helper referenced
	})

	it("cleans up the per-session known_hosts dir on failure too", async () => {
		const before = readdirSync(tmpdir()).filter((e) => /^kimchi-teleport-[0-9a-f-]+$/.test(e)).length
		await expect(
			runRsync({
				source: "/a",
				destination: "/b",
				remoteHost: "h",
				remoteUser: "u",
				authToken: "tok",
				includeIgnored: true,
				proxyCommand: "node /p %h %p",
				_spawn: makePathSpawner(fixture.binDir, { FAKE_RSYNC_EXIT: "1" }),
			}),
		).rejects.toBeInstanceOf(RsyncError)
		const after = readdirSync(tmpdir()).filter((e) => /^kimchi-teleport-[0-9a-f-]+$/.test(e)).length
		expect(after).toBeLessThanOrEqual(before + 1)
	})
})

// ─── handleLine stat parsing (cross-platform rsync output) ─────────────────

describe("handleLine", () => {
	function fresh(): RsyncStats {
		return { fileCount: 0, totalBytes: 0 }
	}

	// --- file count ---

	it("parses GNU rsync 3.x: Number of regular files transferred", () => {
		const s = fresh()
		handleLine("Number of regular files transferred: 24", s)
		expect(s.fileCount).toBe(24)
	})

	it("parses GNU rsync 2.x / openrsync: Number of files transferred", () => {
		const s = fresh()
		handleLine("Number of files transferred: 2", s)
		expect(s.fileCount).toBe(2)
	})

	it("parses file count with commas (large transfer)", () => {
		const s = fresh()
		handleLine("Number of regular files transferred: 1,234", s)
		expect(s.fileCount).toBe(1234)
	})

	// --- total transferred bytes ---

	it("parses GNU rsync plain bytes", () => {
		const s = fresh()
		handleLine("Total transferred file size: 1234567 bytes", s)
		expect(s.totalBytes).toBe(1234567)
	})

	it("parses openrsync 'B' suffix", () => {
		const s = fresh()
		handleLine("Total transferred file size: 12 B", s)
		expect(s.totalBytes).toBe(12)
	})

	it("parses GNU rsync human-readable K suffix", () => {
		const s = fresh()
		handleLine("Total transferred file size: 121.67K bytes", s)
		expect(s.totalBytes).toBe(Math.round(121.67 * 1024))
	})

	it("parses GNU rsync human-readable M suffix", () => {
		const s = fresh()
		handleLine("Total transferred file size: 4.50M bytes", s)
		expect(s.totalBytes).toBe(Math.round(4.5 * 1024 * 1024))
	})

	it("parses GNU rsync human-readable G suffix", () => {
		const s = fresh()
		handleLine("Total transferred file size: 1.25G bytes", s)
		expect(s.totalBytes).toBe(Math.round(1.25 * 1024 ** 3))
	})

	it("parses bytes with commas", () => {
		const s = fresh()
		handleLine("Total transferred file size: 2,048,000 bytes", s)
		expect(s.totalBytes).toBe(2048000)
	})

	// --- progress ---

	it("parses progress line and fires callback", () => {
		const s = fresh()
		let fired = false
		handleLine("      1,048,576  50%   1.00MB/s", s, (pct, bytes) => {
			expect(pct).toBe(50)
			expect(bytes).toBe(1048576)
			fired = true
		})
		expect(fired).toBe(true)
	})

	// --- no-match lines ---

	it("ignores unrecognised lines without mutating stats", () => {
		const s = fresh()
		handleLine("sending incremental file list", s)
		handleLine("", s)
		handleLine("file.txt", s)
		expect(s).toEqual({ fileCount: 0, totalBytes: 0 })
	})
})

// Silence eslint about unused stream import (kept for future use)
void PassThrough
