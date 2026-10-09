# Pull request CI

[`ci.yml`](../../../.github/workflows/ci.yml) runs PR Title, Typecheck, Lint, Test, and Build Check on every pull request to `main`. This page records the decisions and traps behind that workflow. Read the workflow for the steps themselves.

## Runner choice

Linux checks run on paid Blacksmith runners or on free GitHub-hosted `ubuntu-24.04` runners. The `Pick Runner` job chooses one provider per pull request and publishes two labels: `small` for Typecheck, Lint, and Build Check, and `large` for Test.

The `CI_LINUX_RUNNER` repository variable selects the policy:

| Value | Behavior |
| --- | --- |
| `round-robin` (default when unset) | Even PR numbers use Blacksmith. Odd PR numbers use GitHub-hosted runners. |
| `blacksmith` | Every PR uses Blacksmith. |
| `github` | Every PR uses GitHub-hosted runners. |

Change it with `gh variable set CI_LINUX_RUNNER --body <value>`. Any other value fails `Pick Runner` on purpose.

The split is by PR number, not by run, so every push to one PR lands on the same provider. That keeps its caches warm and its timings comparable between pushes.

PR Title always runs on GitHub-hosted runners. It finishes in seconds, and Blacksmith bills a full minute.

## Required checks must fail, not skip

GitHub treats a skipped required check as passing. If `Pick Runner` failed and the dependent checks were skipped, a pull request could merge without running any of them.

Each dependent check therefore runs with `if: ${{ !cancelled() }}`, falls back to `ubuntu-24.04` when no label was published, and fails in its first step when `Pick Runner` did not succeed. Keep all three parts when adding a check that `needs: pick-runner`.

## Test runs package tasks one at a time

Test runs `bun run test --concurrency=1`. Each Vitest run sizes its worker pool to the machine's cores. When Turbo ran package test tasks in parallel, several pools competed for 4 vCPUs. Timing-sensitive tests, such as the pull-request performance budgets and `vi.waitFor` deadlines, then failed on GitHub-hosted runners ([#2020](https://github.com/Mzeey-Empire/mcode/issues/2020)).

Serial tasks cost about 20% more wall time. Uncached Test takes roughly 9 to 12.5 minutes on GitHub-hosted runners, measured in October 2026. Do not raise Turbo concurrency for Test, and do not loosen a timing budget to make a parallel run pass.

## Cached results prove nothing

Test, Typecheck, and Build Check restore Turbo outputs from the remote cache (`TURBO_TOKEN`) and from `.turbo/cache`. A green Test with `Cached: 10 cached, 10 total` replayed earlier results and ran no tests. When you need proof that the suite passes on a runner, for example after a CI change, run `bun run test --concurrency=1 --force` there.

## Electron sandbox on Ubuntu 24.04

Ubuntu 24.04 restricts unprivileged user namespaces, so Electron falls back to its SUID sandbox helper. On GitHub-hosted runners the helper is not root-owned, and the desktop smoke launch aborts. Build Check sets `chrome-sandbox` to `root:root` with mode `4755` before it launches the app.

## Known flake

Server tests sometimes fail with `Canonical writer open-failed: database is locked` on both providers. It is tracked in [#2022](https://github.com/Mzeey-Empire/mcode/issues/2022). Rerun the job, and add the run to that issue.
