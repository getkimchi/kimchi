import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { promisify } from "node:util"

const run = promisify(execFile)

/** Reads the hardware UUID printed by `ioreg -rd1 -c IOPlatformExpertDevice`. */
export function macMachineId(output: string): string | undefined {
	const match = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(output)
	return match ? match[1] : undefined
}

/** Reads the value printed by `reg query HKLM\SOFTWARE\Microsoft\Cryptography /v MachineGuid`. */
export function windowsMachineId(output: string): string | undefined {
	const match = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(output)
	return match ? match[1] : undefined
}

async function machineId(): Promise<string | undefined> {
	try {
		if (process.platform === "darwin")
			return macMachineId(
				(await run("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { timeout: 2000 })).stdout,
			)
		if (process.platform === "win32")
			return windowsMachineId(
				(await run("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], { timeout: 2000 }))
					.stdout,
			)
		for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
			const id = (await readFile(path, "utf8").catch(() => "")).trim()
			if (id) return id
		}
	} catch {}
	return undefined
}

let fingerprint: Promise<string | undefined> | undefined

/** A salted hash of the operating system's machine ID; the raw ID is never stored or sent. */
export function machineFingerprint(): Promise<string | undefined> {
	fingerprint ??= machineId().then((id) =>
		id ? createHash("sha256").update(`kimchi-pr-cost-producer\0${id}`).digest("hex") : undefined,
	)
	return fingerprint
}
