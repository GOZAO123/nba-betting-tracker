"use strict";

// D15.7 OFFLINE ONLY: lazily construct the REAL GoogleAuth API boundary
// for the future caller. This file is not imported by production index.js.
// No metadata requests or credentials are read during module import or
// factory construction. Do NOT install keys or deploy this from this PR.
function defaultLoadGoogleAuth(){
  // A future production integration must explicitly review and lock a direct
  // google-auth-library dependency before enabling any live invocation.
  return require("google-auth-library");
}
function makeOfflineGoogleIdTokenClientFactory({
  loadGoogleAuth=defaultLoadGoogleAuth
}={}){
  if(typeof loadGoogleAuth!=="function")
    throw new TypeError("Missing trusted GoogleAuth loader.");
  let auth=null;
  return Object.freeze(async function getIdTokenClient(audience){
    if(typeof audience!=="string"||audience.length===0||audience.length>200)
      throw new Error("Invalid trusted token audience.");
    try{
      if(auth===null){
        const module=loadGoogleAuth();
        if(!module||typeof module.GoogleAuth!=="function")
          throw new Error("GoogleAuth missing");
        // Deliberately no JSON key, credential object, service-account
        // impersonation, scopes, additional headers or user-provided config.
        const instance=new module.GoogleAuth();
        if(!instance||typeof instance.getIdTokenClient!=="function")
          throw new Error("Invalid GoogleAuth");
        auth=instance;
      }
      const client=await auth.getIdTokenClient(audience);
      if(!client||typeof client.getRequestHeaders!=="function")
        throw new Error("Invalid ID token client");
      return client;
    }catch(_){
      // Do not include metadata, local file paths, token or library errors.
      throw new Error("Private Google identity token unavailable.");
    }
  });
}
module.exports=Object.freeze({makeOfflineGoogleIdTokenClientFactory});
