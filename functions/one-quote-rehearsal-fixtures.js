"use strict";

const NOW=Date.parse("2026-11-20T13:30:00.000Z");
const iso=m=>new Date(NOW+m*60000).toISOString();
const OWNER={auth:{uid:"synthetic-owner",token:{email_verified:true}},data:{}};
const SELECTOR=Object.freeze({
  fixtureId:"synthetic-d832-fixture",marketId:"91001",providerPlayerId:"93001"
});
const SCOPE=Object.freeze({
  participant1Id:"5001",participant2Id:"5002",startTime:iso(180),
  family:"PTS",line:20.5,playerName:"Synthetic D832 Athlete"
});
const catalog=()=>[{
  marketId:91001,sportId:11,playerProp:true,period:"result",
  marketName:"Over Under Player Points (incl. overtime)",handicap:20.5,
  outcomes:[{outcomeId:92001,outcomeName:"Over"},
    {outcomeId:92002,outcomeName:"Under"}]
}];
const quote=(price=1.88)=>({
  active:true,price,playerName:"Synthetic D832 Athlete",
  changedAt:iso(-2),mainLine:false
});
function fixture() {
  return {
    fixtureId:SELECTOR.fixtureId,sportId:11,tournamentId:132,
    statusId:0,hasOdds:true,startTime:iso(180),
    participant1Id:"5001",participant2Id:"5002",
    privateToken:"SYNTHETIC_PRIVATE_KEY_DO_NOT_STORE",
    bookmakerOdds:{"betano.pt":{bookmakerIsActive:true,
      suspended:false,markets:{"91001":{
        marketActive:true,outcomes:{
          "92001":{players:{"93001":quote(1.88)}},
          "92002":{players:{"93001":quote(1.92)}}
        }
      }}}
    }
  };
}

module.exports = {NOW, OWNER, SELECTOR, SCOPE, catalog, quote, fixture};
