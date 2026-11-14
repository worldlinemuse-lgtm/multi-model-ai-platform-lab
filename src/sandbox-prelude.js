/* Shared Worker prelude for the JavaScript sandboxes (classic runner and Q03 module runner).
 * Runs INSIDE the disposable opaque-origin Worker. It adds three things the bare Worker lacked:
 *  1. Pending-work drain: setTimeout/setInterval callbacks and SubtleCrypto calls that are still
 *     pending when the program body returns are waited for before 'done' is reported, so late
 *     output is no longer dropped. The parent's run time limit still bounds the wait.
 *  2. Error reporting: unhandled promise rejections and errors thrown inside timer callbacks are
 *     reported as 'error' events with their stack instead of vanishing.
 *  3. crypto.subtle: a blob: Worker in an opaque origin is not a secure context, so SubtleCrypto
 *     is absent there. The hosting sandbox frame IS a secure context (same opaque origin, no
 *     parent access), so calls are relayed to the frame's real SubtleCrypto. Buffers are
 *     structured-cloned; CryptoKey objects stay in the frame and the Worker holds opaque
 *     handles (an insecure Worker cannot deserialize CryptoKey). Nothing leaves the sandbox and no capability is added beyond
 *     what the frame already had.
 */
export const SUBTLE_METHODS=Object.freeze(['digest','encrypt','decrypt','sign','verify','generateKey','deriveKey','deriveBits','importKey','exportKey','wrapKey','unwrapKey']);

export function workerPrelude(){return String.raw`
const send=(type,message)=>self.postMessage({type,message:String(message).slice(0,10000)});
const format=x=>{try{return typeof x==='string'?x:x instanceof Error?(x.stack||String(x)):JSON.stringify(x)??String(x)}catch{return String(x)}};
const logs={log:(...a)=>send('log',a.map(format).join(' ')),info:(...a)=>send('log',a.map(format).join(' ')),warn:(...a)=>send('log','WARN: '+a.map(format).join(' ')),error:(...a)=>send('log','ERROR: '+a.map(format).join(' '))};
const __mm={timers:new Set(),subtle:new Map(),seq:0,failed:false,st:globalThis.setTimeout.bind(globalThis),ct:globalThis.clearTimeout.bind(globalThis),si:globalThis.setInterval.bind(globalThis),ci:globalThis.clearInterval.bind(globalThis)};
const __mmFail=(prefix,err)=>{if(__mm.failed)return;__mm.failed=true;send('error',prefix+(err&&err.stack?err.stack:String(err)));};
globalThis.addEventListener?.('unhandledrejection',e=>{e.preventDefault();__mmFail('Unhandled promise rejection: ',e.reason);});
globalThis.addEventListener?.('error',e=>{e.preventDefault();__mmFail('Uncaught error: ',e.error||e.message);});
const __mmCallback=(fn,args)=>typeof fn==='function'?fn(...args):(0,eval)(String(fn));
globalThis.setTimeout=(fn,ms,...args)=>{let id;id=__mm.st(()=>{__mm.timers.delete(id);__mmCallback(fn,args);},ms);__mm.timers.add(id);return id;};
globalThis.clearTimeout=id=>{__mm.timers.delete(id);__mm.ct(id);};
globalThis.setInterval=(fn,ms,...args)=>{const id=__mm.si(()=>__mmCallback(fn,args),ms);__mm.timers.add(id);return id;};
globalThis.clearInterval=id=>{__mm.timers.delete(id);__mm.ci(id);};
const __mmKeys=new WeakMap();
function __mmKeyClass(){function CryptoKey(){throw new TypeError('Illegal constructor');}Object.defineProperty(CryptoKey.prototype,Symbol.toStringTag,{value:'CryptoKey'});return CryptoKey;}
const __mmKeyProto=(typeof globalThis.CryptoKey==='function'?globalThis.CryptoKey:(globalThis.CryptoKey=__mmKeyClass())).prototype;
const __mmWrapKey=d=>{const k=Object.create(__mmKeyProto);for(const f of ['type','extractable','algorithm','usages'])Object.defineProperty(k,f,{value:d[f],enumerable:true});__mmKeys.set(k,d.__mmKey);return Object.freeze(k);};
const __mmDecode=r=>{if(r&&typeof r==='object'){if(r.__mmKey)return __mmWrapKey(r);if(r.__mmPair)return {publicKey:__mmWrapKey(r.publicKey),privateKey:__mmWrapKey(r.privateKey)};}return r;};
const __mmEncodeOne=a=>__mmKeys.has(a)?{__mmKeyRef:__mmKeys.get(a)}:a;
const __mmEncode=a=>{if(__mmKeys.has(a))return __mmEncodeOne(a);if(a&&typeof a==='object'&&Object.getPrototypeOf(a)===Object.prototype){const o={};for(const [k,v] of Object.entries(a))o[k]=__mmEncodeOne(v);return o;}return a;};
if(globalThis.crypto&&!globalThis.crypto.subtle){const subtle={};for(const method of ${JSON.stringify(SUBTLE_METHODS)}){subtle[method]=(...args)=>new Promise((resolve,reject)=>{const id=++__mm.seq;__mm.subtle.set(id,{resolve,reject});try{self.postMessage({type:'subtle-call',id,method,args:args.map(__mmEncode)});}catch(e){__mm.subtle.delete(id);reject(e);}});}Object.defineProperty(globalThis.crypto,'subtle',{value:Object.freeze(subtle),configurable:true});}
const __mmSubtleReply=r=>{const p=__mm.subtle.get(r.id);if(!p)return;__mm.subtle.delete(r.id);if(r.ok)p.resolve(__mmDecode(r.result));else{const e=new Error(r.error||'SubtleCrypto call failed');e.name=r.name||'OperationError';p.reject(e);}};
const __mmDrain=async()=>{await new Promise(r=>__mm.st(r,0));for(;;){await new Promise(r=>__mm.st(r,0));if(__mm.failed)return false;if(!__mm.timers.size&&!__mm.subtle.size)return true;await new Promise(r=>__mm.st(r,5));}};
`;}

/* Frame-side relay. Runs in the sandbox iframe (secure context, opaque origin). `worker` is the
 * Worker variable name in the frame script; returns a JS statement that handles one message `d`
 * and evaluates to true when it consumed it. */
export function frameSubtleRelay(){return String.raw`const __mmAllowed=new Set(${JSON.stringify(SUBTLE_METHODS)});const __mmKeyStore=new Map();let __mmKeySeq=0;const __mmStoreKey=k=>{if(__mmKeyStore.size>=2000)throw new Error('Too many CryptoKeys in one run');const id=++__mmKeySeq;__mmKeyStore.set(id,k);return {__mmKey:id,type:k.type,extractable:k.extractable,algorithm:k.algorithm,usages:k.usages};};const __mmOut=r=>r instanceof CryptoKey?__mmStoreKey(r):(r&&r.publicKey instanceof CryptoKey&&r.privateKey instanceof CryptoKey)?{__mmPair:true,publicKey:__mmStoreKey(r.publicKey),privateKey:__mmStoreKey(r.privateKey)}:r;const __mmInOne=a=>{if(a&&typeof a==='object'&&Object.hasOwn(a,'__mmKeyRef')){const k=__mmKeyStore.get(a.__mmKeyRef);if(!k)throw new TypeError('Unknown CryptoKey handle');return k;}return a;};const __mmIn=a=>{if(a&&typeof a==='object'&&Object.hasOwn(a,'__mmKeyRef'))return __mmInOne(a);if(a&&typeof a==='object'&&Object.getPrototypeOf(a)===Object.prototype){const o={};for(const [k,v] of Object.entries(a))o[k]=__mmInOne(v);return o;}return a;};const __mmRelay=(w,d)=>{if(!d||d.type!=='subtle-call')return false;const reply=x=>{try{w.postMessage({subtleReply:x})}catch(e){w.postMessage({subtleReply:{id:d.id,ok:false,error:String(e),name:'DataCloneError'}})}};if(!__mmAllowed.has(d.method)||!Array.isArray(d.args)||!self.crypto?.subtle){reply({id:d.id,ok:false,error:'SubtleCrypto method unavailable: '+String(d.method),name:'NotSupportedError'});return true;}Promise.resolve().then(()=>crypto.subtle[d.method](...d.args.map(__mmIn))).then(result=>reply({id:d.id,ok:true,result:__mmOut(result)}),e=>reply({id:d.id,ok:false,error:e?.message||String(e),name:e?.name||'OperationError'}));return true;};`;}
