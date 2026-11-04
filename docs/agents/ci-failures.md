# Find why a CI job failed

Run these commands in a POSIX shell, such as Git Bash on Windows.

1. List the pull request's checks and copy the failing job's ID, the number after `/job/` in its URL.

   ```sh
   gh pr checks <pr-number>
   ```

2. Read the job's failure annotations. Vitest reports each failing test as one, with its file, line, and assertion message.

   ```sh
   gh api repos/Mzeey-Empire/mcode/check-runs/<job-id>/annotations \
     --jq '.[] | select(.annotation_level == "failure") | "\(.path):\(.start_line) \(.message)"'
   ```

3. If the annotations show only an exit code, read the end of the job log, where the test runner prints its failures and summary. `gh run view --log-failed` downloads the whole log and can stall on a large one, so request only the last 400 KB. The log URL is signed, so keep it in the variable and do not print it.

   ```sh
   url=$(curl -s -o /dev/null -w '%{redirect_url}' -H "Authorization: Bearer $(gh auth token)" \
     https://api.github.com/repos/Mzeey-Empire/mcode/actions/jobs/<job-id>/logs)
   size=$(curl -sI "$url" | awk 'tolower($1) == "content-length:" { print $2 }' | tr -d '\r')
   curl -s -r $((size - 400000))-$((size - 1)) "$url" | tail -200
   ```

4. To tell whether a failing test also fails on main, read the latest nightly test run on main. It runs only on nights when main has changed, so it can be up to a day behind.

   ```sh
   gh run list --workflow ci.yml --branch main --event workflow_dispatch --limit 1
   ```
