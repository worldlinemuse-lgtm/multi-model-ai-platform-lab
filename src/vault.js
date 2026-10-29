import {read,write,remove} from './storage.js';
const KEY='vault.v1';const te=new TextEncoder();const td=new TextDecoder();const ITER=260000;const toB64=b=>btoa(String.fromCharCode(...new Uint8Array(b)));const fromB64=s=>Uint8Array.from(atob(s),v=>v.charCodeAt(0));
const MAX_ENCRYPTED_RECORD=1_000_000;
function validateEncryptedRecord(record){
 if(!record||typeof record!=='object'||Array.isArray(record)||record.version!==1||record.iterations!==ITER)throw Error('Unsupported encrypted vault format or KDF parameters.');
 const fields=[['salt',16],['iv',12],['ciphertext',null]];
 for(const [name,length] of fields){
  const value=record[name];
  if(typeof value!=='string'||!value.length||value.length>MAX_ENCRYPTED_RECORD||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))throw Error('Invalid encrypted vault '+name);
  let bytes;try{bytes=fromB64(value);}catch{throw Error('Invalid encrypted vault '+name);}
  if(length!==null&&bytes.length!==length)throw Error('Invalid encrypted vault '+name+' length');
  if(name==='ciphertext'&&(bytes.length<17||bytes.length>750000))throw Error('Encrypted vault ciphertext is outside safe bounds.');
 }
 return record;
}
export class KeyVault{
 constructor(){this.cryptoKey=null;this.entries={};this.salt=null;}
 get isUnlocked(){return !!this.cryptoKey;}
 get count(){return this.isUnlocked?Object.keys(this.entries).length:0;}
 async exists(){return !!(await read(KEY));}
 async derive(pass,salt){if(!crypto.subtle)throw Error('Web Crypto is unavailable: open this page using HTTPS or localhost.');const material=await crypto.subtle.importKey('raw',te.encode(pass),'PBKDF2',false,['deriveKey']);return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:ITER,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);}
 async create(pass){if(pass.length<10)throw Error('Use a passphrase of at least 10 characters.');if(await this.exists())throw Error('Vault already exists; unlock it instead.');const salt=crypto.getRandomValues(new Uint8Array(16));const cryptoKey=await this.derive(pass,salt);await this.persistRecord({},cryptoKey,salt);this.salt=salt;this.cryptoKey=cryptoKey;this.entries={};}
 async unlock(pass){const record=await read(KEY);if(!record)throw Error('No vault exists yet.');validateEncryptedRecord(record);const salt=fromB64(record.salt);const cryptoKey=await this.derive(pass,salt);let plaintext;try{plaintext=await crypto.subtle.decrypt({name:'AES-GCM',iv:fromB64(record.iv),additionalData:te.encode(KEY)},cryptoKey,fromB64(record.ciphertext));}catch{throw Error('Passphrase incorrect or encrypted vault damaged.');}const entries=JSON.parse(td.decode(plaintext));if(!entries||typeof entries!=='object'||Array.isArray(entries))throw Error('Invalid encrypted vault payload');this.salt=salt;this.cryptoKey=cryptoKey;this.entries=entries;}
 // Encrypt and persist a proposed entries map WITHOUT adopting it. Callers
 // adopt only after this resolves, so a failed write leaves the in-memory
 // vault exactly matching durable storage instead of diverging from it.
 async persistRecord(entries,cryptoKey,salt){const iv=crypto.getRandomValues(new Uint8Array(12));const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:te.encode(KEY)},cryptoKey,te.encode(JSON.stringify(entries)));await write(KEY,{version:1,iterations:ITER,salt:toB64(salt),iv:toB64(iv),ciphertext:toB64(ciphertext)});}
 async save(){if(!this.isUnlocked)throw Error('Unlock vault first.');await this.persistRecord(this.entries,this.cryptoKey,this.salt);}
 async put(provider,{key,model,account,attested}){if(!this.isUnlocked)throw Error('Unlock vault first.');if(!attested)throw Error('Free plan attestation required.');if(!key||!model)throw Error('API key and eligible model ID required.');const next={...this.entries,[provider]:{key,model,account:account||'',attested:true,updated:new Date().toISOString()}};await this.persistRecord(next,this.cryptoKey,this.salt);this.entries=next;}
 async drop(provider){if(!this.isUnlocked)throw Error('Unlock vault first.');const next={...this.entries};delete next[provider];await this.persistRecord(next,this.cryptoKey,this.salt);this.entries=next;}
 get(provider){if(!this.isUnlocked)return null;const p=this.entries[provider];return p?{...p}:null;}
 list(){if(!this.isUnlocked)return [];return Object.entries(this.entries).map(([id,c])=>({id,model:c.model,updated:c.updated}));}
 lock(){this.cryptoKey=null;this.entries={};this.salt=null;}
 async exportEncrypted(){
  const record=await read(KEY);
  if(!record)throw Error('No encrypted vault to export.');
  validateEncryptedRecord(record);
  return JSON.stringify({format:'mm-studio-encrypted-vault-v1',record},null,2);
 }
 async importEncrypted(contents,{replaceExisting=false,passphrase}={}){
  if(typeof contents!=='string'||contents.length>MAX_ENCRYPTED_RECORD)throw Error('Encrypted vault backup must be JSON under 1 MB.');
  if(typeof passphrase!=='string'||passphrase.length<10||passphrase.length>1024)throw Error('Enter the original encrypted backup passphrase before importing.');
  let backup;try{backup=JSON.parse(contents);}catch{throw Error('Encrypted vault backup is invalid JSON.');}
  if(!backup||backup.format!=='mm-studio-encrypted-vault-v1')throw Error('Encrypted vault backup format is unsupported.');
  const record=validateEncryptedRecord(backup.record);
  if(await this.exists()&&!replaceExisting)throw Error('An encrypted vault already exists; explicit replacement confirmation is required.');
  const tempKey=await this.derive(passphrase,fromB64(record.salt));
  let plaintext;
  try{plaintext=await crypto.subtle.decrypt({name:'AES-GCM',iv:fromB64(record.iv),additionalData:te.encode(KEY)},tempKey,fromB64(record.ciphertext));}
  catch{throw Error('Encrypted backup passphrase is incorrect or backup authentication failed. Existing vault unchanged.');}
  let entries;
  try{entries=JSON.parse(td.decode(plaintext));}catch{throw Error('Encrypted backup payload is not valid JSON. Existing vault unchanged.');}
  if(!entries||typeof entries!=='object'||Array.isArray(entries)||Object.keys(entries).length>32||!Object.entries(entries).every(([id,c])=>/^[a-z0-9_-]{1,50}$/.test(id)&&c&&typeof c==='object'&&!Array.isArray(c)&&typeof c.key==='string'&&c.key.length>0&&c.key.length<=10000&&typeof c.model==='string'&&c.model.length>0&&c.model.length<=130&&typeof c.account==='string'&&c.account.length<=120&&c.attested===true&&typeof c.updated==='string'&&c.updated.length<=80))throw Error('Authenticated encrypted backup contains invalid provider entries. Existing vault unchanged.');
  await write(KEY,record);
  this.lock();
 }
 async rotatePassphrase(currentPass,newPass){
  if(!this.isUnlocked)throw Error('Unlock vault before rotating the passphrase.');
  if(typeof currentPass!=='string'||typeof newPass!=='string'||newPass.length<10||currentPass===newPass)throw Error('Use a distinct new passphrase of at least 10 characters.');
  const record=validateEncryptedRecord(await read(KEY));
  const oldKey=await this.derive(currentPass,fromB64(record.salt));
  let verified;
  try{verified=await crypto.subtle.decrypt({name:'AES-GCM',iv:fromB64(record.iv),additionalData:te.encode(KEY)},oldKey,fromB64(record.ciphertext));}
  catch{throw Error('Current passphrase is incorrect. No vault changes were made.');}
  let entries;try{entries=JSON.parse(td.decode(verified));}catch{throw Error('Decrypted vault is damaged; rotation refused.');}
  if(!entries||typeof entries!=='object'||Array.isArray(entries))throw Error('Encrypted vault contents are invalid.');
  const newSalt=crypto.getRandomValues(new Uint8Array(16)),newKey=await this.derive(newPass,newSalt),iv=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:te.encode(KEY)},newKey,te.encode(JSON.stringify(entries)));
  const next={version:1,iterations:ITER,salt:toB64(newSalt),iv:toB64(iv),ciphertext:toB64(encrypted)};
  await write(KEY,next); // An IndexedDB transaction preserves the old record if the write fails.
  this.salt=newSalt;this.cryptoKey=newKey;this.entries=entries;
 }
 async erase(){await remove(KEY);this.lock();}
}
