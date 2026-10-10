#!/usr/bin/env bash
# Checks payloads.json with PS5 Payload Manager's own code (latest main branch):
# adding the source, parsing every field, the web UI list and the install checks,
# including SHA-256 verification of each downloaded payload.
# Usage: tools/pldmgr-verify/verify.sh [payloads.json]
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
json=$(realpath "${1:-payloads.json}")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
pm="$work/pldmgr"

git clone -q --depth 1 https://github.com/itsPLK/ps5-payload-manager.git "$pm"
echo "Payload Manager $(git -C "$pm" log -1 --format='%h (%cs) %s')"

# Extract the code paths Payload Manager runs on a source
cd "$work"
sed -n '/^int parse_repository_payloads/,/^}/p' "$pm/src/repository.c" > parse.inc
sed -n '/^static int is_supported_extension/,/^}/p' "$pm/src/payload_mgr.c" > ext.inc
sed -n '/^static int is_safe_filename/,/^}/p' "$pm/src/http_server.c" > safe.inc
sed -n '/Read top-level "name" field/,/^    }$/p' "$pm/src/sources.c" > namescan.inc
sed -n '/for (size_t pi = 0; pi < count; pi++) {/,/^            }$/p' "$pm/src/sources.c" > listitem.inc
for f in parse.inc ext.inc safe.inc namescan.inc listitem.inc; do
  [ -s "$f" ] || { echo "could not find the code for $f in Payload Manager's sources; it may have changed"; exit 1; }
done

gcc -w -I"$pm/include" -I"$work" "$here/check.c" \
  "$pm/src/json_helpers.c" "$pm/src/utils.c" "$pm/src/sha256.c" -o check

mkdir files
# shellcheck disable=SC2016 # ${...} is a JavaScript template literal
node -e 'for (const p of JSON.parse(require("fs").readFileSync(process.argv[1])).payloads) console.log(`${p.filename}\t${p.url}`)' "$json" |
  while IFS=$'\t' read -r name url; do
    curl -sfL --retry 2 -A pldmgr/1.0 -o "files/$name" "$url" || echo "download failed: $url"
  done

status=0
./check "$json" || status=1
node "$here/compare.mjs" "$json" "$work" || status=1
[ "$status" -eq 0 ] && echo "Payload Manager can process $(basename "$json")"
exit "$status"
