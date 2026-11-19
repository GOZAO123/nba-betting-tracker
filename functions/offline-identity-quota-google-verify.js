"use strict";

// D15.8 UNWIRED broker-side Google-signed ID-token verifier.
// Real OAuth2Client.verifyIdToken() validates signature/certificate, issuer,
// expiration, and audience. No module import or network request until invoked.
// Production must add a separately reviewed, pinned google-auth-library direct
// dependency; this file is NOT registered by functions/index.js.
function defaultLoad(){return require("google-auth-library");}
function makeOfflineGoogleIdentityVerifier({loadGoogleAuth=defaultLoad}={}){
  if(typeof loadGoogleAuth!=="function")
    throw new TypeError("Missing trusted Google identity verifier loader.");
  let client=null;
  return Object.freeze(async function verifyIdToken(idToken,audience){
    if(typeof idToken!=="string"||idToken.length<5||idToken.length>8192||
       !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(idToken)||
       typeof audience!=="string"||!audience)
      throw new Error("Google service identity unavailable.");
    try{
      if(client===null){
        const lib=loadGoogleAuth();
        if(!lib||typeof lib.OAuth2Client!=="function")
          throw new Error("Verifier module not available.");
        client=new lib.OAuth2Client();
        if(typeof client.verifyIdToken!=="function")
          throw new Error("Verifier API not available.");
      }
      // NEVER decode JWT bytes and treat payload as authenticated.
      const ticket=await client.verifyIdToken({idToken,audience});
      if(!ticket||typeof ticket.getPayload!=="function")
        throw new Error("Invalid signed identity result.");
      const claims=ticket.getPayload();
      if(!claims||typeof claims!=="object"||Array.isArray(claims))
        throw new Error("Invalid signed identity claims.");
      // Additional exact principal + Google issuer + expiration checks are
      // performed in D15.5's makeOfflineAuthenticatedQuotaIngress.
      return claims;
    }catch(_){
      // No signing keys, certificate URLs or internal library error leakage.
      throw new Error("Google service identity unavailable.");
    }
  });
}
module.exports=Object.freeze({makeOfflineGoogleIdentityVerifier});
