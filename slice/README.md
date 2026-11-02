# Telemetry slice

This slice runs the ingest path of section 1 in [`../README.md`](../README.md). It has one service (Node.js 22, Fastify) and one Postgres 16 database. Docker Compose starts both.

## What it does

- `POST /v1/events` receives a batch of events (a JSON array).
  - The service checks each event against the envelope schema. Then it checks the payload against the schema for the event type and version.
  - The service writes the valid events in one transaction. It inserts each event into `event_history`. It upserts `latest_state` only if the event is newer (`event_time`, then `event_id`).
  - After the commit, the service returns `202`. The response lists the invalid events in `rejected`. If no event is valid, the service writes nothing and returns `400`.
  - If the database rejects a value (for example, a date out of range), the service writes nothing and returns `400`. If the database fails, it returns `503`.
- `GET /v1/chargers/{chargerId}/state` returns the latest state, grouped by connector and field group. It returns `404` if the charger has no state. It logs the `X-Client-Id` header.
- `GET /healthz` returns `200` when the database is reachable.

The service loads `contracts/` at startup. Each event type has a folder with `contract.yaml`, `v<N>.schema.json`, and examples. To add an event type, add a folder and rebuild.

The slice does not include authentication, rate limits, the retention job, metrics, the CI checks, or automated tests.

## Run it

You need only Docker with Compose. Port 8080 on the host must be free. The database port is not published.

```bash
cd slice
docker compose up --build -d
curl -s http://localhost:8080/healthz
# {"status":"ok"}
```

To stop the stack and delete the data:

```bash
docker compose down -v
```

## Write an event

```bash
curl -s -X POST http://localhost:8080/v1/events \
  -H 'Content-Type: application/json' \
  -d '[{"event_id":"5f1d8c0e9a7b3c2d4e6f8a1b2c3d4e5f","event_type":"connector_status","schema_version":1,
        "charger_id":"CP-000123","connector_id":1,"event_time":"2026-11-01T18:26:00Z",
        "payload":{"status":"Charging","error_code":"NoError"}}]'
```

Output:

```json
{"accepted":1,"rejected":[]}
```

## Read latest state

```bash
curl -s http://localhost:8080/v1/chargers/CP-000123/state -H 'X-Client-Id: billing'
```

Output:

```json
{"charger_id":"CP-000123","connectors":{"1":{"status":{"event_time":"2026-11-01T18:26:00.000Z","event_id":"5f1d8c0e9a7b3c2d4e6f8a1b2c3d4e5f","data":{"status":"Charging","error_code":"NoError"}}}}}
```

## Run the demo

`demo.sh` runs these scenarios with curl. It prints each response and checks the result:

1. Write a `connector_status` event. Read the state.
2. Write a `meter_values` event. The state shows the `status` and `meter` groups.
3. Send the event from step 1 again. The state does not change. History has two rows.
4. Send an older status event. The state does not change. History has the row.
5. Send a newer status event. The status changes. The meter does not change.
6. Send a batch with one valid and two invalid events. The service writes the valid event and lists the two invalid events in `rejected`.
7. Send a batch with only invalid events. The service returns `400` and writes nothing.
8. Read an unknown charger. The service returns `404`.

The demo needs bash and curl on the host. Start from a clean stack:

```bash
docker compose down -v && docker compose up --build -d
./demo.sh
```

The last line is `=== All scenarios passed`. If a check fails, the script prints `FAIL` and stops.

To see the history:

```bash
docker compose exec db psql -U telemetry -d telemetry \
  -c 'SELECT received_at, event_id, event_type, event_time, payload FROM event_history ORDER BY received_at'
```

## Files

| Path | Content |
|---|---|
| `src/server.js` | HTTP routes |
| `src/contracts.js` | Loads the contracts and checks events |
| `src/db.js` | Partitions, batch write, state read |
| `db/init.sql` | Tables. Postgres runs it at first start. |
| `contracts/` | Envelope schema and event contracts |
| `docker-compose.yml`, `Dockerfile` | Local stack |
| `demo.sh` | Scenarios with curl |
