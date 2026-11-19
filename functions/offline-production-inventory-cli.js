"use strict";

// D15.12 LOCAL, READ-ONLY, OFFLINE inventory checker.
// Usage from repository root in Windows PowerShell:
//   firebase.cmd functions:list --project nba-betting-tracker-3979d |
//     node .\functions\offline-production-inventory-cli.js
// Reads standard input + checked-out index.js only. Never calls Google APIs,
// reads environment variables, writes evidence to disk, or prints raw input.
const fs=require("node:fs"),path=require("node:path");
const {assessOfflineFunctionList}=
  require("./offline-production-function-inventory");
const MAX_BYTES=20000;
async function run(){
  if(process.argv.length!==2)
    throw Error("Extra command arguments are not permitted.");
  const chunks=[];let size=0;
  for await(const chunk of process.stdin){
    size+=chunk.length;
    if(size>MAX_BYTES)throw Error("Input too large.");
    chunks.push(chunk);
  }
  const text=Buffer.concat(chunks,size).toString("utf8");
  const source=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
  const report=assessOfflineFunctionList(text,source);
  process.stdout.write(JSON.stringify(report,null,2)+"\n");
  process.exitCode=report.inventoryMatches?0:2;
}
run().catch(()=>{
  // Do not reflect pasted data, error objects, paths or credentials.
  process.stdout.write(JSON.stringify({
    status:"BLOCKED",releaseReady:false,paidProviderAllowed:false,
    cloudChangesAuthorized:false,inventoryMatches:false,
    blockers:["OFFLINE_INVENTORY_UNAVAILABLE"]
  })+"\n");
  process.exitCode=2;
});
