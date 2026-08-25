#!/bin/sh
set -eu

base="$HOME/Unicorn"
source_repository="$base/back"
releases="$base/releases"
branch="${DEPLOY_BRANCH:-main}"

exec 9>"$base/update.lock"
flock -n 9 || exit 0

git -C "$source_repository" fetch --quiet origin "$branch"
current_revision="$(git -C "$source_repository" rev-parse HEAD)"
remote_revision="$(git -C "$source_repository" rev-parse "origin/$branch")"

if [ "$current_revision" != "$remote_revision" ]; then
  if [ -n "$(git -C "$source_repository" status --porcelain)" ]; then
    echo "update skipped: source repository has local changes" >&2
    exit 0
  fi
  if ! git -C "$source_repository" merge-base --is-ancestor "$current_revision" "$remote_revision"; then
    echo "update skipped: origin/$branch is not a fast-forward" >&2
    exit 0
  fi
  git -C "$source_repository" merge --ff-only "origin/$branch"
fi

release="$releases/$remote_revision"
if [ ! -x "$release/node_modules/.bin" ] && [ ! -d "$release/node_modules" ]; then
  temporary="$releases/.${remote_revision}.partial"
  if [ -e "$temporary" ]; then
    echo "partial release already exists: $temporary" >&2
    exit 1
  fi
  mkdir -p "$temporary"
  trap 'rm -rf -- "$temporary"' EXIT HUP INT TERM
  git -C "$source_repository" archive "$remote_revision" | tar -x -C "$temporary"
  (cd "$temporary" && npm ci --omit=dev --no-audit --no-fund)
  mv "$temporary" "$release"
  trap - EXIT HUP INT TERM
fi

previous="$(readlink "$base/current" 2>/dev/null || true)"
ln -sfn "$release" "$base/current.next"
mv -Tf "$base/current.next" "$base/current"

if [ "$previous" != "$release" ]; then
  systemctl --user try-restart voice-partition.service
fi
