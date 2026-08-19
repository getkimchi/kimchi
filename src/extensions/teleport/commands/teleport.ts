import { existsSync } from "node:fs"
import { open, readFile, stat } from "node:fs/promises"
import { platform } from "node:os"
import { basename, dirname } from "node:path"
import {
	readGitToken,
	readTeleportCompactHintEnabled,
	readTeleportHelpSeenAt,
	writeGitToken,
	writeTeleportHelpSeenAt,
} from "../../../config.js"
import { authenticateWorkspace } from "../../../sandbox/cloud/auth.js"
import { waitForWorkspaceReady } from "../../../sandbox/cloud/readiness.js"
import type { WorkspaceCredentials } from "../../../sandbox/cloud/types.js"
import { getGitRemoteHost, parseHostFromRemoteUrl, readLocalGitConfig } from "../../../sandbox/git-credentials.js"
import { WorkerClient } from "../../../sandbox/worker/client.js"
import { createSession, listSessions } from "../../../sandbox/worker/sessions.js"
import type { CreateSessionRequest, Session } from "../../../sandbox/worker/types.js"
import { createTabsOverlay } from "../overlay/overlay-component.js"
import { generateSessionName } from "../overlay/tab-manager.js"
import { evaluateCompactHint, TELEPORT_COMPACT_HINT_DEFAULTS } from "../preflight/compaction-hint.js"
import { getGitHeadSha, gitWorkingTreeDirty, isGitRepo } from "../preflight/git.js"
import { runPreflight } from "../preflight/index.js"
import { SIZE_REFUSE_BYTES, SIZE_WARN_BYTES } from "../preflight/workspace-size.js"
import { SANDBOX_USER } from "../provisioning/constants.js"
import { sumIncludeListBytes } from "../provisioning/estimate-bytes.js"
import { provisionGitCredential, provisionGitIdentity } from "../provisioning/git-provision.js"
import { buildHandoffNote, copySessionFileAndAddHandoffNote, removeTempDir } from "../provisioning/handoff-note.js"
import { provisionHarnessConfig } from "../provisioning/harness-config.js"
import { buildIncludeList } from "../provisioning/include-list.js"
import { deriveSandboxDest, deriveSandboxDestFromRepoUrl, repoBasename } from "../provisioning/paths.js"
import { formatRsyncFailure, runRsync } from "../provisioning/rsync-runner.js"
import { STATUS_KEY, type TeleportContext } from "../types.js"
import { formatBytes } from "../ui/format-bytes.js"
import { promptTeleportHelp } from "../ui/help-modal.js"
import { createTeleportProgress } from "../ui/progress.js"
import { parseTeleportArgs } from "./args.js"
import { refuse, warn } from "./errors.js"
import { resolveWorkspaceRef } from "./workspace-ref.js"

/** Per-call timeout for createSession: 5min — the 30s WorkerClient default aborts mid-flight on large repos. */
export const SESSION_CREATE_TIMEOUT_MS = 5 * 60_000

export async function runTeleport(rawArgs: string, ctx: TeleportContext): Promise<void> {
	if (hasHelpFlag(rawArgs)) {
		await promptTeleportHelp(ctx.ui)
		return
	}

	let args: ReturnType<typeof parseTeleportArgs>
	try {
		args = parseTeleportArgs(rawArgs)
	} catch (err) {
		refuse(ctx, err instanceof Error ? err.message : String(err))
	}

	if (!ctx.apiKey) {
		refuse(ctx, "No API key configured. Run `kimchi login`.")
	}

	if (readTeleportHelpSeenAt(ctx.configPath) === undefined) {
		// Mark seen before rendering so a crash or Ctrl+C during the modal doesn't re-show it next run.
		try {
			writeTeleportHelpSeenAt(new Date().toISOString(), ctx.configPath)
		} catch (err) {
			ctx.ui.notify(
				`Could not save teleport help state: ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			)
		}
		await promptTeleportHelp(ctx.ui)
	}

	runPreflight(ctx, args)
	await maybeRefuseTeleportForLongSession(ctx, args)

	// Show an inline status line message while we resolve the workspace — the
	// progress overlay can't open until we know which workspace to attach
	// to, and `listWorkspaces` over the network can take a few hundred ms.
	ctx.ui.setStatus(STATUS_KEY, "Teleport: resolving workspace…")
	let resolved: Awaited<ReturnType<typeof resolveWorkspaceRef>>
	try {
		resolved = await resolveWorkspaceRef(ctx, args.workspace, { onEmpty: { kind: "mint" } })
	} finally {
		ctx.ui.setStatus(STATUS_KEY, undefined)
	}
	const workspaceId = resolved.id
	const sessionName = args.name ?? generateSessionName()
	// For an existing workspace, preserve its stored name. For a newly minted
	// one (resolved.name === undefined) fall back to the cwd basename.
	const description = resolved.name ?? (basename(ctx.cwd) || "kimchi")

	// Local cancel: the progress overlay aborts this controller when the
	// user presses Esc/Ctrl+C. Combine with the harness's ctx.signal so
	// downstream awaits unwind for either source.
	const localAbort = new AbortController()
	const signal = ctx.signal ? AbortSignal.any([ctx.signal, localAbort.signal]) : localAbort.signal

	const progress = createTeleportProgress(ctx.ui, {
		onCancel: () => {
			if (localAbort.signal.aborted) return
			localAbort.abort()
		},
	})
	// Show "Cancelling…" regardless of abort source (Esc/Ctrl+C in the
	// panel, or a harness-level interrupt via ctx.signal).
	signal.addEventListener("abort", () => progress.setCancelling(), { once: true })

	// Kick off everything local at the top so it runs in parallel with the
	// network-bound auth + readiness wait below. The include list is built
	// from `git ls-files --cached --others --exclude-standard -z` plus
	// a walk of `.git/`. Passing it via `--files-from` to rsync avoids
	// the per-file pattern matching cost.
	const shouldRsyncWorkspace = !args.gitRepo && isGitRepo(ctx.cwd)
	const filesFromP: Promise<string[]> = shouldRsyncWorkspace
		? buildIncludeList(ctx.cwd, signal).catch(() => [])
		: Promise.resolve([])
	const sizeEstimateP: Promise<number> = shouldRsyncWorkspace
		? filesFromP.then((list) => sumIncludeListBytes(ctx.cwd, list, signal).catch(() => 0))
		: Promise.resolve(0)
	const localGitConfigP = readLocalGitConfig(ctx.cwd).catch(
		() => ({}) as Awaited<ReturnType<typeof readLocalGitConfig>>,
	)
	const gitHostP: Promise<string | undefined> = args.gitRepo
		? Promise.resolve(parseHostFromRemoteUrl(args.gitRepo))
		: getGitRemoteHost(ctx.cwd).catch(() => undefined)

	let creds: WorkspaceCredentials | undefined
	let initialSession: Session
	try {
		progress.step("Authenticating")
		try {
			creds = await authenticateWorkspace(workspaceId, ctx.apiKey, description, { endpoint: ctx.endpoint })
		} catch (err) {
			if (signal.aborted) throw err
			refuse(ctx, `Authentication failed: ${err instanceof Error ? err.message : String(err)}`)
		}
		progress.complete("Authenticated")

		progress.step("Preparing sandbox")
		try {
			await waitForWorkspaceReady({
				wsUrl: creds.wsUrl,
				connectToken: creds.connectToken,
				signal,
			})
		} catch (err) {
			if (signal.aborted) throw err
			refuse(ctx, `Sandbox never became ready: ${err instanceof Error ? err.message : String(err)}`)
		}
		progress.complete("Sandbox ready")

		// Size warn/refuse — uses the gitignored-aware local-walker estimate
		// (kicked off in the local block) rather than the raw `du` size, so
		// the user sees the actual upload bytes (after excludes), not the
		// disk footprint.
		const estimatedUploadBytes = shouldRsyncWorkspace ? await sizeEstimateP : 0
		if (shouldRsyncWorkspace) {
			if (estimatedUploadBytes > SIZE_REFUSE_BYTES && !args.force) {
				refuse(
					ctx,
					`Workspace upload is large (${formatBytes(estimatedUploadBytes)} after excludes). Re-run with --force to proceed.`,
				)
			}
			if (estimatedUploadBytes > SIZE_WARN_BYTES) {
				warn(ctx, `Workspace upload is ${formatBytes(estimatedUploadBytes)} — sync may take a while.`)
			}
		}

		// Resolve git token serially before the parallel fan-out — if it has
		// to prompt the user, the panel switches into git-token mode, which
		// would visually fight rsync's setStepDetail ticks if it ran during
		// the parallel block.
		const gitHost = await gitHostP
		const gitToken = await resolveGitToken(progress, gitHost, args, ctx)

		// Fan out: identity + credentials + rsync + listSessions all run in
		// parallel. They have no inter-dependencies. Tests assert each
		// happens before createSession but no longer a relative order
		// between identity and credentials (since they're concurrent now).
		progress.step("Provisioning workspace")
		const client = new WorkerClient(creds)
		const localGitConfig = await localGitConfigP
		const filesFrom = await filesFromP

		const identityP =
			localGitConfig.name || localGitConfig.email
				? provisionGitIdentity(client, { name: localGitConfig.name, email: localGitConfig.email }, signal).catch(
						(err) => {
							if (!signal.aborted) {
								warn(ctx, `Could not set git identity on sandbox: ${err instanceof Error ? err.message : String(err)}`)
							}
						},
					)
				: Promise.resolve()

		const credsPropP =
			gitHost && gitToken
				? provisionGitCredential(client, { gitHost, gitToken }, signal).catch((err) => {
						if (!signal.aborted) {
							warn(
								ctx,
								`Could not configure git credentials on sandbox: ${err instanceof Error ? err.message : String(err)}`,
							)
						}
					})
				: Promise.resolve()

		const rsyncP = shouldRsyncWorkspace
			? (async () => {
					try {
						await runRsync({
							localPath: ctx.cwd,
							remotePath: deriveSandboxDest(ctx.cwd),
							isSourceDirectory: true,
							remoteHost: creds.host,
							remoteUser: SANDBOX_USER,
							authToken: creds.connectToken,
							signal,
							deleteExtraneous: false,
							precomputeTotal: true,
							precomputedTotalBytes: estimatedUploadBytes,
							filesFrom,
							onPhase: (phase) => {
								// "estimate" no longer fires because precomputedTotalBytes is set.
								if (phase === "mkdir") progress.setStepDetail("preparing remote directory…")
								else if (phase === "rsync") progress.setStepDetail("starting transfer…")
							},
							onCumulativeProgress: ({ transferredBytes, totalBytes, pct }) => {
								progress.setStepDetail(`${formatBytes(transferredBytes)} / ${formatBytes(totalBytes)} (${pct}%)`)
							},
						})
					} catch (err) {
						if (signal.aborted) throw err
						// Surface a refusal-style error that the outer catch will
						// translate into the "Workspace sync failed" notify via refuse().
						// formatRsyncFailure folds in rsync's stderr (e.g. which file it
						// couldn't transfer) so a code-23 partial failure is diagnosable.
						throw new SyncFailure(formatRsyncFailure(err))
					}
				})()
			: Promise.resolve()

		const listP = listSessions(client, signal).catch((err) => {
			if (signal.aborted) throw err
			throw new ListFailure(err instanceof Error ? err.message : String(err))
		})

		// Harness config sync runs in parallel with the rest of the fan-out —
		// it's a tiny rsync of ~/.config/kimchi/harness/ and never blocks the
		// teleport. Failures warn but don't abort (config sync is a nicety, not
		// a requirement for the session to function).
		// Guard so a late configSyncP .then can't emit a spurious warn() after
		// the command already refused via the catch below (configSyncP races the
		// other fan-out promises; if Promise.all rejects first on another failure,
		// this .then may still fire afterward).
		let commandFailed = false
		const configSyncP = provisionHarnessConfig({
			remoteHost: creds.host,
			authToken: creds.connectToken,
			signal,
		}).then((result) => {
			if (!result.ok && !signal.aborted && !commandFailed) {
				warn(ctx, `Could not sync harness config to sandbox: ${result.error}`)
			}
		})

		let existing: Awaited<ReturnType<typeof listSessions>>
		try {
			;[, , , , existing] = await Promise.all([identityP, credsPropP, rsyncP, configSyncP, listP])
		} catch (err) {
			commandFailed = true
			if (signal.aborted) throw err
			if (err instanceof SyncFailure) refuse(ctx, `Workspace sync failed: ${err.message}`)
			if (err instanceof ListFailure) refuse(ctx, `Could not list sessions: ${err.message}`)
			throw err
		}
		progress.complete("Workspace provisioned")

		progress.step("Opening session")
		if (existing.some((s) => s.name === sessionName)) {
			refuse(
				ctx,
				`Session "${sessionName}" already exists in workspace ${workspaceId}. Use /remote-sessions to attach.`,
			)
		}
		const sessionCwd = args.gitRepo
			? deriveSandboxDestFromRepoUrl(args.gitRepo)
			: shouldRsyncWorkspace
				? deriveSandboxDest(ctx.cwd)
				: undefined
		// Upload an annotated copy of the local session file: append a handoff
		// note (visible in the remote transcript) explaining the environment
		// change, provisioning provenance, and any heuristics (rsync include
		// list / fresh clone) so the resumed agent doesn't trust stale paths
		// or artifacts. The user's local session file is never mutated.
		let sessionFileToUpload: string | undefined
		let sessionFileWithHandoffNote: string | undefined
		if (!args.skipSession && ctx.sessionFile && existsSync(ctx.sessionFile)) {
			// Git anchor for the note (HEAD sha + tree dirtiness): one-time
			// provenance facts about where the history was generated.
			const gitAnchor = isGitRepo(ctx.cwd)
				? { headSha: getGitHeadSha(ctx.cwd), dirty: gitWorkingTreeDirty(ctx.cwd) }
				: undefined
			const note = buildHandoffNote({
				fromPlatform: platform(),
				fromCwd: ctx.cwd,
				toCwd: sessionCwd,
				git: gitAnchor,
				workspace: args.gitRepo
					? { kind: "git-clone", repo: args.gitRepo, branch: args.branch }
					: shouldRsyncWorkspace
						? {
								kind: "rsync",
								fileCount: filesFrom.length,
								syncedDotKimchi: filesFrom.some((f) => f === ".kimchi" || f.startsWith(".kimchi/")),
							}
						: { kind: "none" },
				gitIdentityProvisioned: Boolean(localGitConfig.name || localGitConfig.email),
				gitCredential: gitHost && gitToken ? { host: gitHost } : undefined,
			})
			sessionFileWithHandoffNote = copySessionFileAndAddHandoffNote(ctx.sessionFile, note)
			sessionFileToUpload = sessionFileWithHandoffNote ?? ctx.sessionFile
		}
		const req: CreateSessionRequest = { agentMode: "PTY", cwd: sessionCwd }
		if (args.gitRepo) {
			req.details = {
				git: {
					repo: args.gitRepo,
					branch: args.branch,
					targetDirectory: repoBasename(args.gitRepo),
				},
			}
		}
		try {
			initialSession = await createSession(client, sessionName, req, {
				sessionFile: sessionFileToUpload,
				signal,
				timeoutMs: SESSION_CREATE_TIMEOUT_MS,
			})
		} catch (err) {
			if (signal.aborted) throw err
			refuse(ctx, `Could not create session: ${err instanceof Error ? err.message : String(err)}`)
		} finally {
			if (sessionFileWithHandoffNote) removeTempDir(dirname(sessionFileWithHandoffNote))
		}
		progress.complete("Session ready")

		progress.finish({
			id: workspaceId,
			url: `${creds.wsUrl}/session/${sessionName}/connect`,
			description,
		})
	} catch (err) {
		progress.stop()
		if (signal.aborted) {
			const wsHint = creds
				? ` Workspace ${workspaceId} is still up. Use /remote-sessions to remove or /teleport ${workspaceId} to resume.`
				: ""
			ctx.ui.notify(`Teleport cancelled.${wsHint}`, "info")
			return
		}
		throw err
	}

	await ctx.ui.custom<undefined>(
		createTabsOverlay({
			creds,
			workspaceId,
			workspaceName: description,
			apiKey: ctx.apiKey,
			cwd: ctx.cwd,
			endpoint: ctx.endpoint,
			ui: ctx.ui,
			initialSession,
		}),
		{ overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" } },
	)
}

function hasHelpFlag(raw: string): boolean {
	return raw
		.trim()
		.split(/\s+/)
		.some((t) => t === "--help")
}

/**
 * Resolve the user's git credential for the workspace's host. Uses a cached
 * token from `config.json` when one is present; otherwise opens an in-overlay
 * prompt and (optionally) saves the answer. Kept serial — the prompt has to
 * own the panel's foreground mode, which would conflict with rsync's
 * `setStepDetail` ticks running in parallel.
 */
async function resolveGitToken(
	progress: ReturnType<typeof createTeleportProgress>,
	gitHost: string | undefined,
	args: ReturnType<typeof parseTeleportArgs>,
	ctx: TeleportContext,
): Promise<string | undefined> {
	if (args.noGitToken || !gitHost) return undefined
	const cached = readGitToken(gitHost, ctx.configPath)
	if (cached) return cached
	const result = await progress.promptGitToken(gitHost)
	if (result.outcome !== "submitted") return undefined
	if (result.save) {
		try {
			writeGitToken(gitHost, result.token, ctx.configPath)
		} catch (err) {
			warn(ctx, `Could not save git token: ${err instanceof Error ? err.message : String(err)}`)
		}
	}
	return result.token
}

/**
 * v1 compaction-hint gate (companion to the --force/--allow-dirty preflight
 * refuses). When the session about to be uploaded is large AND was recently
 * active, the local prompt cache is likely still warm, so compacting locally
 * first is cheaper than letting the remote re-read the whole history cold —
 * refusing with an actionable message saves the difference. A stale session
 * inverts the economics (compaction would itself be a cold read), so
 * freshness gates the hint inside evaluateCompactHint.
 *
 * Sizing comes from the harness's live context usage (provider-backed). The
 * hint is non-critical, so anything that makes the number unavailable is a
 * silent skip: no live session stats (RPC mode, no model), tokens === null
 * right after compaction, or no session file. The session file is only read
 * once the session is known to be over the threshold — and only its tail:
 * the evaluator scans backward with early-exit, so a widening re-read to the
 * whole file only happens when the tail genuinely can't decide.
 */
async function maybeRefuseTeleportForLongSession(
	ctx: TeleportContext,
	args: ReturnType<typeof parseTeleportArgs>,
): Promise<void> {
	if (args.skipSession || args.noCompactHint) return
	const config = { ...TELEPORT_COMPACT_HINT_DEFAULTS, enabled: readTeleportCompactHintEnabled(ctx.configPath) }
	if (!config.enabled) return
	const tokens = ctx.getContextUsage?.()?.tokens
	if (tokens === undefined || tokens === null || tokens <= config.tokenThreshold) return
	const sessionFile = ctx.sessionFile
	if (!sessionFile || !existsSync(sessionFile)) return

	let tailInfo: SessionTail
	try {
		tailInfo = await readSessionTail(sessionFile)
	} catch {
		return
	}
	const { tail, tailIsWholeFile, fileMtimeMs } = tailInfo
	let evaluation = evaluateCompactHint({
		sessionTail: tail,
		tailIsWholeFile,
		estimatedTokens: tokens,
		now: Date.now(),
		config,
		fallbackTimestampMs: fileMtimeMs,
	})
	if (!evaluation.decided) {
		// Cap the widening re-read: the hint is a non-critical nudge, so loading
		// a pathologically large session file fully into memory just to decide
		// suppression is not worth it — skip the hint instead.
		if (tailInfo.fileSizeBytes > SESSION_WIDEN_MAX_BYTES) return
		// The tail slice ran out before either stop condition (e.g. fewer than
		// the lookback window of very large messages, compaction just beyond
		// the slice). Widen to the whole file and decide.
		try {
			evaluation = evaluateCompactHint({
				sessionTail: await readFile(sessionFile, "utf-8"),
				tailIsWholeFile: true,
				estimatedTokens: tokens,
				now: Date.now(),
				config,
				fallbackTimestampMs: fileMtimeMs,
			})
		} catch {
			return
		}
	}
	const { shouldHint, estimatedTokens } = evaluation
	if (!shouldHint) return
	refuse(
		ctx,
		`Long session history (~${formatTokenCount(estimatedTokens)} tokens) — consider /compact prior to teleport (or --no-compact-hint to skip).`,
	)
}

/**
 * Size of the tail slice read first. 512KB holds dozens of typical entries,
 * well beyond the lookback window; pathological single messages bigger than
 * this simply trigger the widen-to-whole-file path.
 */
export const SESSION_TAIL_BYTES = 512 * 1024

/**
 * Maximum file size for the widen-to-whole-file fallback. Real sessions over
 * the hint threshold are a few MB at most, so 6MB covers them with headroom;
 * anything beyond is too large to justify loading fully into memory for a
 * non-critical hint.
 */
export const SESSION_WIDEN_MAX_BYTES = 6 * 1024 * 1024

interface SessionTail {
	tail: string
	tailIsWholeFile: boolean
	fileMtimeMs: number
	fileSizeBytes: number
}

/** Read the last SESSION_TAIL_BYTES of the session file as UTF-8 (whole file when smaller). */
export async function readSessionTail(path: string): Promise<SessionTail> {
	const { size, mtimeMs } = await stat(path)
	if (size <= SESSION_TAIL_BYTES) {
		return {
			tail: await readFile(path, "utf-8"),
			tailIsWholeFile: true,
			fileMtimeMs: mtimeMs,
			fileSizeBytes: size,
		}
	}
	const handle = await open(path, "r")
	try {
		const buffer = Buffer.alloc(SESSION_TAIL_BYTES)
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, size - SESSION_TAIL_BYTES)
		return {
			tail: buffer.subarray(0, bytesRead).toString("utf-8"),
			tailIsWholeFile: false,
			fileMtimeMs: mtimeMs,
			fileSizeBytes: size,
		}
	} finally {
		await handle.close()
	}
}

function formatTokenCount(tokens: number): string {
	return tokens >= 1000 ? `${Math.round(tokens / 1000)}K` : String(tokens)
}

/**
 * Sentinel error: rsync inside the parallel fan-out failed for a non-abort
 * reason. Re-thrown so the outer catch can route it through `refuse()` with
 * the "Workspace sync failed" wording the user expects.
 */
class SyncFailure extends Error {}

/**
 * Sentinel error: listSessions inside the parallel fan-out failed for a
 * non-abort reason. Routed through `refuse()` as "Could not list sessions".
 */
class ListFailure extends Error {}
