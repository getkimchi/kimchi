# `/work --summary` — local work summary

`/work --summary` is a read-only view of the work-attribution demo. It shows what the current work has recorded, based only on data already saved on disk.

## What it shows

| Line | Meaning |
| --- | --- |
| `Work summary — <workId>` | The current work ID (same one plain `/work` reports). |
| `File: <path>` | Where the summary is saved: `~/.config/kimchi/harness/work/<workId>/work.json`. |
| `Sessions` | How many sessions contributed to this work. |
| `Requests` | How many model request attempts were recorded (see note below). |
| `Plan versions` | How many saved plan versions belong to this work. |
| `Commits: N unique` | How many distinct commit hashes were recorded; the same hash from several sessions counts once. |
| `Models` | The configured model names seen in those requests, in first-seen order, or `none`. |

### Example

```
Work summary — 3f9b6c1e-8a2d-4c7e-b1f0-5d6e7a8b9c0d
File: /home/you/.config/kimchi/harness/work/3f9b6c1e-8a2d-4c7e-b1f0-5d6e7a8b9c0d/work.json
Sessions: 2
Requests: 3
Plan versions: 2
Commits: 2 unique
Models: model-a, model-b
```

## What it does not do

- **No model request.** The command only reads the saved summary file (after draining any pending local writes). It never calls a provider.
- **No work ID change.** It resolves and reports the current work ID exactly like plain `/work`; it never starts new work or switches identity. `/work new` and `/work <plan-path>` behave as before.
- **Request counts are not prices.** The `Requests` number is a count of recorded request attempts — one row per attempt. It says nothing about cost or billing.

## Missing or corrupt summary

If `work.json` is missing, unreadable, or has the wrong shape, the command shows an empty state instead of failing:

```
No work summary yet for 3f9b6c1e-8a2d-4c7e-b1f0-5d6e7a8b9c0d
It will appear at /home/you/.config/kimchi/harness/work/3f9b6c1e-8a2d-4c7e-b1f0-5d6e7a8b9c0d/work.json once this work records requests, plans, or commits.
```

A fresh session's first run shows a real (all-zero) summary — `Sessions: 1`, everything else `0` — because binding the session already publishes its initial work record.

This is a small disposable demo feature; the summary lives entirely under the per-user directory above and is safe to delete.
