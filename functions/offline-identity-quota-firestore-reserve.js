"use strict";

// D15.8 UNWIRED Firestore transaction adapter. Uses the EXACT legacy
// shared reservation doc in (default) database. No direct admin import.
// A future broker must use its own reviewed, least-privileged runtime IAM;
// native Firestore IAM still cannot limit this identity to a single document.
const DOC="_internal/oddsPapiDailyDiagnosticBudget";
const LIMIT=6;
function makeOfflineSharedBudgetReservation({getFirestore,now=()=>Date.now()}={}){
  if(typeof getFirestore!=="function"||typeof now!=="function")
    throw new TypeError("Missing trusted shared-budget backend adapters.");
  return Object.freeze(async function reserve(amount){
    if(amount!==1)throw new Error("Only one budget slot is permitted.");
    try{
      const tick=now();
      if(!Number.isSafeInteger(tick)||tick<0)throw new Error("Invalid clock");
      const instant=new Date(tick).toISOString(),day=instant.slice(0,10);
      const db=getFirestore();
      if(!db||typeof db.doc!=="function"||
         typeof db.runTransaction!=="function")throw new Error("Invalid db");
      const ref=db.doc(DOC);
      return await db.runTransaction(async tx=>{
        const snapshot=await tx.get(ref);
        const previous=snapshot?.exists?snapshot.data():null;
        const sameDay=previous?.utcDay===day;
        const taken=sameDay?previous.reserved:0;
        if(sameDay && (!Number.isSafeInteger(taken)||taken<0||
                       taken>LIMIT||previous.limit!==LIMIT))
          throw new Error("Invalid shared counter");
        if(taken+1>LIMIT)throw new Error("Shared counter exhausted");
        const updated=taken+1;
        tx.set(ref,{utcDay:day,reserved:updated,limit:LIMIT,
          lastReservedAt:instant});
        return {utcDay:day,remaining:LIMIT-updated};
      },{maxAttempts:5});
    }catch(_){
      // A failed or uncertain transaction is NOT a reservation receipt.
      throw new Error("Shared daily budget unavailable.");
    }
  });
}
module.exports=Object.freeze({makeOfflineSharedBudgetReservation});
