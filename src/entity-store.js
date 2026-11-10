import {APP_KEY, clone, cloneFailure, freshState, validateState} from './core.js';
// Stage 3a: per-entity workspace persistence.
//
// The workspace is still saved as one logical unit, but it is stored as
// separate records: one per entity plus a manifest. A corrupt or missing
// entity record no longer destroys the whole workspace, because the
// whole-workspace `state.v1` record is still written on every save and
// kept intact as the rollback record. Load priority is by revision:
// whichever of the entity set or `state.v1` is newer wins; a partial
// entity set (records out of sync with the manifest) falls back to
// `state.v1` instead of loading a mixed workspace.
export const MANIFEST_KEY = 'state.manifest.v1';
export const ENTITY_KEYS = ['projects', 'snapshots', 'threads', 'notes', 'audit', 'workflows', 'datasets', 'preferences'];
export const entityKey = name => `state.entity.${name}.v1`;

function shapeOf(name, value) {
  if (name === 'preferences') return value !== null && typeof value === 'object' && !Array.isArray(value);
  return Array.isArray(value);
}

export function splitState(state) {
  if (!validateState(state)) throw Error('Cannot split an invalid workspace state');
  const manifest = {
    format: APP_KEY, revision: state.revision, created: state.created,
    activeProjectId: state.activeProjectId, activeThreadId: state.activeThreadId,
    entities: [...ENTITY_KEYS],
  };
  const records = {};
  for (const name of ENTITY_KEYS) {
    const value = clone(state[name]);
    if (value === null) throw Error(`Entity record not serializable: ${name} (${cloneFailure(state[name]) ?? 'unknown reason'})`);
    records[name] = {revision: state.revision, value};
  }
  return {manifest, records};
}

export function assembleState(manifest, records) {
  if (!manifest || manifest.format !== APP_KEY || !Number.isSafeInteger(manifest.revision) || manifest.revision < 0)
    throw Error('Entity manifest is missing or unsupported');
  const values = {};
  for (const name of ENTITY_KEYS) {
    const record = records[name];
    if (record == null) throw Error(`Entity record missing: ${name}`);
    if (record.revision !== undefined && record.revision > manifest.revision)
      throw Error(`Entity record out of sync: ${name}`);
    if (!shapeOf(name, record.value)) throw Error(`Entity record invalid: ${name}`);
    values[name] = record.value;
  }
  const state = {
    format: APP_KEY, revision: manifest.revision, created: manifest.created,
    activeProjectId: manifest.activeProjectId, activeThreadId: manifest.activeThreadId,
    ...values,
  };
  if (!validateState(state)) throw Error('Entity workspace validation failed');
  return state;
}

// Copy-only migration: writes entity records and the manifest, never
// touches `state.v1`, and never overwrites an existing manifest.
export async function migrateToEntities(read, write, state) {
  if (await read(MANIFEST_KEY) != null) return false;
  const {manifest, records} = splitState(state);
  for (const name of ENTITY_KEYS) await write(entityKey(name), records[name]);
  await write(MANIFEST_KEY, manifest);
  return true;
}

export async function loadEntityState(read) {
  const manifest = await read(MANIFEST_KEY);
  if (manifest == null) return null;
  const records = {};
  for (const name of ENTITY_KEYS) records[name] = await read(entityKey(name));
  return {manifest, state: assembleState(manifest, records)};
}

export function freshEntityState() { return freshState(); }
