#!/bin/sh
set -eu

branch="${DEPLOY_BRANCH:-main}"
interval="${UPDATE_INTERVAL_SECONDS:-60}"

case "$interval" in
  *[!0-9]*|'') interval=60 ;;
esac
if [ "$interval" -lt 30 ]; then interval=30; fi

git config --global --add safe.directory /workspace

while true; do
  if git fetch --quiet origin "$branch"; then
    current_revision="$(git rev-parse HEAD)"
    remote_revision="$(git rev-parse "origin/$branch")"
    if [ "$current_revision" != "$remote_revision" ]; then
      if ! git diff --quiet || ! git diff --cached --quiet; then
        echo "update skipped: working tree has local changes" >&2
      elif git merge-base --is-ancestor "$current_revision" "$remote_revision"; then
        git merge --ff-only "origin/$branch"
        docker compose --project-directory /workspace --file /workspace/compose.yaml up --detach --build --remove-orphans
        docker image prune --force --filter dangling=true >/dev/null
      else
        echo "update skipped: origin/$branch is not a fast-forward" >&2
      fi
    fi
  else
    echo "update check failed; retrying in ${interval}s" >&2
  fi
  sleep "$interval"
done
