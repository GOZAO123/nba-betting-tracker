"use strict";

// D15.11 OFFLINE ONLY: conservative transition contract. It is NOT imported
// by Firebase Functions, deployed or wired to provider traffic. Production
// keeps its original Firestore six-per-UTC-day reservation authority.
const LIMIT=6;
const failure=()=>Object.assign(new Error(
  "Shared daily diagnostic reservation unavailable. No provider request authorized."
),{code:"unavailable"});
const badAmount=()=>Object.assign(new Error(
  "Diagnostic reservations must be one or two slots."
),{code:"invalid-argument"});
const isObject=x=>x!==null&&typeof x==="object"&&!Array.isArray(x)&&
 (Object.getPrototypeOf(x)===Object.prototype||
  Object.getPrototypeOf(x)===null);
function exactDay(value){
  if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  try{
    return new Date(value+"T00:00:00.000Z").toISOString().slice(0,10)===value;
  }catch(_){return false;}
}
function checkReceipt(value,amount,expectedDay){
  return isObject(value)&&
    Object.keys(value).length===2&&
    Object.prototype.hasOwnProperty.call(value,"utcDay")&&
    Object.prototype.hasOwnProperty.call(value,"remaining")&&
    exactDay(value.utcDay)&&value.utcDay===expectedDay&&
    Number.isSafeInteger(value.remaining)&&
    value.remaining>=0&&value.remaining<=LIMIT-amount;
}
function makeOfflineDualQuotaGuard({reserveFirestore,reserveMetadata,
  now=()=>Date.now()}={}){
  if(typeof reserveFirestore!=="function"||
     typeof reserveMetadata!=="function"||typeof now!=="function")
    throw new TypeError("Invalid trusted offline dual-budget adapters.");
  const day=()=>{
    const tick=now();
    if(!Number.isSafeInteger(tick)||tick<0)throw failure();
    return new Date(tick).toISOString().slice(0,10);
  };
  return Object.freeze(async function reserve(amount){
    // No quota I/O for untrusted quantities. The backend must choose the
    // amount, never a browser, and may not request zero or more than two.
    if(amount!==1&&amount!==2)throw badAmount();
    try{
      const startDay=day();
      // Old Firestore guard FIRST while legacy production Functions remain
      // deployed. Its successful reservation can be wasted if the second
      // authority later rejects, but no paid provider call may follow.
      const legacy=await reserveFirestore(amount);
      if(!checkReceipt(legacy,amount,startDay))throw failure();
      const metadata=await reserveMetadata(amount);
      if(!checkReceipt(metadata,amount,startDay))throw failure();
      if(day()!==startDay)throw failure();
      // Both independent budgets must have acknowledged the exact amount
      // for the same UTC day; do not expose token, internal reason or URL.
      return Object.freeze({
        utcDay:startDay,remaining:Math.min(legacy.remaining,metadata.remaining)
      });
    }catch(_){
      // NEVER retry/rescind a possibly committed Firestore or metadata slot.
      // The caller must refuse its OddsPapi request on any uncertain state.
      throw failure();
    }
  });
}
module.exports=Object.freeze({makeOfflineDualQuotaGuard});
