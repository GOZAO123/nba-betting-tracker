"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");
const {makeOfflineFixedOriginOddsPapiTransport}=require("./manual-odds-fixed-transport");
const {makeOfflineManualEvidenceAudit}=require("./manual-evidence-receipt");
const KEY="SYNTHETIC_SECRET_ABC";
const BASE=Date.parse("2026-11-17T10:00:00.000Z");
const iso=m=>new Date(BASE+m*60000).toISOString();
const owner={auth:{uid:"synthetic-owner",token:{email_verified:true}},data:{}};
const CATALOGUE=[{marketId:101,sportId:11,playerProp:true,
  marketName:"Over Under Player Points (incl. overtime)",period:"result",
  handicap:20.5,outcomes:[{outcomeId:201,outcomeName:"Over"},
    {outcomeId:202,outcomeName:"Under"}]}];
const ODDS=[{fixtureId:"synthetic-d9-1",sportId:11,tournamentId:132,
  hasOdds:true,statusId:0,startTime:iso(180),
  participant1Id:"5001",participant2Id:"5002",playerName:"SECRET_PLAYER",
  bookmakerOdds:{"betano.pt":{bookmakerIsActive:true,suspended:false,
    markets:{"101":{marketActive:true,outcomes:{"201":{
      players:{"301":{playerName:"SECRET_PLAYER",price:1.87,active:true,
        changedAt:iso(-2)}}}}}}}}}];

function response(payload,config={}) {
  const data=config.data ?? new TextEncoder().encode(JSON.stringify(payload));
  const mode=config.mode||"normal";
  return {
    ok:config.ok??true,redirected:config.redirected??false,
    url:config.url??"",headers:{get:name=>
      name==="content-type"?(config.contentType??"application/json"):
      name==="content-length"?(config.contentLength??null):null},
    body:mode==="noBody"?null:mode==="noReader"?{}:new ReadableStream({
      start(controller){
        if(mode==="streamError") {controller.error(new Error("SENSITIVE_STREAM_FAILURE"));return;}
        controller.enqueue(data);controller.close();
      }
    })
  };
}
function setup(config={}) {
 const calls=[];let keys=0;
 const fetchImpl=async(url,options)=>{
   calls.push({url,options});
   if(config.reject) throw Error("SENSITIVE_PROVIDER_URL_"+KEY);
   if(config.redirected)return response({ok:true},{redirected:true,url});
   if(config.moved)return response({ok:true},{url:"https://evil.example/json"});
   if(config.httpError)return response({error:"SENSITIVE_"+KEY},{ok:false,url});
   return response(url.includes("/v4/markets")?CATALOGUE:ODDS,{
     ...config,url:config.changedUrl??url
   });
 };
 const transport=makeOfflineFixedOriginOddsPapiTransport({
   getApiKey:()=>{keys++;return config.key??KEY;},
   fetchImpl,makeSignal:ms=>({syntheticTimeout:ms})
 });
 return {transport,calls,getKeys:()=>keys};
}

test("35.1D9 construction performs no secret lookup or HTTP call",()=>{
 const s=setup();assert.equal(s.getKeys(),0);assert.equal(s.calls.length,0);
});
test("35.1D9 exact catalogue endpoint, language and no redirect",async()=>{
 const s=setup(),data=await s.transport.fetchCatalogue();
 assert.deepEqual(data,CATALOGUE);
 assert.equal(s.calls.length,1);
 const request=s.calls[0],url=new URL(request.url);
 assert.equal(url.origin,"https://api.oddspapi.io");
 assert.equal(url.pathname,"/v4/markets");
 assert.deepEqual([...url.searchParams.keys()].sort(),["apiKey","language"]);
 assert.equal(url.searchParams.get("language"),"en");
 assert.equal(url.searchParams.get("apiKey"),KEY);
 assert.deepEqual(request.options.headers,{Accept:"application/json"});
 assert.equal(request.options.redirect,"error");
 assert.equal(request.options.method,"GET");
 assert.equal(request.options.cache,"no-store");
 assert.equal(request.options.credentials,"omit");
 assert.equal(request.options.signal.syntheticTimeout,35000);
});
test("35.1D9 exact league endpoint and only NBA/betano audit parameters",async()=>{
 const s=setup(),data=await s.transport.fetchOdds();
 assert.deepEqual(data,ODDS);
 const url=new URL(s.calls[0].url);
 assert.equal(url.origin,"https://api.oddspapi.io");
 assert.equal(url.pathname,"/v4/odds-by-tournaments");
 assert.deepEqual([...url.searchParams.keys()].sort(),
   ["apiKey","bookmaker","language","tournamentIds","verbosity"]);
 assert.equal(url.searchParams.get("tournamentIds"),"132");
 assert.equal(url.searchParams.get("bookmaker"),"betano.pt");
 assert.equal(url.searchParams.get("verbosity"),"3");
 assert.equal(url.searchParams.get("language"),"en");
});
test("35.1D9 ignores attempted caller overrides for path, host, team or bookmaker",async()=>{
 const s=setup();
 await s.transport.fetchOdds({host:"evil.example",bookmaker:"other",tournamentIds:"8"});
 const url=new URL(s.calls[0].url);
 assert.equal(url.hostname,"api.oddspapi.io");
 assert.equal(url.searchParams.get("bookmaker"),"betano.pt");
 assert.equal(url.searchParams.get("tournamentIds"),"132");
});
test("35.1D9 query-encodes credential without interpreting it as new parameters",async()=>{
 const s=setup({key:"STRANGE&key=ESCAPE?OK"});
 await s.transport.fetchOdds();
 const url=new URL(s.calls[0].url);
 assert.equal(url.searchParams.get("apiKey"),"STRANGE&key=ESCAPE?OK");
 assert.equal([...url.searchParams.keys()].filter(x=>x==="apiKey").length,1);
 assert.equal(url.searchParams.get("key"),null);
});
test("35.1D9 no secret lookup if a transport is merely constructed",()=>{
 const s=setup();assert.equal(s.getKeys(),0);
});
test("35.1D9 rejects missing or control-character credentials before HTTP",async()=>{
 for(const key of ["", "A\nB","A".repeat(257)]) {
   const s=setup({key});
   await assert.rejects(s.transport.fetchOdds(),/transport unavailable/);
   assert.equal(s.calls.length,0);
 }
});
test("35.1D9 server errors cannot expose credential, URL, provider error or response body",async()=>{
 for(const opts of [{reject:true},{httpError:true}]) {
   const s=setup(opts);
   await assert.rejects(s.transport.fetchOdds(),error=>{
     assert.match(error.message,/transport unavailable/);
     assert.doesNotMatch(error.message,/SYNTHETIC_SECRET|SENSITIVE|http|oddspapi\.io|apiKey/i);
     return true;
   });
   assert.equal(s.calls.length,1);
 }
});
test("35.1D9 refuses redirects instead of following them",async()=>{
 const s=setup({redirected:true});
 await assert.rejects(s.transport.fetchOdds(),/transport unavailable/);
 assert.equal(s.calls[0].options.redirect,"error");
 assert.equal(s.calls.length,1);
});
test("35.1D9 refuses a successful response from a different origin",async()=>{
 const s=setup({moved:true});
 await assert.rejects(s.transport.fetchCatalogue(),/transport unavailable/);
 assert.equal(s.calls.length,1);
});
test("35.1D9 rejects non-JSON Content-Type",async()=>{
 const s=setup({contentType:"text/html"});
 await assert.rejects(s.transport.fetchOdds(),/transport unavailable/);
});
test("35.1D9 accepts +json type without requiring text matching odds provider secrets",async()=>{
 const s=setup({contentType:"application/problem+json"});
 assert.deepEqual(await s.transport.fetchCatalogue(),CATALOGUE);
});
test("35.1D9 rejects huge Content-Length without reading the stream",async()=>{
 const s=setup({contentLength:String(12*1024*1024+1)});
 await assert.rejects(s.transport.fetchOdds(),/transport unavailable/);
 assert.equal(s.calls.length,1);
});
test("35.1D9 catalogue has separate 32MiB ceiling, not league 12MiB ceiling",async()=>{
 const s=setup({contentLength:String(12*1024*1024+1)});
 assert.deepEqual(await s.transport.fetchCatalogue(),CATALOGUE);
});
test("35.1D9 streamed response over 12MiB is refused even without Content-Length",async()=>{
 const s=setup({data:new Uint8Array(12*1024*1024+1)});
 await assert.rejects(s.transport.fetchOdds(),/transport unavailable/);
 assert.equal(s.calls.length,1);
});
test("35.1D9 invalid streamed JSON is refused",async()=>{
 const s=setup({data:new TextEncoder().encode("{invalid")});
 await assert.rejects(s.transport.fetchCatalogue(),/transport unavailable/);
});
test("35.1D9 scalar JSON is refused",async()=>{
 const s=setup({data:new TextEncoder().encode("7")});
 await assert.rejects(s.transport.fetchOdds(),/transport unavailable/);
});
test("35.1D9 empty or nonstreamable response fails closed",async()=>{
 for(const mode of ["noBody","noReader","streamError"]) {
   const s=setup({mode});
   await assert.rejects(s.transport.fetchOdds(),/transport unavailable/);
 }
});
test("35.1D9 malformed response stream and byte chunk are safely rejected",async()=>{
 const factory=makeOfflineFixedOriginOddsPapiTransport({
   getApiKey:()=>KEY,makeSignal:()=>({}),
   fetchImpl:async()=>({ok:true,redirected:false,headers:{get:()=>null},
     body:{getReader:()=>({read:async()=>({done:false,value:"NOT_BYTES"}),
       cancel:async()=>{},releaseLock:()=>{}})}})
 });
 await assert.rejects(factory.fetchCatalogue(),/transport unavailable/);
});
test("35.1D9 one request only on provider failure; never retry automatically",async()=>{
 const s=setup({reject:true});
 await assert.rejects(s.transport.fetchOdds(),/transport unavailable/);
 assert.equal(s.calls.length,1);
 assert.equal(s.getKeys(),1);
});
test("35.1D9 safe dependency validation, no global fetch access",()=>{
 for(const opts of [{},{getApiKey:()=>KEY},{fetchImpl:async()=>{}},
   {getApiKey:()=>KEY,fetchImpl:async()=>{},makeSignal:null}])
  assert.throws(()=>makeOfflineFixedOriginOddsPapiTransport(opts),
    /Missing trusted provider transport dependencies/);
});
test("35.1D9 unauthorized owner cannot invoke transport through D8 manual wrapper",async()=>{
 const s=setup();let reserved=0;
 const runner=makeOfflineManualEvidenceAudit({
   ownerUid:"synthetic-owner",db:{doc:p=>({path:p}),runTransaction:async()=>{}},
   now:()=>BASE,reserve:async()=>{reserved++;},
   fetchCatalogue:s.transport.fetchCatalogue,fetchOdds:s.transport.fetchOdds
 });
 for(const invalid of [
   {auth:{uid:"intruder",token:{email_verified:true}},data:{}},
   {auth:{uid:"synthetic-owner",token:{email_verified:false}},data:{}},
   {auth:owner.auth,data:{force:true}}
 ]) await assert.rejects(runner(invalid));
 assert.equal(reserved,0);assert.equal(s.getKeys(),0);assert.equal(s.calls.length,0);
});
test("35.1D9 rejected reservation never reads secret or calls provider",async()=>{
 const s=setup();let reservations=0;
 const runner=makeOfflineManualEvidenceAudit({
   ownerUid:"synthetic-owner",db:{doc:p=>({path:p}),runTransaction:async()=>{}},
   now:()=>BASE,reserve:async()=>{reservations++;throw Error("daily cap");},
   fetchCatalogue:s.transport.fetchCatalogue,fetchOdds:s.transport.fetchOdds
 });
 await assert.rejects(runner(owner),/daily cap/);
 assert.equal(reservations,1);assert.equal(s.calls.length,0);assert.equal(s.getKeys(),0);
});
test("35.1D9 successful owner-only manual audit calls only catalogue then league once",async()=>{
 const s=setup();let slots=0;const docs=new Map();
 const db={doc:p=>({path:p}),runTransaction:async fn=>{
   const pending=[];
   const result=await fn({
     get:async ref=>({exists:docs.has(ref.path),data:()=>docs.get(ref.path)}),
     create:(ref,data)=>{pending.push([ref.path,data]);}
   });
   for(const [p,d] of pending)docs.set(p,d);
   return result;
 }};
 const runner=makeOfflineManualEvidenceAudit({
   ownerUid:"synthetic-owner",db,now:()=>BASE,
   reserve:async n=>{slots+=n;},fetchCatalogue:s.transport.fetchCatalogue,
   fetchOdds:s.transport.fetchOdds
 });
 const first=await runner(owner),second=await runner(owner);
 assert.equal(first.activePriceEntries,1);
 assert.equal(first.researchSaved,false);
 assert.equal(second.cached,true);
 assert.equal(slots,2);
 assert.equal(s.calls.length,2);
 assert.equal(s.getKeys(),2);
 assert.equal(docs.size,1);
 const stored=[...docs.values()][0];
 assert.equal(stored.status,"UNREVIEWED_PROVIDER_EVIDENCE");
 assert.doesNotMatch(JSON.stringify(stored),/SECRET_PLAYER|SYNTHETIC_SECRET|1\.87/);
});
test("35.1D9 no production wiring or provider activity without a call",()=>{
 const src=fs.readFileSync(path.join(__dirname,"manual-odds-fixed-transport.js"),"utf8");
 const production=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
 const rules=fs.readFileSync(path.join(__dirname,"..","firestore.rules"),"utf8");
 assert.doesNotMatch(production,/manual-odds-fixed-transport|makeOfflineFixedOriginOddsPapiTransport/);
 assert.doesNotMatch(src,/setInterval\(|onSchedule\(|onCall\(|firebase-admin|firebase-functions|globalThis\.fetch/);
 assert.doesNotMatch(rules,/teamEvidence|providerSnapshots/);
});
