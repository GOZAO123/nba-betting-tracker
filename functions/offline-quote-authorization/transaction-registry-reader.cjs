"use strict";
// Offline read-only rehearsal; mirrors pinned D18 registry schema.
// Local consistency is not global completeness or collection authorization.
const ROOT="_internal/teamReview/";
const ID=/^[1-9][0-9]{0,15}$/;
const FID=/^[A-Za-z0-9._:-]{1,120}$/;
const valid=(x,re)=>typeof x==="string"&&re.test(x);
function exact(x,keys){
  if(!x||Object.getPrototypeOf(x)!==Object.prototype)return false;
  const actual=Reflect.ownKeys(x);
  return actual.length===keys.length&&keys.every(k=>Object.hasOwn(x,k)&&Object.getOwnPropertyDescriptor(x,k).get===undefined&&Object.hasOwn(Object.getOwnPropertyDescriptor(x,k),"value"));
}
function claims(row,pair,fixtureId){
  if(!exact(row,["schemaVersion","providerParticipantId","espnTeamId","fixtureIds"])||row.schemaVersion!==1||row.providerParticipantId!==pair.providerParticipantId||row.espnTeamId!==pair.espnTeamId)return null;
  const ids=row.fixtureIds;
  if(!Array.isArray(ids)||ids.length===0||ids.length>128)return null;
  for(let i=0;i<ids.length;i++)if(!Object.hasOwn(ids,i)||!valid(ids[i],FID)||(i>0&&ids[i-1]>=ids[i]))return null;
  return ids.includes(fixtureId)?[...ids]:null;
}
async function readRegistry({db,tx,fixtureId,pairs}={}){
  try{
    if(typeof db?.doc!=="function"||typeof tx?.get!=="function"||!valid(fixtureId,FID)||!Array.isArray(pairs)||pairs.length!==2)return null;
    const pinned=[];
    for(const pair of pairs){
      if(!exact(pair,["providerParticipantId","espnTeamId"])||!valid(pair.providerParticipantId,ID)||!valid(pair.espnTeamId,ID))return null;
      pinned.push(Object.freeze({...pair}));
    }
    if(pinned[0].providerParticipantId===pinned[1].providerParticipantId||pinned[0].espnTeamId===pinned[1].espnTeamId)return null;
    const paths=pinned.flatMap(p=>[ROOT+"globalProviderIds/"+p.providerParticipantId,ROOT+"globalEspnIds/"+p.espnTeamId]);
    const refs=paths.map(path=>db.doc(path));
    if(refs.some((r,i)=>r?.path!==paths[i]))return null;
    const snapshots=await Promise.all(refs.map(ref=>tx.get(ref)));
    const lists=snapshots.map((s,i)=>s?.exists===true&&typeof s.data==="function"?claims(s.data(),pinned[Math.floor(i/2)],fixtureId):null);
    if(lists.some(x=>x===null))return null;
    for(const i of [0,2])if(lists[i].length!==lists[i+1].length||lists[i].some((v,j)=>v!==lists[i+1][j]))return null;
    return Object.freeze({status:"REGISTRY_CONSISTENCY_ONLY",fixtureId,pairs:Object.freeze(pinned)});
  }catch(_){return null;}
}
module.exports={readRegistry};
