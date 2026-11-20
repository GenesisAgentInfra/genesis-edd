# Genesis EDD verifier helper. Do not edit: `eval validate` compares this file
# with the shipped copy. Source it from tests/test.sh, then call:
#   gate ID RESULT EVIDENCE   a gating check; RESULT is pass, fail or unknown
#   note ID RESULT EVIDENCE   a diagnostic check; it never changes the reward
#   finish                    write check-results.json and reward.json, exit 0
# unknown means the evidence could not be read. It is never a pass, and the
# run records it as missing evidence instead of a business failure.
GENESIS_OUT="${GENESIS_OUT:-/logs/verifier}"
mkdir -p "$GENESIS_OUT"
GENESIS_ROWS="$GENESIS_OUT/.genesis-rows"
: > "$GENESIS_ROWS"

_genesis_text() {
  printf '%s' "$1" | tr '\n\r\t' '   ' | tr -d '\000-\010\013\014\016-\037' | sed 's/\\/\\\\/g; s/"/\\"/g'
}

_genesis_row() {
  case "$3" in
    pass|fail|unknown) printf '%s\t%s\t%s\t%s\n' "$1" "$(_genesis_text "$2")" "$3" "$(_genesis_text "$4")" >> "$GENESIS_ROWS" ;;
    *) printf '%s\t%s\tunknown\t%s\n' "$1" "$(_genesis_text "$2")" "$(_genesis_text "invalid result '$3': $4")" >> "$GENESIS_ROWS" ;;
  esac
}

gate() { _genesis_row gating "$1" "$2" "${3:-}"; }
note() { _genesis_row diagnostic "$1" "$2" "${3:-}"; }

finish() {
  awk -F '\t' -v reward="$GENESIS_OUT/reward.json" '
    BEGIN { printf "{\n  \"results\": [" }
    { printf "%s\n    { \"id\": \"%s\", \"result\": \"%s\", \"evidence\": \"%s\" }", (NR > 1 ? "," : ""), $2, $3, $4
      if ($1 == "gating") { gating++; if ($3 == "pass") passed++ } }
    END { printf "\n  ]\n}\n"; printf "{ \"reward\": %d }\n", (gating > 0 && gating == passed ? 1 : 0) > reward }
  ' "$GENESIS_ROWS" > "$GENESIS_OUT/check-results.json"
  rm -f "$GENESIS_ROWS"
  exit 0
}
