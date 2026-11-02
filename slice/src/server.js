import Fastify from 'fastify';
import { fileURLToPath } from 'node:url';
import { loadContracts } from './contracts.js';
import * as db from './db.js';

const contracts = loadContracts(fileURLToPath(new URL('../contracts', import.meta.url)));

const app = Fastify({ logger: true });

app.post('/v1/events', async (request, reply) => {
  const batch = request.body;
  if (!Array.isArray(batch) || batch.length === 0) {
    return reply.code(400).send({ error: 'body must be a non-empty JSON array of events' });
  }

  // Writes the valid events and lists the invalid events in `rejected`.
  const rejected = batch.flatMap((event, index) => contracts.validate(event).map((e) => ({ index, ...e })));
  const invalid = new Set(rejected.map((e) => e.index));
  const valid = batch.filter((_, index) => !invalid.has(index));
  if (valid.length === 0) {
    return reply.code(400).send({ error: 'no valid events, nothing written', rejected });
  }

  try {
    await db.writeBatch(valid.map((e) => ({ ...e, field_group: contracts.fieldGroup(e.event_type) })));
  } catch (err) {
    // SQLSTATE class 22: the database rejected a value. A retry gives the same result.
    if (err.code?.startsWith('22')) {
      request.log.warn(err, 'database rejected a value');
      return reply.code(400).send({ error: 'the database rejected a value, nothing written', detail: err.message });
    }
    request.log.error(err, 'write failed');
    return reply.code(503).send({ error: 'database unavailable, send the batch again' });
  }
  return reply.code(202).send({ accepted: valid.length, rejected });
});

app.get('/v1/chargers/:chargerId/state', async (request, reply) => {
  const { chargerId } = request.params;
  request.log.info({ clientId: request.headers['x-client-id'], chargerId }, 'read state');

  let rows;
  try {
    rows = await db.readState(chargerId);
  } catch (err) {
    request.log.error(err, 'read failed');
    return reply.code(503).send({ error: 'database unavailable' });
  }
  if (rows.length === 0) return reply.code(404).send({ error: `no state for charger ${chargerId}` });

  // Groups rows by connector, then by field group.
  const connectors = {};
  for (const r of rows) {
    connectors[r.connector_id] ??= {};
    connectors[r.connector_id][r.field_group] = { event_time: r.event_time, event_id: r.event_id, data: r.data };
  }
  return { charger_id: chargerId, connectors };
});

app.get('/healthz', async (request, reply) => {
  try {
    await db.ping();
    return { status: 'ok' };
  } catch {
    return reply.code(503).send({ status: 'database unavailable' });
  }
});

await db.createPartitions();
// Each hour, creates the partitions for today and tomorrow.
setInterval(() => {
  db.createPartitions().catch((err) => app.log.error(err, 'partition creation failed'));
}, 3_600_000).unref();
app.log.info({ eventTypes: contracts.eventTypes }, 'contracts loaded');
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 8080) });

// On SIGTERM or SIGINT, completes the requests in progress, then closes the pool.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, async () => {
    app.log.info({ signal }, 'signal received, service stops');
    await app.close();
    await db.close();
  });
}
