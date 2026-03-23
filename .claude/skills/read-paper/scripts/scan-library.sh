#!/usr/bin/env bash
# scan-library.sh — Scan ZoFiles paper library and generate directory structure
# Usage: bash scan-library.sh <library_root>
# Output: a formatted directory tree with paper counts for each collection

set -eo pipefail

LIBRARY_ROOT="${1:?Usage: scan-library.sh <library_root>}"
LIBRARY_ROOT="${LIBRARY_ROOT%/}"

if [ ! -d "$LIBRARY_ROOT" ]; then
  echo "Error: Directory not found: $LIBRARY_ROOT" >&2
  exit 1
fi

is_paper_dir() {
  echo "$1" | grep -qE '^[0-9]{4}\.[0-9]+'
}

# Count paper folders directly in a directory
count_papers() {
  local count=0
  for sub in "$1"/*/; do
    [ -d "$sub" ] || continue
    local base
    base=$(basename "$sub")
    if is_paper_dir "$base"; then
      count=$((count + 1))
    fi
  done
  echo "$count"
}

# Print tree recursively
# Args: dir prefix is_last_child
print_node() {
  local dir="$1"
  local prefix="$2"
  local is_last="$3"

  local base
  base=$(basename "$dir")
  local papers
  papers=$(count_papers "$dir")

  # Connector
  local connector
  if [ "$is_last" = "true" ]; then
    connector="└── "
  else
    connector="├── "
  fi

  # Label
  local label
  if [ "$base" = "Allin" ]; then
    label="${base}/ (${papers} papers, flat view)"
  elif [ "$papers" -gt 0 ]; then
    label="${base}/ (${papers} papers)"
  else
    label="${base}/"
  fi

  echo "${prefix}${connector}${label}"

  # New prefix for children
  local new_prefix
  if [ "$is_last" = "true" ]; then
    new_prefix="${prefix}    "
  else
    new_prefix="${prefix}│   "
  fi

  # Collect children: non-paper, non-notes subdirs; Allin sorted last
  local regular_file
  regular_file=$(mktemp)
  local allin_file
  allin_file=$(mktemp)

  for sub in "$dir"/*/; do
    [ -d "$sub" ] || continue
    local child_base
    child_base=$(basename "$sub")
    is_paper_dir "$child_base" && continue
    [ "$child_base" = "notes" ] && continue
    if [ "$child_base" = "Allin" ]; then
      echo "$sub" >> "$allin_file"
    else
      echo "$sub" >> "$regular_file"
    fi
  done

  # Merge: regular (sorted) then Allin
  local all_children_file
  all_children_file=$(mktemp)
  sort "$regular_file" >> "$all_children_file"
  cat "$allin_file" >> "$all_children_file"

  local total
  total=$(wc -l < "$all_children_file" | tr -d ' ')

  local idx=0
  while IFS= read -r child; do
    [ -z "$child" ] && continue
    child="${child%/}"
    idx=$((idx + 1))
    local child_is_last="false"
    if [ "$idx" -eq "$total" ]; then
      child_is_last="true"
    fi
    print_node "$child" "$new_prefix" "$child_is_last"
  done < "$all_children_file"

  rm -f "$regular_file" "$allin_file" "$all_children_file"
}

# --- Main ---
root_base=$(basename "$LIBRARY_ROOT")
echo "${root_base}/"

# Build top-level children list
regular_file=$(mktemp)
allin_file=$(mktemp)

for sub in "$LIBRARY_ROOT"/*/; do
  [ -d "$sub" ] || continue
  base=$(basename "$sub")
  is_paper_dir "$base" && continue
  [ "$base" = "notes" ] && continue
  if [ "$base" = "Allin" ]; then
    echo "$sub" >> "$allin_file"
  else
    echo "$sub" >> "$regular_file"
  fi
done

all_file=$(mktemp)
sort "$regular_file" >> "$all_file"
cat "$allin_file" >> "$all_file"

total=$(wc -l < "$all_file" | tr -d ' ')
idx=0

while IFS= read -r child; do
  [ -z "$child" ] && continue
  child="${child%/}"
  idx=$((idx + 1))
  is_last="false"
  if [ "$idx" -eq "$total" ]; then
    is_last="true"
  fi
  print_node "$child" "" "$is_last"
done < "$all_file"

rm -f "$regular_file" "$allin_file" "$all_file"
