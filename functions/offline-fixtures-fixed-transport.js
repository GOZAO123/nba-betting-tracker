"use strict";

// Issue #97 D17 — disconnected one-request fixed-origin fixtures transport.
// A future trusted backend caller MUST separately enforce verified-owner,
// one-use approval and shared Firestore UTC-day quota BEFORE invoking this.
// This module is never imported by production functions/index.js.
const ORIGIN="https://api.oddspapi.io";
const PATH="/v4/fixtures";
const LIMIT=4*1024*1024;
const MAX_CHUNKS=8192;
const TIMEOUT_MS=35000;
const SAFE_ERROR="Manual fixture transport unavailable; one reserved request may have been consumed.";

function makeOfflineFixedFixturesTransport({
  getApiKey,fetchImpl,makeSignal=ms=>AbortSignal.timeout(ms)
}={}) {
  if ([getApiKey,fetchImpl,makeSignal].some(x=>typeof x!=="function"))
    throw new TypeError("Missing trusted fixture transport dependencies.");

  async function fetchFixtures() {
    try {
      // No secret access on construction. Caller has already reserved quota.
      const key=getApiKey();
      if (typeof key!=="string" || !key || key.length>256 ||
          /[\u0000-\u001f\u007f]/.test(key))
        throw new Error("Invalid protected credential.");

      const url=new URL(ORIGIN+PATH);
      for (const [name,value] of Object.entries({
        sportId:"11",tournamentId:"132",language:"en",statusId:"0",
        hasOdds:"true",bookmakers:"betano.pt"
      })) url.searchParams.set(name,value);
      url.searchParams.set("apiKey",key);
      const target=url.toString();
      const response=await fetchImpl(target,Object.freeze({
        method:"GET",redirect:"error",cache:"no-store",credentials:"omit",
        headers:Object.freeze({Accept:"application/json"}),
        signal:makeSignal(TIMEOUT_MS)
      }));
      if (!response || response.ok!==true || response.redirected===true ||
          (typeof response.url==="string" && response.url.length>0 &&
           response.url!==target) ||
          !response.body || typeof response.body.getReader!=="function")
        throw new Error("Unexpected response.");

      const contentType=response.headers?.get?.("content-type");
      if (contentType!==null && contentType!==undefined &&
          !/^application\/(?:[a-z0-9.-]+\+)?json(?:\s*;|\s*$)/i.test(contentType))
        throw new Error("Invalid content type.");
      const contentLength=response.headers?.get?.("content-length");
      if (contentLength!==null && contentLength!==undefined && contentLength!=="") {
        if (!/^\d+$/.test(contentLength) || Number(contentLength)>LIMIT)
          throw new Error("Oversized fixture response.");
      }

      const reader=response.body.getReader();
      let done=false;
      const decoder=new TextDecoder("utf-8",{fatal:true});
      let text="",bytes=0,chunks=0;
      try {
        while (!done) {
          if (++chunks>MAX_CHUNKS) throw new Error("Too many chunks.");
          const part=await reader.read();
          if (!part || typeof part.done!=="boolean")
            throw new Error("Malformed stream.");
          if (part.done) {done=true;break;}
          if (!(part.value instanceof Uint8Array) ||
              part.value.byteLength<1) throw new Error("Malformed bytes.");
          bytes+=part.value.byteLength;
          if(bytes>LIMIT)throw new Error("Fixture response byte limit.");
          text+=decoder.decode(part.value,{stream:true});
        }
        text+=decoder.decode();
      } finally {
        if(!done) {
          try {await reader.cancel();}catch(_){}
        }
        try{reader.releaseLock();}catch(_){}
      }
      const decoded=JSON.parse(text);
      if(!Array.isArray(decoded) || decoded.length>250)
        throw new Error("Invalid fixture envelope.");
      return decoded;
    } catch (_) {
      // Do not expose provider text, URLs, API keys or status payloads.
      // A 429/timeout counts as an attempted request; never retry here.
      throw new Error(SAFE_ERROR);
    }
  }
  return Object.freeze({fetchFixtures});
}

module.exports={makeOfflineFixedFixturesTransport};
