'use strict';
// Offline read-only adapter for the existing journal factory. This is NOT a
// verified-review loader: source custody, freshness and registry remain gates.
function makeTransactionJournalReader({db,makeOfflineFixtureReviewJournal}={}) {
  if(typeof db?.doc!=='function'||typeof makeOfflineFixtureReviewJournal!=='function') throw TypeError('Trusted dependencies required');
  return async function readApprovedJournal(tx,fixtureId) {
    try {
      if(typeof fixtureId!=='string'||!/^[A-Za-z0-9._:-]{1,120}$/.test(fixtureId)||typeof tx?.get!=='function') return null;
      const root='_internal/teamReview/fixtureJournals/'+fixtureId;
      let reads=0;
      async function read(path) {
        if(path!==root&&!/^events\/\d{6}$/.test(path.slice(root.length+1))) throw Error('Unexpected path');
        if(path!==root&&!path.startsWith(root+'/')) throw Error('Unexpected path');
        if(++reads>33) throw Error('Read bound exceeded');
        const ref=db.doc(path);
        if(ref?.path!==path) throw Error('Invalid reference');
        return tx.get(ref);
      }
      const facade={
        doc(path){return {path,get:()=>read(path)};},
        async getAll(...refs){const out=[];for(const ref of refs)out.push(await read(ref.path));return out;},
        async runTransaction(){throw Error('Nested transaction prohibited');}
      };
      const history=await makeOfflineFixtureReviewJournal({db:facade}).loadHistory(fixtureId);
      // Current journal state machine permits only an initial APPROVE, an
      // initial REJECT, or APPROVE followed by REVOKE. Only APPROVE authorizes
      // further validation. No event alone proves source or registry validity.
      if(!Array.isArray(history)||history.length!==1||history[0]?.action!=='APPROVE'||history[0].revision!==1) return null;
      const event=history[0];
      return Object.freeze({status:'APPROVED_JOURNAL_ONLY',fixtureId,reviewRevision:event.revision,reviewEventDigest:event.eventDigest,sourcePacketDigest:event.packetDigest,reviewedAt:event.reviewedAt,pairs:Object.freeze(event.pairs.map(p=>Object.freeze({...p})))});
    } catch {return null;}
  };
}
module.exports={makeTransactionJournalReader};
