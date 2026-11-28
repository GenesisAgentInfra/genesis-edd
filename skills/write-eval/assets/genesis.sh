# Genesis EDD verifier helper. Do not edit: `eval validate` compares this file
# with the shipped copy, and `eval sync` writes the shipped copy back. Source
# it from tests/test.sh, or from a step's tests/test.sh, then call:
#   gate ID RESULT EVIDENCE         a gating check; RESULT is pass, fail or unknown
#   note ID RESULT EVIDENCE         a diagnostic check; it never changes the reward
#   gate_code ID COMMAND [SECONDS]  a gating code test: runs COMMAND, a program
#                                   under tests/code/, against the application
#                                   code in this container
#   note_code ID COMMAND [SECONDS]  a code test that is a diagnostic check
#   judge ID PROGRAM [SECONDS]      runs a judging program, under tests/judges/
#                                   or tests/shared/judges/, for a line the user
#                                   judges; it is recorded as a diagnostic check
#   finish                          write check-results.json and reward.json, exit 0
# unknown means the evidence could not be read. It is never a pass, and the
# run records it as missing evidence instead of a business failure.
# A code test or a judge passes when its program exits 0 and fails when it
# exits 1 to 123. It is unknown when the program is missing, runs out of time
# (124), says it cannot tell (125), cannot be run (126, 127) or is stopped by a
# signal (above 128). SECONDS defaults to 300; without a `timeout` command in
# the image the program runs until the verifier's own timeout. The program's
# output is kept in /logs/verifier/ID.log, and its last lines are the evidence.
# A check recorded more than once is unknown: no single result can be read.
GENESIS_OUT="${GENESIS_OUT:-/logs/verifier}"
GENESIS_TESTS="${GENESIS_TESTS:-$(CDPATH= cd "$(dirname "$0")" 2>/dev/null && pwd)}"
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

# Runs a program frozen in the package and records its exit status as the
# result of one check: ROLE ID WHAT PATH [SECONDS].
_genesis_program() {
  _genesis_role=$1
  _genesis_id=$2
  _genesis_what=$3
  _genesis_rel=$4
  _genesis_secs=${5:-300}
  case "$_genesis_rel" in
    ''|/*|..|../*|*/../*|*/..)
      _genesis_row "$_genesis_role" "$_genesis_id" unknown "$_genesis_what '$_genesis_rel' is not a path under tests/"
      return 0 ;;
  esac
  case "$_genesis_secs" in
    ''|*[!0-9]*) _genesis_secs=300 ;;
  esac
  _genesis_path="$GENESIS_TESTS/$_genesis_rel"
  if [ ! -f "$_genesis_path" ]; then
    _genesis_row "$_genesis_role" "$_genesis_id" unknown "$_genesis_what $_genesis_rel is missing"
    return 0
  fi
  _genesis_log="$GENESIS_OUT/$_genesis_id.log"
  if [ -x "$_genesis_path" ]; then
    set -- "$_genesis_path"
  else
    set -- sh "$_genesis_path"
  fi
  if command -v timeout >/dev/null 2>&1; then
    timeout "$_genesis_secs" "$@" > "$_genesis_log" 2>&1 < /dev/null
  else
    "$@" > "$_genesis_log" 2>&1 < /dev/null
  fi
  _genesis_status=$?
  _genesis_tail=$(tail -c 400 "$_genesis_log" 2>/dev/null)
  if [ "$_genesis_status" -eq 0 ]; then
    _genesis_result=pass
  elif [ "$_genesis_status" -le 123 ]; then
    _genesis_result=fail
  else
    _genesis_result=unknown
  fi
  case "$_genesis_status" in
    124) _genesis_why="ran out of $_genesis_secs seconds" ;;
    125) _genesis_why="says it cannot tell (exit 125)" ;;
    126) _genesis_why="cannot be run (exit 126)" ;;
    127) _genesis_why="could not find a command (exit 127)" ;;
    *)
      if [ "$_genesis_status" -gt 128 ]; then
        _genesis_why="was stopped by signal $((_genesis_status - 128))"
      else
        _genesis_why="exited $_genesis_status"
      fi ;;
  esac
  _genesis_row "$_genesis_role" "$_genesis_id" "$_genesis_result" "$_genesis_what $_genesis_rel $_genesis_why: $_genesis_tail"
}

gate_code() { _genesis_program gating "$1" "code test" "${2:-}" "${3:-}"; }
note_code() { _genesis_program diagnostic "$1" "code test" "${2:-}" "${3:-}"; }
judge() { _genesis_program diagnostic "$1" "judge" "${2:-}" "${3:-}"; }

finish() {
  awk -F '\t' -v reward="$GENESIS_OUT/reward.json" '
    BEGIN { printf "{\n  \"results\": [" }
    NR == FNR { seen[$2]++; next }
    ($2 in done) { next }
    { done[$2] = 1
      result = $3
      evidence = $4
      if (seen[$2] > 1) { result = "unknown"; evidence = "recorded " seen[$2] " times, so no single result can be read" }
      printf "%s\n    { \"id\": \"%s\", \"result\": \"%s\", \"evidence\": \"%s\" }", (shown++ > 0 ? "," : ""), $2, result, evidence
      if ($1 == "gating") { gating++; if (result == "pass") passed++ } }
    END { printf "\n  ]\n}\n"; printf "{ \"reward\": %d }\n", (gating > 0 && gating == passed ? 1 : 0) > reward }
  ' "$GENESIS_ROWS" "$GENESIS_ROWS" > "$GENESIS_OUT/check-results.json"
  rm -f "$GENESIS_ROWS"
  exit 0
}
