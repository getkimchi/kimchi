import { parse } from "shell-quote"
import { afterEach, expect, it, vi } from "vitest"
import { getAgentInvocation } from "../../../utils/spawn-kimchi-subprocess.js"
import { buildProxyCommand } from "./proxy-command.js"

vi.mock("../../../utils/spawn-kimchi-subprocess.js", () => ({ getAgentInvocation: vi.fn() }))

afterEach(() => vi.unstubAllEnvs())

it("routes development SSH through Kimchi without embedding credentials in the saved ProxyCommand", () => {
	vi.stubEnv("KIMCHI_API_KEY", "private-environment-key")
	vi.mocked(getAgentInvocation).mockReturnValue({
		command: "/path with spaces/bun",
		args: ["/project's dir/src/entry.ts", "--ssh-proxy", "%h"],
	})
	const command = buildProxyCommand()
	expect(getAgentInvocation).toHaveBeenCalledWith(["--ssh-proxy", "%h"])
	expect(parse(command)).toEqual(["/path with spaces/bun", "/project's dir/src/entry.ts", "--ssh-proxy", "%h"])
	expect(command).not.toContain("KIMCHI_API_KEY")
	expect(command).not.toContain("private-environment-key")
})
