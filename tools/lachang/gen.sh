#!/usr/bin/env bash
# Generate the dachshund pack's art with Codex image_gen: edits run on the green base
# render, poses use the source drawing as the character reference.
#   tools/lachang/gen.sh [name ...]      (default: everything that is missing)
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
A=$ROOT/art/lachang
POSES="drag sit sleep beg lie"
names=("$@")
if [ ${#names[@]} -eq 0 ]; then
  for p in "$A"/prompts/*.txt; do
    n=$(basename "$p" .txt)
    [ -f "$A/gen/$n.png" ] || names+=("$n")
  done
fi
run() {
  n=$1
  ref=$A/gen/base_green.png
  case " $POSES " in *" $n "*) ref=$A/source/dachshund_ref.png ;; esac
  [ "$n" = base_green ] && ref=$A/source/dachshund_ref.png
  python3 "$ROOT/tools/codex_imagegen.py" "$A/gen/$n.png" "$A/prompts/$n.txt" -i "$ref" > "$A/work/logs/$n.log" 2>&1
  echo "$n: $(tail -1 "$A/work/logs/$n.log")"
}
export -f run; export A ROOT POSES
printf '%s\n' "${names[@]}" | xargs -P 5 -I{} bash -c 'run {}'
