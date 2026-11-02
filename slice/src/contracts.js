import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse as parseYaml } from 'yaml';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const subfolders = (path) =>
  readdirSync(path, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

// Converts Ajv errors to { path, message }.
const toErrors = (ajvErrors, prefix = '') =>
  ajvErrors.map((e) => ({
    path: prefix + e.instancePath || '/',
    message: e.params.additionalProperty ? `${e.message}: ${e.params.additionalProperty}` : e.message,
  }));

/**
 * Loads the contracts folder:
 * - envelope/v1.schema.json
 * - <team>/<event>/contract.yaml and v<N>.schema.json (payload schema of version N)
 */
export function loadContracts(dir) {
  const ajv = new Ajv2020({ allErrors: true });
  addFormats(ajv);

  const envelope = ajv.compile(readJson(join(dir, 'envelope', 'v1.schema.json')));
  const types = new Map(); // event_type -> { fieldGroup, versions: Map<version, validate> }
  const groupOwners = new Map(); // field_group -> team

  for (const team of subfolders(dir).filter((name) => name !== 'envelope')) {
    for (const event of subfolders(join(dir, team))) {
      const folder = join(dir, team, event);
      const contract = parseYaml(readFileSync(join(folder, 'contract.yaml'), 'utf8'));
      for (const key of ['event_type', 'field_group']) {
        if (typeof contract?.[key] !== 'string' || contract[key] === '') {
          throw new Error(`${folder}/contract.yaml: ${key} must be a non-empty string`);
        }
      }
      if (types.has(contract.event_type)) throw new Error(`duplicate event_type ${contract.event_type}`);
      // A field group belongs to one team. Another team cannot overwrite its state.
      const owner = groupOwners.get(contract.field_group) ?? team;
      if (owner !== team) throw new Error(`field_group ${contract.field_group} belongs to team ${owner}, not ${team}`);
      groupOwners.set(contract.field_group, team);

      const versions = new Map();
      for (const file of readdirSync(folder)) {
        const match = file.match(/^v(\d+)\.schema\.json$/);
        if (match) versions.set(Number(match[1]), ajv.compile(readJson(join(folder, file))));
      }
      if (versions.size === 0) throw new Error(`${folder}: no v<N>.schema.json`);
      types.set(contract.event_type, { fieldGroup: contract.field_group, versions });
    }
  }

  return {
    eventTypes: [...types.keys()],

    // Returns a list of errors. An empty list means the event is valid.
    validate(event) {
      if (!envelope(event)) return toErrors(envelope.errors);
      const payloadSchema = types.get(event.event_type)?.versions.get(event.schema_version);
      if (!payloadSchema) {
        return [{ path: '/event_type', message: `unknown event type or version: ${event.event_type} v${event.schema_version}` }];
      }
      if (!payloadSchema(event.payload)) return toErrors(payloadSchema.errors, '/payload');
      return [];
    },

    fieldGroup: (eventType) => types.get(eventType).fieldGroup,
  };
}
