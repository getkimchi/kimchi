# Run Kimchi on Terminal-Bench

This tutorial runs Kimchi against [Terminal-Bench](https://www.harborframework.com/) through Harbor. Start with one small task, inspect its score and session, then scale up when the setup works.

## Prerequisites

- Docker
- [`uv`](https://docs.astral.sh/uv/getting-started/installation/)
- `pnpm` when testing the current checkout
- A `KIMCHI_API_KEY`

## Choose your platform

### Linux x86_64

Use Linux x86_64 for benchmark runs you intend to compare or report. Kimchi and the Terminal-Bench task images run natively, so leave verification enabled and use the tutorial command as written.

### macOS on Apple Silicon

Use Apple Silicon for local integration checks, not comparable benchmark scores. Terminal-Bench task images are amd64, and Bun can crash when Docker runs the Kimchi binary through QEMU.

Configure Docker Desktop before running the tutorial:

1. Open **Settings → General**.
2. Select **Apple Virtualization Framework** as the Virtual Machine Manager.
3. Enable **Use Rosetta for x86_64/amd64 emulation on Apple Silicon**.
4. Apply the changes and restart Docker Desktop.

Then add `--disable-verification` to the Harbor command. This runs Kimchi and collects its artifacts without running the task verifier. If the log still contains `qemu: uncaught target signal`, Docker is not using Rosetta; fix the Docker configuration or move the run to Linux x86_64.

## Run one task from the current checkout

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm run build:binary-linux-x64

export KIMCHI_CODE_BINARY="$PWD/dist/bin/kimchi"
export KIMCHI_API_KEY=...

cd benchmark/terminal-bench-2
uv run --python 3.14 harbor run \
  --agent kimchi_agent:Kimchi \
  --env docker \
  --model kimchi-dev/kimi-k2.7 \
  --ae "KIMCHI_API_KEY=$KIMCHI_API_KEY" \
  -d terminal-bench/terminal-bench-2-1 \
  --jobs-dir jobs \
  -i terminal-bench/fix-git
```

The command creates the Python environment with `uv`, downloads the dataset and task image when needed, uploads your local Kimchi build into the task container, and runs the verifier. The first run takes longer because those artifacts are not cached yet.

On Apple Silicon, change the end of the command to:

```bash
  --jobs-dir jobs \
  -i terminal-bench/fix-git \
  --disable-verification
```

## Run the latest release

To run the latest published Kimchi release, unset the local binary and use the same Harbor command:

```bash
unset KIMCHI_CODE_BINARY
```

Kimchi is then downloaded for the task container. This path does not require `pnpm`, but the latest release can change. Use a recorded Git commit and local build when reproducing an older result exactly.

## Choose a Kimchi model

Replace the `--model` value with another `kimchi-dev/<model>`:

```bash
--model kimchi-dev/<model-id>
```

Set the model explicitly for reproducible runs. Check `kimchi --list-models` before an expensive benchmark because the available Kimchi models can change.

## Select tasks and attempts

Change or append these Harbor options to the command:

| Option | Meaning |
| --- | --- |
| `-i <pattern>` | Include matching tasks |
| `-x <pattern>` | Exclude matching tasks |
| `-l <count>` | Limit the number of tasks |
| `-k <count>` | Attempts per task |
| `-n <count>` | Concurrent trials |
| `--timeout-multiplier <value>` | Scale task timeouts |

For three attempts of the setup task, use `-i terminal-bench/fix-git -k 3`. Use `-l 5` for the first five tasks. For the full dataset, remove `-i` and `-l` and add `-n 8`.

A full run can take hours and make many model calls. Start with one task and one attempt before increasing either count.

## Find the results

The tutorial writes runs to `jobs/<timestamp>/`. Each trial directory contains:

- `result.json` with the reward and usage totals
- `trial.log` with Harbor's execution log
- `config.json` with the trial configuration
- `agent/sessions/*.jsonl` with Kimchi and subagent sessions

## Common failures

- `KIMCHI_API_KEY is required`: export it and pass it with `--ae` as shown.
- `Model ... not found`: choose a current model from `kimchi --list-models`.
- `Bun has crashed` with `qemu: uncaught target signal`: Docker is using QEMU on Apple Silicon. Switch Docker Desktop to Apple Virtualization Framework with Rosetta, or run on Linux x86_64. `--disable-verification` does not fix an agent crash.
- `harbor: command not found`: invoke it through `uv run --python 3.14`.

See [REFERENCE.md](REFERENCE.md) for alternate datasets and providers, Kimchi modes, workflow and scaffold comparisons, environment variables, platform details, and deeper troubleshooting.
