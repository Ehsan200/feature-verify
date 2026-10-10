#!/usr/bin/env bash
# Install feature-verify as a plain skill for Claude Code and/or Codex (no plugin system needed).
#   ./install.sh            copy into ~/.claude/skills and ~/.codex/skills (whichever exist)
#   ./install.sh --link     symlink instead of copy (for developing this repo)
#   ./install.sh --uninstall
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/skills/feature-verify"
MODE=copy
case "${1:-}" in --link) MODE=link ;; --uninstall) MODE=uninstall ;; "") ;; *) echo "unknown option: $1" >&2; exit 2 ;; esac

targets=()
[ -d "$HOME/.claude" ] && targets+=("$HOME/.claude/skills")
[ -d "${CODEX_HOME:-$HOME/.codex}" ] && targets+=("${CODEX_HOME:-$HOME/.codex}/skills")
[ ${#targets[@]} -eq 0 ] && { echo "Neither ~/.claude nor ~/.codex found." >&2; exit 1; }

for dir in "${targets[@]}"; do
  dest="$dir/feature-verify"
  if [ "$MODE" = uninstall ]; then
    rm -rf "$dest" && echo "removed $dest"; continue
  fi
  mkdir -p "$dir"
  if [ -e "$dest" ] || [ -L "$dest" ]; then rm -rf "$dest"; fi
  if [ "$MODE" = link ]; then ln -s "$SRC" "$dest"; else cp -R "$SRC" "$dest"; fi
  echo "$MODE: $dest"
done
command -v node >/dev/null || echo "warning: node (>=18) not found on PATH — the skill's scripts need it." >&2
