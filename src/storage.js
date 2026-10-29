// Lab-only storage identity (2026-10-26 audit P0): lab and production share
// one github.io origin, so one IndexedDB name meant they overwrote each
// other's workspace and vault. The lab uses its own database; production
// keeps mm-studio-b03 untouched.
const DB_NAME='mm-studio-lab-b03';const LEGACY_DB_NAME='mm-studio-b03';const MIGRATION_KEY='migration.lab-b03.done';const STORE='kv';let dbPromise;
function openDb(name,version){return new Promise((resolve,reject)=>{const r=indexedDB.open(name,version);r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains(STORE))r.result.createObjectStore(STORE)};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
function getRecord(db,key){return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readonly');const req=tx.objectStore(STORE).get(key);req.onsuccess=()=>resolve(req.result??null);req.onerror=()=>reject(req.error);});}
function putRecord(db,key,value){return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).put(value,key);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
// One-time, copy-only migration from the previously shared database. Runs
// inside open() so every read/write sees migrated data. Per-key rule: a key
// already present in the lab database is never overwritten. The legacy
// database is never deleted here; it stays until the user confirms the lab
// copy and removes it deliberately. Any failure skips migration without
// breaking boot; a missing marker means the next boot retries.
async function migrateOnce(db){try{const done=await getRecord(db,MIGRATION_KEY);if(done)return;let legacyNames=null;try{if(indexedDB.databases)legacyNames=(await indexedDB.databases()).map(d=>d.name);}catch{}if(legacyNames&&!legacyNames.includes(LEGACY_DB_NAME)){await putRecord(db,MIGRATION_KEY,{migratedFrom:null,at:new Date().toISOString()});return;}const legacy=await openDb(LEGACY_DB_NAME);try{for(const key of ['state.v1','vault.v1']){if(await getRecord(db,key)!=null)continue;const value=await getRecord(legacy,key);if(value!=null)await putRecord(db,key,value);}}finally{legacy.close();}await putRecord(db,MIGRATION_KEY,{migratedFrom:LEGACY_DB_NAME,at:new Date().toISOString()});}catch(e){console.warn('Lab storage migration skipped: '+(e&&e.message?e.message:e));}}
function open(){if(!('indexedDB' in window))return Promise.resolve(null);if(dbPromise)return dbPromise;dbPromise=(async()=>{const db=await openDb(DB_NAME,1);await migrateOnce(db);return db;})();return dbPromise;}
const memory=new Map();
let writes=Promise.resolve();
export async function read(key){try{const db=await open();if(!db) return memory.get(key)??null;return await new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readonly');const req=tx.objectStore(STORE).get(key);req.onsuccess=()=>resolve(req.result??null);req.onerror=()=>reject(req.error)})}catch(e){throw Error('Browser database unavailable: '+e.message)}}
export function write(key,value){
 const snapshot=structuredClone(value);
 const pending=writes.catch(()=>{}).then(async()=>{const db=await open();if(!db){memory.set(key,snapshot);return;}await new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).put(snapshot,key);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error)});});
 writes=pending;return pending;
}
export function remove(key){const pending=writes.catch(()=>{}).then(async()=>{const db=await open();if(!db){memory.delete(key);return;}await new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).delete(key);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error)});});writes=pending;return pending;}
export const storageMode = ()=>'indexedDB' in window?'IndexedDB':'TEMPORARY MEMORY — export your work';
export const isDurableStorage = ()=>'indexedDB' in window;
