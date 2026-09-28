"""Historical OAuth repair, using the existing isolated TMUX experiment runner."""

import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys

SCRIPTS = Path(__file__).resolve().parent
MODULES = ["src/extensions/mcp-adapter/mcp-auth-flow.ts",
           "src/modes/acp/ext-methods/mcp.ts",
           "src/extensions/mcp-adapter/server-manager.ts"]
TESTS = ["src/extensions/mcp-adapter/mcp-auth-flow.test.ts",
         "src/modes/acp/probe-mcp-server.test.ts",
         "src/extensions/mcp-adapter/server-manager.test.ts"]
TASK = """# Repair MCP OAuth connection behavior

Users report three related failures. Dynamic OAuth registration fails when the
preferred loopback callback port is occupied; configured client IDs must still
use their registered port. A non-interactive server refresh opens a browser;
`skipAuth: true` must try existing credentials and report needsAuth if they fail,
while omitted/false retains interactive behavior. HTTP servers with rotating
refresh tokens can consume the token during a preliminary connection and fail
on the real connection. Probe and persistent connections must connect once on
success, retain legacy SSE fallback for non-auth transport failures, and stop
without fallback on authorization errors. Preserve cleanup, deadlines,
pagination, bearer headers and stdio behavior.

Read the source and fix the causes. All source and installed dependencies are
available. Existing tests are public acceptance checks: do not modify them.
Add separate colocated *.test.ts files if useful. Do not change TASK.md,
package/config files, installed dependencies, or unrelated production files.
Production ownership for the worker arms:
- Lifecycle investigator: src/extensions/mcp-adapter/mcp-auth-flow.ts
- Boundary investigator: src/modes/acp/ext-methods/mcp.ts
- Implementation owner: src/extensions/mcp-adapter/server-manager.ts
Each may read everything and author separate tests and notes in its scope.
You are sharing a checkout: preserve other owners' edits. The parent can repair
these three modules after collecting all workers. Solo owns all three.

Run `pnpm run test:oauth-local`, `pnpm run typecheck`, and
`pnpm run check:oauth-style`. Report actual outcomes and remaining failures.
No dependency installation, external research, other trials, commits or
publication. Complete the repair without waiting for another user prompt.
"""

# These public checks exercise the same connection contract through both callers.
EXTRA_TESTS = '''
describe("HTTP connection reuse regression", () => {
 beforeEach(() => {
  mockConnect.mockReset()
  mockListTools.mockReset()
  mockClose.mockReset()
  mockSetNotificationHandler.mockReset()
  vi.mocked(supportsOAuth).mockReturnValue(true)
  mockClose.mockResolvedValue(undefined)
  mockListTools.mockResolvedValue({ tools: [], nextCursor: undefined })
 })
 afterEach(() => vi.clearAllMocks())
 for (const method of ["probeTools", "connect"] as const) {
  it(`${method} consumes a rotating token only once on success`, async () => {
   mockConnect.mockResolvedValueOnce(undefined).mockRejectedValue(new UnauthorizedError("token already consumed"))
   const manager = new McpServerManager()
   const result = await manager[method]("rotating", { url: "https://mcp.example.test", auth: "oauth" })
   expect(mockConnect).toHaveBeenCalledTimes(1)
   if ("needsAuth" in result) expect(result.needsAuth).toBe(false)
   else expect(result.status).toBe("connected")
   await manager.closeAll()
  })
  it(`${method} stops after authorization failure`, async () => {
   mockConnect.mockRejectedValue(new UnauthorizedError("login required"))
   const manager = new McpServerManager()
   const result = await manager[method]("unauthorized", { url: "https://mcp.example.test", auth: "oauth" })
   expect(mockConnect).toHaveBeenCalledTimes(1)
   if ("needsAuth" in result) expect(result.needsAuth).toBe(true)
   else expect(result.status).toBe("needs-auth")
   await manager.closeAll()
  })
 }
})
'''


def seed(repo, destination):
    for ref, names in [("dcc26382^", MODULES), ("dcc26382", TESTS)]:
        for name in names:
            (destination / name).write_bytes(subprocess.check_output(["git", "show", f"{ref}:{name}"], cwd=repo))
    manager_test = destination / TESTS[2]
    manager_test.write_text(manager_test.read_text() + EXTRA_TESTS)
    (destination / "TASK.md").write_text(TASK)
    package = json.loads((destination / "package.json").read_text())
    package["scripts"].pop("test:compaction-local", None)
    package["scripts"].pop("check:compaction-style", None)
    # Keep test configuration out of the model's credential HOME.
    package["scripts"]["test:oauth-local"] = 'mkdir -p .test-home && env -u KIMCHI_PERMISSIONS -u KIMCHI_NO_UPDATE_CHECK HOME="$PWD/.test-home" PI_CODING_AGENT_DIR="$PWD/.test-home/.config/kimchi/harness" KIMCHI_CODING_AGENT_DIR="$PWD/.test-home/.config/kimchi/harness" vitest run ' + " ".join(TESTS)
    package["scripts"]["check:oauth-style"] = "biome check " + " ".join(MODULES)
    (destination / "package.json").write_text(json.dumps(package, indent="\t") + "\n")


def prompt(arm, model="glm-5.3-flash"):
    common = "Read TASK.md and complete the OAuth repair. Use ordinary TODOs and record checks. "
    if arm == "solo":
        return common + "Investigate, implement, review and repair yourself without delegation."
    launches = []
    for role in ["Lifecycle investigator", "Boundary investigator", "Implementation owner"]:
        owner = role == "Implementation owner"
        args = dict(description=role, subagent_type="General-Purpose", model=model,
                    thinking="low", run_in_background=True, max_duration=900,
                    max_turns=70 if owner else 35, token_budget=20000 if owner else 10000,
                    ferment_v2=False)
        if arm == "board":
            args["communication"] = "group"
        launches.append(args)
    return common + """Launch exactly three workers together with the argument values below,
adding each worker's task as prompt. Give them TASK.md, exact ownership, permission
to read all source and use shared notes and available communication when useful.
There is no posting quota. Correct rejected launches: only an accepted agent ID
counts as started. Do not launch additional workers or explicitly resume them.
Collect all three results, review the combined changes, repair remaining defects
yourself, and run all three checks. You may steer and relay findings while workers
run. If no independent work remains, use get_subagent_result with wait:true or end
your turn for completion notices; do not sleep or poll with shell commands.
Exact Agent arguments: """ + json.dumps(launches)


def check(root, label, source):
    """Run frozen public checks without using a model's credential home."""
    directory = root / label
    env = json.loads((directory / "env.json").read_text())
    env["HOME"] = str(directory / "grade-home")
    Path(env["HOME"]).mkdir(exist_ok=True)
    result = {}
    for name in ["test:oauth-local", "typecheck", "check:oauth-style"]:
        command = [str(directory / "bin/pnpm"), "run", name]
        output = directory / f"{source.name}-{name.replace(':', '-')}.log"
        if name == "test:oauth-local":
            command += ["--reporter=json", f"--outputFile={directory / (source.name + '-tests.json')}"]
        with output.open("w") as log:
            result[name] = subprocess.run(["/usr/bin/sandbox-exec", "-f", str(directory / "sandbox.sb"), *command],
                                          cwd=source, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=120).returncode
    tests = json.loads((directory / (source.name + "-tests.json")).read_text())
    result.update(passed=tests["numPassedTests"], failed=tests["numFailedTests"], total=tests["numTotalTests"])
    return result


def preflight(root):
    directory = root / "trial-01"
    source = directory / "probe"
    result = {"broken": check(root, "trial-01", source)}
    fixed = directory / "reference"
    shutil.copytree(root / "seed", fixed, symlinks=True)
    for name in MODULES:
        (fixed / name).write_bytes(subprocess.check_output(["git", "show", f"dcc26382:{name}"], cwd=SCRIPTS.parents[1]))
    result["fixed"] = check(root, "trial-01", fixed)
    (root / "preflight.json").write_text(json.dumps(result, indent=2) + "\n")
    # The reference must not remain readable inside the trial's sandbox.
    shutil.move(str(fixed), str(root / "reference"))
    print(json.dumps(result), flush=True)
    assert (result["broken"]["passed"], result["broken"]["failed"], result["broken"]["total"]) == (47, 6, 53)
    assert (result["fixed"]["passed"], result["fixed"]["failed"], result["fixed"]["total"]) == (53, 0, 53)
    assert result["broken"]["test:oauth-local"] == 1 and result["fixed"]["test:oauth-local"] == 0
    assert all(row["typecheck"] == 0 and row["check:oauth-style"] == 0 for row in result.values())


def grade(root, labels):
    for label in labels:
        source = root / label / "grade-v2"
        shutil.copytree(root / f"{label}-final", source, symlinks=True)
        violations = []
        for path in (root / "seed").rglob("*"):
            relative = path.relative_to(root / "seed")
            if relative.parts[0] in {"node_modules", ".kimchi"} or not path.is_file() or str(relative) in MODULES:
                continue
            target = source / relative
            if not target.exists() or target.read_bytes() != path.read_bytes():
                violations.append(str(relative))
                # Keep out-of-scope production edits in the score, and report
                # the violation separately. Removing them can invent type errors.
                if str(relative) in TESTS or str(relative) in {"package.json", "vitest.config.ts", "tsconfig.json"}:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(path, target)
        shutil.copytree(root / "seed/node_modules", source / "node_modules", symlinks=True)
        for path in (root / f"{label}-final/src").rglob("*.ts"):
            relative = path.relative_to(root / f"{label}-final")
            if str(relative) not in TESTS:
                assert path.read_bytes() == (source / relative).read_bytes(), f"Grader changed source: {relative}"
        result = dict(protected_changes=violations, **check(root, label, source))
        (root / f"{label}-grade-v2.json").write_text(json.dumps(result, indent=2) + "\n")
        print(label, json.dumps(result), flush=True)


if __name__ == "__main__":
    if sys.argv[1] == "preflight":
        preflight(Path(sys.argv[2]))
        sys.exit(0)
    if sys.argv[1] == "grade":
        grade(Path(sys.argv[2]), sys.argv[3:])
        sys.exit(0)
    spec = importlib.util.spec_from_file_location("runner", SCRIPTS / "run-experiment.py")
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    runner.prompt = prompt
    runner.main()
