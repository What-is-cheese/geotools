// The Supabase details are stored encrypted in waypoints.html. The key is in the invite link, after the #, which browsers
// never send to a web server. AES-256-GCM, so a wrong key fails instead of giving garbage. Runs in browsers and in Node.
(function(root){
  var subtle = root.crypto.subtle;
  function toB64(bytes){
    var s = ''; bytes.forEach(function(b){ s += String.fromCharCode(b); });
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function fromB64(text){
    var s = atob(text.replace(/-/g, '+').replace(/_/g, '/')), out = new Uint8Array(s.length);
    for(var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  function aes(raw, use){ return subtle.importKey('raw', raw, 'AES-GCM', false, [use]); }
  function newKey(){ return toB64(root.crypto.getRandomValues(new Uint8Array(32))); }
  // config: {url, key}. Returns the text to store in the page: iv + ciphertext.
  function encrypt(config, key){
    var iv = root.crypto.getRandomValues(new Uint8Array(12));
    return aes(fromB64(key), 'encrypt').then(function(k){
      return subtle.encrypt({name:'AES-GCM', iv:iv}, k, new TextEncoder().encode(JSON.stringify(config)));
    }).then(function(c){
      var out = new Uint8Array(12 + c.byteLength); out.set(iv); out.set(new Uint8Array(c), 12);
      return toB64(out);
    });
  }
  // Rejects if the key is wrong or the stored text has been changed.
  function decrypt(blob, key){
    return Promise.resolve().then(function(){
      var data = fromB64(blob);
      return aes(fromB64(key), 'decrypt').then(function(k){
        return subtle.decrypt({name:'AES-GCM', iv:data.slice(0, 12)}, k, data.slice(12));
      });
    }).then(function(p){ return JSON.parse(new TextDecoder().decode(p)); });
  }
  var api = {newKey:newKey, encrypt:encrypt, decrypt:decrypt};
  if(typeof module !== 'undefined' && module.exports) module.exports = api; else root.GeoLink = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
