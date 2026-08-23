#!/bin/sh
# Fetches third-party skills that can't be vendored into this repo (no license
# to redistribute). Run once per host: npm run fetch-skills
set -eu
cd "$(dirname "$0")/.."

mkdir -p bot-plugin/skills/unslop
curl -fsSL https://raw.githubusercontent.com/cursor/plugins/main/pstack/skills/unslop/SKILL.md \
  -o bot-plugin/skills/unslop/SKILL.md
echo "Fetched skill: unslop (from github.com/cursor/plugins)"
echo "Skills now in bot-plugin/skills/:"
ls bot-plugin/skills/
