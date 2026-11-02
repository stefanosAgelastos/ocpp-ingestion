import pg from 'pg';

// Connection settings come from the PG* environment variables.
const pool = new pg.Pool({ connectionTimeoutMillis: 5000 });
pool.on('error', (err) => console.error('idle database client failed', err));

const UPSERT_LATEST_STATE = `
  INSERT INTO latest_state AS s (charger_id, connector_id, field_group, event_time, event_id, received_at, data)
  VALUES ($1, $2, $3, $4, $5, now(), $6)
  ON CONFLICT (charger_id, connector_id, field_group) DO UPDATE
  SET event_time = EXCLUDED.event_time, event_id = EXCLUDED.event_id,
      received_at = EXCLUDED.received_at, data = EXCLUDED.data
  WHERE (s.event_time, s.event_id) < (EXCLUDED.event_time, EXCLUDED.event_id)`;

const INSERT_HISTORY = `
  INSERT INTO event_history (received_at, event_id, event_type, schema_version, charger_id, connector_id, event_time, payload)
  VALUES (now(), $1, $2, $3, $4, $5, $6, $7)`;

export const ping = () => pool.query('SELECT 1');
export const close = () => pool.end();

// Creates the event_history partitions for today and tomorrow (UTC).
export async function createPartitions() {
  for (const offset of [0, 1]) {
    const day = new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const next = new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10);
    await pool.query(
      `CREATE TABLE IF NOT EXISTS event_history_${day.replaceAll('-', '')} PARTITION OF event_history
       FOR VALUES FROM ('${day} 00:00:00+00') TO ('${next} 00:00:00+00')`,
    );
  }
}

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Writes a batch in one transaction:
 * - inserts each event into event_history
 * - upserts latest_state; the upsert writes only if the event is newer
 * - received_at is now(), the start time of the transaction
 * Each event must have a field_group.
 * The upserts lock latest_state rows in key order. Thus, two concurrent batches do not deadlock.
 */
export async function writeBatch(events) {
  const sorted = events.toSorted(
    (a, b) =>
      compare(a.charger_id, b.charger_id) || a.connector_id - b.connector_id || compare(a.field_group, b.field_group),
  );
  const client = await pool.connect();
  let broken;
  try {
    await client.query('BEGIN');
    for (const e of sorted) {
      await client.query(INSERT_HISTORY, [
        e.event_id, e.event_type, e.schema_version, e.charger_id, e.connector_id, e.event_time, e.payload,
      ]);
      await client.query(UPSERT_LATEST_STATE, [
        e.charger_id, e.connector_id, e.field_group, e.event_time, e.event_id, e.payload,
      ]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch((rollbackErr) => {
      broken = rollbackErr;
    });
    throw err;
  } finally {
    // If ROLLBACK failed, the pool discards the client.
    client.release(broken);
  }
}

export async function readState(chargerId) {
  const { rows } = await pool.query(
    `SELECT connector_id, field_group, event_time, event_id, data
     FROM latest_state WHERE charger_id = $1
     ORDER BY connector_id, field_group`,
    [chargerId],
  );
  return rows;
}
