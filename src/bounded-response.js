/* Bounded UTF-8 response reader for cross-origin provider replies. */
export const DEFAULT_RESPONSE_MAX_BYTES = 1_048_576;
export class ResponseTooLargeError extends Error {
  constructor(limit) { super(`Provider response exceeds the ${limit}-byte limit.`); this.name='ResponseTooLargeError'; this.limit=limit; }
}
export async function readBoundedResponseText(response,{maxBytes=DEFAULT_RESPONSE_MAX_BYTES,signal}={}) {
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>8_388_608)throw new RangeError('Invalid provider response byte limit.');
  const length=response.headers?.get?.('content-length');
  if(length!=null&&/^\d+$/.test(length)&&Number(length)>maxBytes)throw new ResponseTooLargeError(maxBytes);
  if(signal?.aborted)throw signal.reason??new DOMException('Aborted','AbortError');
  const stream=response.body;
  if(!stream||typeof stream.getReader!=='function'){
    // Compatibility for test fixtures and older fetch implementations. Production
    // browser Responses use streaming; fallback checks the size after buffering.
    const result=await response.text();
    if(new TextEncoder().encode(result).byteLength>maxBytes)throw new ResponseTooLargeError(maxBytes);
    return result;
  }
  const reader=stream.getReader(), chunks=[];let total=0,completed=false;
  const onAbort=()=>{void reader.cancel(signal.reason).catch(()=>{});};
  signal?.addEventListener('abort',onAbort,{once:true});
  try{
    while(true){
      if(signal?.aborted)throw signal.reason??new DOMException('Aborted','AbortError');
      const {done,value}=await reader.read();
      if(signal?.aborted)throw signal.reason??new DOMException('Aborted','AbortError');
      if(done){completed=true;break;}
      if(!(value instanceof Uint8Array))throw new TypeError('Invalid provider body chunk.');
      total+=value.byteLength;
      if(total>maxBytes)throw new ResponseTooLargeError(maxBytes);
      chunks.push(value);
    }
    const all=new Uint8Array(total);let at=0;for(const chunk of chunks){all.set(chunk,at);at+=chunk.byteLength;}
    return new TextDecoder().decode(all);
  }finally{
    signal?.removeEventListener('abort',onAbort);
    if(!completed){try{await reader.cancel();}catch{}}
    try{reader.releaseLock();}catch{}
  }
}
