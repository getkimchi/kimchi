import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim()

export function createPRWatchTargets(root: string, numbers = [7, 8], provider: "github" | "gitlab" = "github") {
	return numbers.map((number) => {
		const cwd = join(root, `pr-${number}`)
		mkdirSync(cwd)
		const branch = `feature-${number}`
		const bare = join(root, `origin-${number}.git`)
		git(cwd, "init", "--initial-branch", branch)
		git(cwd, "config", "user.name", "PR watch fixture")
		git(cwd, "config", "user.email", "fixture@example.invalid")
		git(cwd, "config", "commit.gpgSign", "false")
		git(cwd, "init", "--bare", "--initial-branch", branch, bare)
		git(
			cwd,
			"remote",
			"add",
			"origin",
			provider === "github"
				? "https://github.com/example/kimchi-lab.git"
				: "https://gitlab.fixture.test/group/subgroup/kimchi-lab.git",
		)
		git(cwd, "remote", "set-url", "--push", "origin", bare)
		writeFileSync(join(cwd, "answer.txt"), `broken ${number}\n`)
		git(cwd, "add", "answer.txt")
		git(cwd, "commit", "-m", `Seed ${number}`)
		git(cwd, "push", "origin", `HEAD:${branch}`)
		return {
			number,
			cwd,
			branch,
			bare,
			head: git(cwd, "rev-parse", "HEAD"),
			kind: "ci",
			url:
				provider === "github"
					? `https://github.com/example/kimchi-lab/pull/${number}`
					: `https://gitlab.fixture.test/group/subgroup/kimchi-lab/-/merge_requests/${number}`,
		}
	})
}
