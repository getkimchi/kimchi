import type { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { Readable } from "node:stream"
import { describe, expect, it } from "vitest"
import {
	BASE_EXCLUDE_GLOBS,
	type CumulativeState,
	RsyncError,
	type RsyncStats,
	buildExcludeList,
	buildMkdirArgv,
	buildRsyncArgv,
	buildSshOption,
	formatRsyncFailure,
	handleLine,
	resolveGitIgnored,
	runRsync,
	trackCumulative,
} from "./rsync-runner.js"

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
			if (cur.length > 0) {
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
		expect(got).toContain("ProxyCommand='node /path with spaces/teleport-proxy.js %h %p'")
		expect(got).toContain("UserKnownHostsFile='/tmp/it'\\''s mine/known_hosts'")
	})

	it("survives rsync's -e word splitter as one ProxyCommand token", () => {
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
			localPath: "/home/dev/project/",
			remotePath: "/home/sandbox/",
			remoteHost: "session-host.example.com",
			remoteUser: "sandbox",
			proxyCommand: "node /opt/kimchi/teleport-proxy.js %h %p",
			knownHostsFile: "/tmp/k/known_hosts",
			listMode: { kind: "exclude-from", file: "/tmp/k/excludes" },
		})
		expect(argv).toEqual([
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
		])
	})

	it("includes --delete by default, omits it when deleteExtraneous is false", () => {
		const withDelete = buildRsyncArgv({
			localPath: "/a",
			remotePath: "/b",
			remoteHost: "h",
			remoteUser: "u",
			proxyCommand: "node /p %h %p",
			knownHostsFile: "/k",
			listMode: { kind: "exclude-from", file: "/e" },
		})
		expect(withDelete).toContain("--delete")
		const withoutDelete = buildRsyncArgv({
			localPath: "/a",
			remotePath: "/b",
			remoteHost: "h",
			remoteUser: "u",
			proxyCommand: "node /p %h %p",
			knownHostsFile: "/k",
			listMode: { kind: "exclude-from", file: "/e" },
			deleteExtraneous: false,
		})
		expect(withoutDelete).not.toContain("--delete")
	})

	it("passes local and remote paths verbatim — no trailing slash forcing", () => {
		const argv = buildRsyncArgv({
			localPath: "/file/no-slash",
			remotePath: "/file/also-no-slash",
			remoteHost: "h",
			remoteUser: "u",
			proxyCommand: "node /p %h %p",
			knownHostsFile: "/k",
			listMode: { kind: "exclude-from", file: "/e" },
		})
		// Caller decides directory-contents vs. directory-itself via trailing
		// slash; the builder must not mutate either path.
		expect(argv).toContain("/file/no-slash")
		expect(argv).toContain("u@h:/file/also-no-slash")
		expect(argv).not.toContain("/file/no-slash/")
		expect(argv).not.toContain("u@h:/file/also-no-slash/")
	})

	it("preserves trailing slashes that the caller supplied", () => {
		const argv = buildRsyncArgv({
			localPath: "/local/dir/",
			remotePath: "/remote/dir/",
			remoteHost: "h",
			remoteUser: "u",
			proxyCommand: "node /p %h %p",
			knownHostsFile: "/k",
			listMode: { kind: "exclude-from", file: "/e" },
		})
		expect(argv).toContain("/local/dir/")
		expect(argv).toContain("u@h:/remote/dir/")
	})

	it("swaps local/remote order when direction is 'down'", () => {
		const argv = buildRsyncArgv({
			localPath: "/local",
			remotePath: "/remote",
			remoteHost: "h",
			remoteUser: "u",
			proxyCommand: "node /p %h %p",
			knownHostsFile: "/k",
			listMode: { kind: "exclude-from", file: "/e" },
			direction: "down",
		})
		const remoteIdx = argv.indexOf("u@h:/remote")
		const localIdx = argv.indexOf("/local")
		expect(remoteIdx).toBeGreaterThan(-1)
		expect(localIdx).toBeGreaterThan(-1)
		expect(remoteIdx).toBeLessThan(localIdx)
	})

	it("appends --dry-run when dryRun is true", () => {
		const argv = buildRsyncArgv({
			localPath: "/a",
			remotePath: "/b",
			remoteHost: "h",
			remoteUser: "u",
			proxyCommand: "node /p %h %p",
			knownHostsFile: "/k",
			listMode: { kind: "exclude-from", file: "/e" },
			dryRun: true,
		})
		expect(argv).toContain("--dry-run")
	})

	it("uses --files-from when the caller passes that list mode", () => {
		const argv = buildRsyncArgv({
			localPath: "/a",
			remotePath: "/b",
			remoteHost: "h",
			remoteUser: "u",
			proxyCommand: "node /p %h %p",
			knownHostsFile: "/k",
			listMode: { kind: "files-from", file: "/tmp/files-from" },
		})
		// Crucial: --files-from replaces --exclude-from; never both.
		expect(argv).toContain("--files-from")
		expect(argv).toContain("/tmp/files-from")
		expect(argv).not.toContain("--exclude-from")
	})
})

describe("runRsync filesFrom guard", () => {
	// Run rsync end-to-end with a fake spawner so we can observe which list-mode
	// branch was taken. The two children spawned are (1) ssh mkdir and (2) the
	// rsync itself; we capture the rsync argv and assert on it.
	async function runWithFakeSpawn(filesFrom: string[] | undefined): Promise<string[]> {
		let rsyncArgs: string[] = []
		const fakeSpawn: typeof spawn = ((binary: string, args: readonly string[], _opts?: unknown) => {
			if (binary === "rsync") rsyncArgs = [...args]
			// rsync emits an empty stats block — enough for parsing to succeed.
			return makeFakeChild({ stdout: "", exitCode: 0 })
		}) as unknown as typeof spawn
		await runRsync({
			localPath: "/tmp/no-such-dir",
			remotePath: "/sandbox",
			isSourceDirectory: true,
			remoteHost: "h",
			remoteUser: "u",
			authToken: "tok",
			proxyCommand: "node /p %h %p",
			// Skip the gitignore subprocess — we don't care about its output here.
			gitignoredPaths: [],
			filesFrom,
			_spawn: fakeSpawn,
		})
		return rsyncArgs
	}

	it("uses --files-from when filesFrom has entries", async () => {
		const argv = await runWithFakeSpawn(["src/a.ts", "src/b.ts"])
		expect(argv).toContain("--files-from")
		expect(argv).not.toContain("--exclude-from")
	})

	it("falls back to --exclude-from when filesFrom is an empty array (regression)", async () => {
		// Empty array was previously truthy under `if (opts.filesFrom)`, so rsync
		// got an empty manifest and silently transferred nothing. The guard now
		// checks `?.length` so [] is treated like undefined.
		const argv = await runWithFakeSpawn([])
		expect(argv).toContain("--exclude-from")
		expect(argv).not.toContain("--files-from")
	})

	it("falls back to --exclude-from when filesFrom is undefined", async () => {
		const argv = await runWithFakeSpawn(undefined)
		expect(argv).toContain("--exclude-from")
		expect(argv).not.toContain("--files-from")
	})
})

describe("buildMkdirArgv", () => {
	it("builds an ssh argv that pre-creates a directory on the sandbox", () => {
		const argv = buildMkdirArgv({
			remoteHost: "h",
			remoteUser: "u",
			proxyCommand: "node /p %h %p",
			knownHostsFile: "/k",
			remoteDir: "/home/sandbox",
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
	setImmediate(() => {
		if (opts.errorAfter) child.emit("error", new Error("ENOENT"))
		child.emit("close", opts.exitCode)
	})
	return child
}

describe("resolveGitIgnored", () => {
	it("invokes git ls-files with --cached --others --ignored --exclude-standard and parses the stdout", async () => {
		let calledArgs: readonly string[] | undefined
		const fakeSpawn: typeof spawn = ((_cmd: string, args?: readonly string[], _opts?: unknown) => {
			calledArgs = args
			return makeFakeChild({
				stdout: "build/output.txt\nlogs/access.log\n",
				exitCode: 0,
			})
		}) as unknown as typeof spawn
		const result = await resolveGitIgnored("/dummy", undefined, fakeSpawn)
		expect(calledArgs).toEqual(["ls-files", "--cached", "--others", "--ignored", "--exclude-standard"])
		expect(result).toEqual(["build/output.txt", "logs/access.log"])
	})

	it("returns both untracked-ignored and tracked-ignored paths so tracked files matching gitignore don't leak past rsync excludes", async () => {
		const fakeSpawn: typeof spawn = ((_cmd: string, _args?: readonly string[], _opts?: unknown) =>
			makeFakeChild({
				// Mixed output: an untracked-ignored path and a tracked-ignored path.
				// Without --cached, the tracked one would be missing — and would
				// then sync to the sandbox in violation of .gitignore.
				stdout: "secrets/api.key\n.claude/settings.json\n",
				exitCode: 0,
			})) as unknown as typeof spawn
		const result = await resolveGitIgnored("/dummy", undefined, fakeSpawn)
		expect(result).toEqual(["secrets/api.key", ".claude/settings.json"])
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

describe("handleLine", () => {
	function fresh(): RsyncStats {
		return { fileCount: 0, totalBytes: 0 }
	}

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

	it("ignores unrecognised lines without mutating stats", () => {
		const s = fresh()
		handleLine("sending incremental file list", s)
		handleLine("", s)
		handleLine("file.txt", s)
		expect(s).toEqual({ fileCount: 0, totalBytes: 0 })
	})
})

describe("trackCumulative", () => {
	const fresh = (): CumulativeState => ({ completedBytes: 0, currentFileBytes: 0 })

	it("updates currentFileBytes on a progress line", () => {
		const s = fresh()
		expect(trackCumulative("      1,048,576  50%   1.00MB/s", s)).toBe(true)
		expect(s).toEqual({ completedBytes: 0, currentFileBytes: 1048576 })
	})

	it("rolls currentFileBytes into completedBytes when a new path line appears", () => {
		const s = fresh()
		trackCumulative("src/foo.ts", s) // header — no in-flight file yet, no-op
		expect(s).toEqual({ completedBytes: 0, currentFileBytes: 0 })

		trackCumulative("        65,536  50%   1.00MB/s", s)
		trackCumulative("       131,072 100%   2.00MB/s    0:00:00 (xfr#1, to-chk=10/12)", s)
		expect(s.currentFileBytes).toBe(131072)

		// Next file's path line: previous file's bytes graduate to completedBytes.
		expect(trackCumulative("src/bar.ts", s)).toBe(true)
		expect(s).toEqual({ completedBytes: 131072, currentFileBytes: 0 })
	})

	it("accumulates across multiple files", () => {
		const s = fresh()
		trackCumulative("a.txt", s)
		trackCumulative("       100  100%   1.00kB/s    0:00:00", s)
		trackCumulative("b.txt", s)
		expect(s.completedBytes).toBe(100)

		trackCumulative("       200  100%   1.00kB/s    0:00:00", s)
		trackCumulative("c.txt", s)
		expect(s.completedBytes).toBe(300)
	})

	it("ignores empty lines as boundaries", () => {
		const s = fresh()
		trackCumulative("       100  100%   1.00kB/s    0:00:00", s)
		expect(trackCumulative("", s)).toBe(false)
		expect(s).toEqual({ completedBytes: 0, currentFileBytes: 100 })
	})

	it("ignores boundaries while no file is in flight", () => {
		const s = fresh()
		expect(trackCumulative("sending incremental file list", s)).toBe(false)
		expect(s).toEqual({ completedBytes: 0, currentFileBytes: 0 })
	})

	it("does not double-count when multiple stats lines follow the last file", () => {
		const s = fresh()
		trackCumulative("last-file.txt", s)
		trackCumulative("       500  100%   1.00MB/s    0:00:00", s)
		// Trailing stats lines from rsync — first one rolls the file in, the
		// rest are no-ops because currentFileBytes is back to 0.
		trackCumulative("Number of files: 1", s)
		trackCumulative("Number of regular files transferred: 1", s)
		trackCumulative("Total transferred file size: 500 bytes", s)
		expect(s).toEqual({ completedBytes: 500, currentFileBytes: 0 })
	})
})

describe("formatRsyncFailure", () => {
	it("appends the trimmed stderr head for an RsyncError", () => {
		const err = new RsyncError(23, '\n  rsync: link_stat "x" failed: No such file or directory (2)\n')
		const msg = formatRsyncFailure(err)
		expect(msg).toBe('rsync exited with code 23\nstderr:\nrsync: link_stat "x" failed: No such file or directory (2)')
	})

	it("returns just the message when stderr is empty/whitespace", () => {
		expect(formatRsyncFailure(new RsyncError(23, "   \n  "))).toBe("rsync exited with code 23")
		expect(formatRsyncFailure(new RsyncError(23, ""))).toBe("rsync exited with code 23")
	})

	it("truncates the stderr head to 1500 chars", () => {
		const long = "e".repeat(5000)
		const msg = formatRsyncFailure(new RsyncError(23, long))
		expect(msg).toBe(`rsync exited with code 23\nstderr:\n${"e".repeat(1500)}`)
	})

	it("falls back to the message for a generic Error", () => {
		expect(formatRsyncFailure(new Error("boom"))).toBe("boom")
	})

	it("stringifies a non-Error value", () => {
		expect(formatRsyncFailure("nope")).toBe("nope")
	})
})
