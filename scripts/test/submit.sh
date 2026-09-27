#!/usr/bin/env bash
set -euo pipefail
PAGE_URL="$1"; COOKIE_JAR="$2"; shift 2

HTML=$(curl -sS -b "$COOKIE_JAR" -c "$COOKIE_JAR" "$PAGE_URL")

RAW=$(echo "$HTML" | grep -oP '\$ACTION_1:0" value="\K[^"]*' | head -1)
DECODED=$(echo "$RAW" | sed 's/&quot;/"/g')
ACTION_ID=$(echo "$DECODED" | grep -oP '"id":"\K[a-f0-9]*')
BOUND=$(echo "$DECODED" | grep -oP '"bound":"\K[^"]*')
ACTION_KEY=$(echo "$HTML" | grep -oP '\$ACTION_KEY" value="\K[^"]*')

if [ -z "$ACTION_ID" ]; then
  echo "ERROR: could not find action id" >&2
  exit 2
fi

FORM_ARGS=(-F "\$ACTION_REF_1=" -F "\$ACTION_1:0={\"id\":\"$ACTION_ID\",\"bound\":\"$BOUND\"}" -F "\$ACTION_1:1=[null]" -F "\$ACTION_KEY=$ACTION_KEY")

for kv in "$@"; do
  FORM_ARGS+=(-F "$kv")
done

curl -sS -i -b "$COOKIE_JAR" -c "$COOKIE_JAR" "${FORM_ARGS[@]}" "$PAGE_URL"
