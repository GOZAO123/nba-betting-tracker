"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {readRegistry}=require("./transaction-registry-reader.cjs");
const root="_internal/teamReview/";
function setup(){
  const fixtureId="synthetic-fixture-1";
  const pairs=[{providerParticipantId:"5001",espnTeamId:"13"},{providerParticipantId:"5002",espnTeamId:"14"}];
  const paths=pairs.flatMap(p=>[root+"globalProviderIds/"+p.providerParticipantId,root+"globalEspnIds/"+p.espnTeamId]);
  const rows=paths.map((_,i)=>({schemaVersion:1,...pairs[Math.floor(i/2)],fixtureIds:[fixtureId]}));
  const reads=[];
  const db={doc:path=>({path})};
  const tx={async get(ref){reads.push(ref.path);const row=rows[paths.indexOf(ref.path)];return {exists:row!==null,data:()=>structuredClone(row)};}};
  return {input:{db,tx,fixtureId,pairs},rows,paths,reads};
}
test("valid four exact transaction reads and frozen non-authorizing result",async()=>{const s=setup();const r=await readRegistry(s.input);assert.deepEqual(r,{status:"REGISTRY_CONSISTENCY_ONLY",fixtureId:s.input.fixtureId,pairs:s.input.pairs});assert.deepEqual(s.reads,s.paths);assert.ok(Object.isFrozen(r)&&Object.isFrozen(r.pairs)&&r.pairs.every(Object.isFrozen));});
const cases=[
 ["missing provider",s=>s.rows[0]=null],
 ["missing reverse",s=>s.rows[1]=null],
 ["missing second provider",s=>s.rows[2]=null],
 ["missing second reverse",s=>s.rows[3]=null],
 ["wrong provider ID",s=>s.rows[0].providerParticipantId="9001"],
 ["wrong ESPN ID",s=>s.rows[2].espnTeamId="99"],
 ["conflicting reverse mapping",s=>s.rows[1].providerParticipantId="5002"],
 ["missing fixture claim",s=>s.rows[0].fixtureIds=["another-fixture"]],
 ["duplicate fixture claim",s=>s.rows[0].fixtureIds=[s.input.fixtureId,s.input.fixtureId]],
 ["unsorted claims",s=>s.rows[0].fixtureIds=["zzz",s.input.fixtureId]],
 ["unequal bidirectional lists",s=>s.rows[1].fixtureIds=["another-fixture",s.input.fixtureId]],
 ["empty claims",s=>s.rows[0].fixtureIds=[]],
 ["oversized claims",s=>s.rows[0].fixtureIds=Array.from({length:129},(_,i)=>`a${String(i).padStart(3,"0")}`)],
 ["extra registry field",s=>s.rows[0].extra=true],
 ["wrong schema",s=>s.rows[0].schemaVersion=2],
 ["unsafe fixture claim",s=>s.rows[0].fixtureIds=["../unsafe",s.input.fixtureId]],
 ["numeric registry identity",s=>s.rows[0].providerParticipantId=5001],
 ["sparse fixture claims",s=>{s.rows[0].fixtureIds.length=2;}],
 ["transaction failure",s=>s.input.tx.get=async()=>{throw Error("test");}]
];
for(const [name,mutate] of cases)test(name,async()=>{const s=setup();mutate(s);assert.equal(await readRegistry(s.input),null);});
for(const [name,mutate] of [
 ["unsafe fixture",s=>s.input.fixtureId="../unsafe"],
 ["unsafe provider ID",s=>s.input.pairs[0].providerParticipantId="../x"],
 ["duplicate provider ID",s=>s.input.pairs[1].providerParticipantId="5001"],
 ["duplicate ESPN ID",s=>s.input.pairs[1].espnTeamId="13"],
 ["missing transaction",s=>s.input.tx=null],
 ["reference substitution",s=>s.input.db.doc=()=>({path:"wrong"})],
 ["extra pair field",s=>s.input.pairs[0].extra=true]
])test(name,async()=>{const s=setup();mutate(s);assert.equal(await readRegistry(s.input),null);assert.equal(s.reads.length,0);});
test("shared compatible claims accepted",async()=>{const s=setup();s.rows[0].fixtureIds=s.rows[1].fixtureIds=["another-fixture",s.input.fixtureId];assert.equal((await readRegistry(s.input)).status,"REGISTRY_CONSISTENCY_ONLY");});
test("pairs pinned before asynchronous reads",async()=>{const s=setup();const old=s.input.tx.get;s.input.tx.get=async ref=>{s.input.pairs[0].espnTeamId="99";return old(ref);};const result=await readRegistry(s.input);assert.equal(result.pairs[0].espnTeamId,"13");});
