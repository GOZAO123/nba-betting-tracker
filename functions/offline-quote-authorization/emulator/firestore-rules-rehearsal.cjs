'use strict';
// Local demo only. Client access is exclusively via Firebase ID tokens over REST.
const assert=require('node:assert/strict');
const {randomUUID,randomBytes}=require('node:crypto');
const {PROJECT, AUTH, FIRESTORE, assertDemoEnvironment, assertEmulatorsRunning}=require('./environment.cjs');
assertDemoEnvironment();
const request=(url,options={})=>fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(15000)});
const id=()=>randomBytes(16).toString('hex');
async function main(){
 await assertEmulatorsRunning();
 const {initializeApp,deleteApp}=require('firebase-admin/app');const app=initializeApp({projectId:PROJECT});
 const auth=require('firebase-admin/auth').getAuth(app), db=require('firebase-admin/firestore').getFirestore(app);
 const users=[], cleanup=new Set(), seeds=new Map(), absent=new Set();let checks=0;
 const marker={marker:'synthetic-original'};
 const pass=label=>{checks++;console.log('PASS: '+label);};
 async function identity(role,verified){
  const uid='rules-'+role+'-'+randomUUID(),email=uid+'@example.invalid',password=randomUUID()+'-Synthetic!';
  await auth.createUser({uid,email,password,emailVerified:verified});users.push(uid);
  const res=await request(`http://${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-emulator-key`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password,returnSecureToken:true})});
  assert.ok(res.ok,'Synthetic sign-in failed');const {idToken}=await res.json();assert.equal(typeof idToken,'string');const decoded=await auth.verifyIdToken(idToken);assert.equal(decoded.uid,uid);assert.equal(decoded.aud,PROJECT);assert.equal(decoded.email_verified,verified);return {role,uid,token:idToken};
 }
 async function client(actor,method,path,expected,exists){
  const suffix=exists===undefined?'':`?currentDocument.exists=${exists}`;
  const headers={};if(actor.token)headers.Authorization='Bearer '+actor.token;
  const opts={method,headers};if(method==='PATCH'){headers['Content-Type']='application/json';opts.body=JSON.stringify({fields:{marker:{stringValue:'client-write'}}});}
  const res=await request(`http://${FIRESTORE}/v1/projects/${PROJECT}/databases/(default)/documents/${path.split('/').map(encodeURIComponent).join('/')}${suffix}`,opts);
  const body=await res.json();const label=`${actor.role} ${method} ${expected===200?'allowed':'denied'}`;
  assert.equal(res.status,expected,label);if(expected===403)assert.equal(body.error?.status,'PERMISSION_DENIED',label);return body;
 }
 async function denied(actor,existing,missing,label){
  await client(actor,'GET',existing,403);await client(actor,'PATCH',existing,403,true);await client(actor,'DELETE',existing,403,true);await client(actor,'PATCH',missing,403,false);pass(`${label}: ${actor.role} read/update/delete/create denied`);
 }
 try{
  const owner=await identity('owner',true), other=await identity('other',true), unverified=await identity('unverified',false), anon={role:'anonymous'};
  const actors=[owner,other,unverified,anon];pass('Actual synthetic emulator identities verified');
  const checklist=u=>`users/${u.uid}/data/checklist`, ledger=(u,k)=>`users/${u.uid}/propResearchLedger/${k}`;
  for(const u of [owner,other,unverified]){seeds.set(checklist(u),marker);seeds.set(ledger(u,'existing-'+id()),marker);}
  const ownLedger=[...seeds.keys()].find(p=>p.startsWith(`users/${owner.uid}/propResearchLedger/`));const missingLedger=ledger(owner,'absent-'+id());absent.add(missingLedger);
  const privatePairs=[];
  const fixture='synthetic-rules-'+id(), fixture2='synthetic-rules-'+id();
  const pair=(label,p,q)=>{privatePairs.push({label,p,q});seeds.set(p,marker);absent.add(q);};
  pair('Scope-bound permit',`_internal/oneQuoteCollection/scopeBoundApprovals/${id()}`,`_internal/oneQuoteCollection/scopeBoundApprovals/${id()}`);
  pair('Legacy permit',`_internal/oneQuoteCollection/approvals/${id()}`,`_internal/oneQuoteCollection/approvals/${id()}`);
  pair('Fixture receipt',`_internal/teamEvidence/providerSnapshots/ODDSPAPI_MANUAL_${id().toUpperCase()}`,`_internal/teamEvidence/providerSnapshots/ODDSPAPI_MANUAL_${id().toUpperCase()}`);
  pair('Quote receipt',`_internal/quoteEvidence/providerObservations/${id()+id()}`,`_internal/quoteEvidence/providerObservations/${id()+id()}`);
  pair('Review journal',`_internal/teamReview/fixtureJournals/${fixture}`,`_internal/teamReview/fixtureJournals/${fixture2}`);
  pair('Review event',`_internal/teamReview/fixtureJournals/${fixture}/events/000001`,`_internal/teamReview/fixtureJournals/${fixture}/events/000002`);
  pair('Source binding',`_internal/teamReview/sourceBindings/${fixture}`,`_internal/teamReview/sourceBindings/${fixture2}`);
  pair('Provider source',`_internal/teamEvidence/fixtureTeamSnapshots/ODDSPAPI_FIXTURES_${id().toUpperCase()}`,`_internal/teamEvidence/fixtureTeamSnapshots/ODDSPAPI_FIXTURES_${id().toUpperCase()}`);
  pair('ESPN source',`_internal/teamReview/espnSnapshots/ESPN_${id().toUpperCase()}`,`_internal/teamReview/espnSnapshots/ESPN_${id().toUpperCase()}`);
  pair('Provider registry',`_internal/teamReview/globalProviderIds/${id()}`,`_internal/teamReview/globalProviderIds/${id()}`);
  pair('ESPN registry',`_internal/teamReview/globalEspnIds/${id()}`,`_internal/teamReview/globalEspnIds/${id()}`);
  // All paths use synthetic unique IDs. Refuse collisions before any client writes.
  const paths=[...seeds.keys(),...absent];assert.equal(new Set(paths).size,paths.length);
  for(const p of paths){assert.equal(p.split('/').length%2,0);assert.equal((await db.doc(p).get()).exists,false,'Synthetic path collision');}
  const batch=db.batch();for(const [p,v] of seeds)batch.create(db.doc(p),v);await batch.commit();for(const p of paths)cleanup.add(p);pass('Create-only seed and absent path checks');
  for(const u of [owner,other,unverified]){
   const p=checklist(u);await client(u,'GET',p,200);await client(u,'PATCH',p,200,true);await client(u,'DELETE',p,200,true);await client(u,'PATCH',p,200,false);pass(`${u.role} own checklist read/update/delete/create allowed`);
  }
  for(const actor of [other,unverified,anon]){
   const p=checklist(owner);await client(actor,'GET',p,403);await client(actor,'PATCH',p,403,true);await client(actor,'DELETE',p,403,true);
   // Temporarily remove only our own synthetic checklist to test denied creation.
   await db.doc(p).delete();try{await client(actor,'PATCH',p,403,false);}finally{await db.doc(p).set({marker:'client-write'});}pass(`${actor.role} owner checklist read/update/delete/create denied`);
  }
  await client(owner,'GET',ownLedger,200);await client(owner,'PATCH',ownLedger,403,true);await client(owner,'DELETE',ownLedger,403,true);await client(owner,'PATCH',missingLedger,403,false);pass('Owner ledger read allowed; update/delete/create denied');
  for(const a of [other,unverified,anon])await denied(a,ownLedger,missingLedger,'Owner ledger');
  for(const {label,p,q} of privatePairs)for(const a of actors)await denied(a,p,q,label);
  for(const [p,v] of seeds){if(p.endsWith('/data/checklist'))continue;const s=await db.doc(p).get();assert.ok(s.exists);assert.deepEqual(s.data(),v,'Protected record changed');}for(const p of absent)assert.equal((await db.doc(p).get()).exists,false,'Forbidden create persisted');pass('Protected records unchanged and forbidden creates absent');
 }finally{
  let docs=0,accounts=0,errors=0;
  for(const p of cleanup){try{if((await db.doc(p).get()).exists)await db.doc(p).delete();assert.equal((await db.doc(p).get()).exists,false);docs++;}catch{errors++;}}
  for(const uid of users){try{await auth.deleteUser(uid);accounts++;}catch{errors++;}}
  await db.terminate();await deleteApp(app);console.log(`Synthetic paths cleaned: ${docs}/${cleanup.size}`);console.log(`Synthetic users cleaned: ${accounts}/${users.length}`);assert.equal(errors,0,'Cleanup failed');
 }
 console.log(`FIRESTORE_RULES_REHEARSAL_PASSED checks=${checks}`);
}
main().catch(e=>{console.error('FIRESTORE_RULES_REHEARSAL_FAILED:',e.code||e.name||'Error');if(e instanceof assert.AssertionError)console.error(e.message);process.exitCode=1;});
