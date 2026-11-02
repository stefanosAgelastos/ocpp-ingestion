#!/usr/bin/env bash
# Runs the slice scenarios with curl, prints each response, and checks the result.
# Start from a clean stack: docker compose down -v && docker compose up --build -d
set -euo pipefail
cd "$(dirname "$0")"

BASE_URL=${BASE_URL:-http://localhost:8080}
CHARGER=CP-000123
STATUS_EVENT=$(cat contracts/charging/connector_status/examples/charging.json)
STATUS_EVENT_ID=5f1d8c0e9a7b3c2d4e6f8a1b2c3d4e5f
METER_EVENT=$(cat contracts/charging/meter_values/examples/sample.json)
METER_STATE='"meter":{"event_time":"2026-11-01T18:26:30.000Z","event_id":"9c4e2a7f1b3d5c6e8f0a2b4c6d8e0f1a"'

step() { printf '\n=== %s\n' "$*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
# check <description> <test command...>
check() { local what=$1; shift; if "$@"; then echo "OK: $what"; else fail "$what"; fi; }
contains() { [[ $BODY == *"$1"* ]]; }

# call <expected HTTP status> <curl arguments...>
# Prints the response and keeps the body in BODY.
call() {
  local expected=$1 out code
  shift
  out=$(curl -s -w '\n%{http_code}' "$@")
  code=${out##*$'\n'}
  BODY=${out%$'\n'*}
  echo "HTTP $code $BODY"
  [ "$code" = "$expected" ] || fail "expected HTTP $expected"
}
post() { call "$1" -X POST "$BASE_URL/v1/events" -H 'Content-Type: application/json' -d "$2"; }
state() { call "$1" -H 'X-Client-Id: demo' "$BASE_URL/v1/chargers/$2/state"; }

sql() { docker compose exec -T db psql -U telemetry -d telemetry -tAc "$1"; }
history_rows() { sql "SELECT count(*) FROM event_history WHERE event_id = '$1'"; }
all_rows() { sql "SELECT (SELECT count(*) FROM event_history) || ' history, ' || (SELECT count(*) FROM latest_state) || ' latest_state'"; }

# status_event <event_id> <event_time> <status>
status_event() {
  printf '{"event_id":"%s","event_type":"connector_status","schema_version":1,"charger_id":"%s","connector_id":1,"event_time":"%s","payload":{"status":"%s","error_code":"NoError"}}' \
    "$1" "$CHARGER" "$2" "$3"
}

step "0. Wait for the service"
for _ in $(seq 30); do curl -sf "$BASE_URL/healthz" >/dev/null && break || sleep 1; done
call 200 "$BASE_URL/healthz"
[ "$(sql "SELECT count(*) FROM latest_state WHERE charger_id = '$CHARGER'")" = 0 ] ||
  fail "$CHARGER already has state. Reset: docker compose down -v && docker compose up --build -d"

step "1. Write a connector_status event"
post 202 "[$STATUS_EVENT]"
state 200 "$CHARGER"
check "state shows status Charging" contains '"status":"Charging"'

step "2. Write a meter_values event for the same connector"
post 202 "[$METER_EVENT]"
state 200 "$CHARGER"
check "state shows the status and meter groups" contains "$METER_STATE"
STATE_AFTER_2=$BODY

step "3. Send the event from step 1 again (duplicate)"
post 202 "[$STATUS_EVENT]"
state 200 "$CHARGER"
check "state did not change" [ "$BODY" = "$STATE_AFTER_2" ]
check "history has 2 rows for event_id $STATUS_EVENT_ID" [ "$(history_rows $STATUS_EVENT_ID)" = 2 ]

step "4. Send an older connector_status event (18:20, Preparing)"
post 202 "[$(status_event b2a7c4e9d1f3a5b7c9e1d3f5a7b9c1e3 2026-11-01T18:20:00Z Preparing)]"
state 200 "$CHARGER"
check "state did not change" [ "$BODY" = "$STATE_AFTER_2" ]
check "history has the older event" [ "$(history_rows b2a7c4e9d1f3a5b7c9e1d3f5a7b9c1e3)" = 1 ]

step "5. Send a newer connector_status event (18:40, Finishing)"
post 202 "[$(status_event c3e8f1a2b4d6c8e0a2b4d6f8a0c2e4f6 2026-11-01T18:40:00Z Finishing)]"
state 200 "$CHARGER"
check "status changed to Finishing" contains '"status":"Finishing"'
check "meter did not change" contains "$METER_STATE"

MISSING_CHARGER_ID="{\"event_id\":\"e5a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4\",\"event_type\":\"connector_status\",\"schema_version\":1,\"connector_id\":1,\"event_time\":\"2026-11-01T18:50:00Z\",\"payload\":{\"status\":\"Available\",\"error_code\":\"NoError\"}}"
UNKNOWN_TYPE="{\"event_id\":\"f6b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5\",\"event_type\":\"tire_pressure\",\"schema_version\":1,\"charger_id\":\"$CHARGER\",\"connector_id\":1,\"event_time\":\"2026-11-01T18:50:00Z\",\"payload\":{}}"

step "6. Send a batch: one valid event, one without charger_id, one with an unknown event_type"
post 202 "[$(status_event d4f9a3b5c7e9f1a3b5c7d9e1f3a5b7c9 2026-11-01T18:50:00Z Available), $MISSING_CHARGER_ID, $UNKNOWN_TYPE]"
check "response accepts 1 event and rejects events 1 and 2" contains '"accepted":1,"rejected":[{"index":1'
check "the valid event is written" [ "$(history_rows d4f9a3b5c7e9f1a3b5c7d9e1f3a5b7c9)" = 1 ]
check "the invalid events are not written" [ "$(history_rows e5a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4)$(history_rows f6b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5)" = 00 ]
state 200 "$CHARGER"
check "status changed to Available" contains '"status":"Available"'

step "7. Send a batch with only invalid events"
ROWS_BEFORE=$(all_rows)
post 400 "[$MISSING_CHARGER_ID, $UNKNOWN_TYPE]"
check "nothing written ($ROWS_BEFORE)" [ "$(all_rows)" = "$ROWS_BEFORE" ]

step "8. Read an unknown charger"
state 404 CP-999999

step "All scenarios passed"
