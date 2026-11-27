import { describe, expect, it } from "vitest"
import { isDirectInstallCommand } from "./install-command.js"

describe("shell-aware direct install detection", () => {
	it.each([
		"npm install",
		"npm exec --package=cowsay -- cowsay",
		"pnpm exec --package=cowsay -- cowsay",
		"pnpm dlx cowsay",
		"npx cowsay",
		"yarn dlx cowsay",
		"bunx cowsay",
		"corepack pnpm install",
		"corepack pnpm dlx cowsay",
		"corepack prepare pnpm@10.0.0 --activate",
		"corepack use pnpm@10.0.0",
		"corepack install -g yarn@1.22.22",
		"corepack up yarn@1.22.22",
		"corepack enable --install-directory /tmp/review-corepack yarn",
		"corepack pack yarn@1.22.22",
		"corepack pnpm@10.0.0 -- --version",
		"corepack pnpm@10.0.0 exec --version",
		"npm exec --version",
		"npm x --version",
		"pnpm exec --version",
		"pnpm dlx --version",
		"yarn dlx --version",
		"bash -lc 'npm install'",
		"sh -ec 'npm install'",
		"zsh -c 'npm install'",
		"eval 'npm install'",
		"env FOO=bar npm install",
		"env -i FOO=bar npm install",
		"env -S 'FOO=bar npm install'",
		"command npm install",
		"nohup npm install",
		"time -p npm install",
		"xargs -n1 npm install",
		"xargs -I{} npm install {}",
		"FOO=bar command nohup time -p corepack pnpm install",
		"echo $(npm install)",
		"echo `npm install`",
		"(npm install)",
		"cd repo && bash -lc 'corepack pnpm install'",
		"npm ci",
		"python3 -m pip install package",
		"go install example.test/tool@latest",
		"cargo add package",
		"bundle install",
		"composer require package/package",
	])("requires approval for %s", (command) => {
		expect(isDirectInstallCommand(command)).toBe(true)
	})

	it.each([
		"npm test",
		"npm run x",
		"npm test -- x",
		"pnpm test -- --filter x",
		"pnpm eslint x",
		"pnpm run build",
		"yarn test",
		"yarn x",
		"go test ./...",
		"cargo test",
		"echo 'npm install'",
		"python -c 'print(\"go get\")'",
		"eval 'echo npm install'",
		"echo $(date)",
	])("does not classify %s as an install", (command) => {
		expect(isDirectInstallCommand(command)).toBe(false)
	})
})
