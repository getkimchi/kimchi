// Helpers for real LSP server processes. Chain-spawn e2e tests need a real
// language server; each is cheap, present on the dev machines/CI when
// installed, and each chain is a distinct OS process, which makes
// before/after process counts a crisp assertion.

import { spawnSync } from "node:child_process"

export const goplsOnPath = spawnSync("which", ["gopls"], { stdio: "pipe" }).status === 0

/** True when the classic typescript-language-server binary is on PATH —
 *  gates the lazy-activation ACP e2e that invokes the live server (needs a
 *  real binary to spawn; CI runners may not have it). */
export const typescriptLanguageServerOnPath =
	spawnSync("which", ["typescript-language-server"], { stdio: "pipe" }).status === 0

export function goplsProcessCount(): number {
	// pgrep -fl enumerates pid + full argv; ps -axo can be blocked by
	// environments that deny mach-lookup task ports, pgrep's sysctl path
	// survives those.
	//
	// Match only the per-chain forwarder process (`gopls -remote=auto`). The
	// shared engine daemon (`gopls serve -listen unix;...` with
	// -listen.timeout 1m) outlives all chains by design, so counting plain
	// "gopls" waits forever on a value that never reaches the baseline.
	const out = spawnSync("pgrep", ["-fl", "gopls -remote=auto"], { stdio: "pipe" })
	return (out.stdout?.toString() ?? "").split("\n").filter((l) => l.includes("gopls")).length
}
