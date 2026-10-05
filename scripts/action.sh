#!/usr/bin/env bash
# Entrypoint for action.yml: works out the base ref, runs `oodle check`, keeps one
# sticky pull request comment up to date, and sets the step outputs. The job's
# pass/fail is decided by action.yml from the exit code written here.
set -uo pipefail

project="${INPUT_PROJECT:-.}"
# One output directory and one PR comment per project, so a workflow can check several.
slug="$(printf '%s' "$project" | tr -c 'A-Za-z0-9._-' '_')"
out="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/oodle/$slug"
mkdir -p "$out"
md="$out/outcome-diff.md"
json="$out/outcome-diff.json"
rm -f "$md" "$json"
marker="<!-- oodle:outcome-diff:$project -->"
zero_sha=0000000000000000000000000000000000000000

# Base ref: explicit input, else the pull request's base branch, else the commit before a push.
base="${INPUT_BASE_REF:-}"
if [ -z "$base" ]; then
  if [ -n "${PR_BASE_REF:-}" ]; then base="origin/$PR_BASE_REF"
  elif [ -n "${PUSH_BEFORE:-}" ] && [ "$PUSH_BEFORE" != "$zero_sha" ]; then base="$PUSH_BEFORE"
  fi
fi

# actions/checkout is shallow by default, so the base is usually missing. Fetch just that commit.
if [ -n "$base" ] && ! git rev-parse --verify --quiet "$base^{commit}" >/dev/null; then
  echo "::group::Fetching $base"
  if [[ "$base" == origin/* ]]; then
    git fetch --no-tags --depth=1 origin "+refs/heads/${base#origin/}:refs/remotes/$base"
  else
    git fetch --no-tags --depth=1 origin "$base"
  fi
  echo "::endgroup::"
fi

args=(check "$project" --json --md "$md")
[ -n "$base" ] && args+=(--base-ref "$base")
echo "oodle ${args[*]}"
node "$OODLE_BIN" "${args[@]}" >"$json"
code=$?

field() { node -e 'const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const v = process.argv[2].split(".").reduce((o, k) => (o == null ? o : o[k]), j); process.stdout.write(v == null ? "" : String(v));' "$json" "$1" 2>/dev/null; }

blocking="$(field blocking)"
{
  echo "exit-code=$code"
  echo "blocking=${blocking:-0}"
  echo "markdown-file=$md"
} >>"${GITHUB_OUTPUT:-/dev/null}"

if [ "$code" -ge 2 ]; then
  message="$(field error.message)"
  hint="$(field error.hint)"
  echo "::error title=Oodle could not run::${message:-see the log above}${hint:+ — $hint}"
  [ -n "${GITHUB_STEP_SUMMARY:-}" ] && printf '## Oodle could not run\n\n%s\n\n%s\n' "${message:-See the job log.}" "$hint" >>"$GITHUB_STEP_SUMMARY"
  exit 0
fi

echo "Oodle: ${blocking:-0} blocking (exit $code)"

if [ "${INPUT_COMMENT:-true}" = "true" ] && [ -n "${PR_NUMBER:-}" ] && [ -f "$md" ]; then
  body="$marker"$'\n'"$(cat "$md")"
  repo="$GITHUB_REPOSITORY"
  existing="$(gh api "repos/$repo/issues/$PR_NUMBER/comments" --paginate --jq ".[] | select(.body | startswith(\"$marker\")) | .id" 2>/dev/null | head -n1)"
  if [ -n "$existing" ]; then
    gh api -X PATCH "repos/$repo/issues/comments/$existing" -f body="$body" >/dev/null && echo "Updated the outcome diff comment on #$PR_NUMBER" && exit 0
  else
    gh api "repos/$repo/issues/$PR_NUMBER/comments" -f body="$body" >/dev/null && echo "Posted the outcome diff on #$PR_NUMBER" && exit 0
  fi
  echo "::warning title=Oodle::Could not comment on the pull request. Forked pull requests get a read-only token, and other workflows need 'permissions: pull-requests: write'. The outcome diff is in the job summary."
fi
exit 0
