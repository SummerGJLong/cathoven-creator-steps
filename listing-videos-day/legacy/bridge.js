/* Recovery for the old GitHub Pages origin. Original browser records are never removed. */
(function (root) {
  'use strict';
  const CANONICAL_URL = 'https://srv2054680.hstgr.cloud/listing-videos-day/';
  const API_URL = CANONICAL_URL + 'api/import';
  const LEGACY_KEYS = Object.freeze({videos:'listingVideosV2',types:'listingCustomTypes',examples:'listingExamplesV1'});
  const REQUEST_KEY = 'listingMigrationRequestV1';
  const RECEIPT_PREFIX = 'listingMigrationReceiptV1:';
  const clone = value => JSON.parse(JSON.stringify(value));

  function readLegacy(storage) {
    const result = {videos:[],types:[],examples:[],raw:{},errors:[]};
    for (const kind of Object.keys(LEGACY_KEYS)) {
      const key = LEGACY_KEYS[kind];
      try {
        const raw = storage.getItem(key);
        result.raw[key] = raw;
        if (raw === null) continue;
        try {
          const parsed = JSON.parse(raw);
          if (!Array.isArray(parsed)) throw new Error('Expected a saved list');
          result[kind] = parsed;
        } catch (_) {
          result.errors.push('The saved ' + kind + ' copy (' + key + ') could not be read. Download your saved copy for recovery.');
        }
      } catch (_) {
        result.raw[key] = null;
        result.errors.push('This browser did not allow access to ' + key + '. Open this page in the original browser with its storage enabled.');
      }
    }
    result.counts = {videos:result.videos.length,types:result.types.length,examples:result.examples.length};
    result.hasData = Object.values(result.counts).some(count => count > 0);
    return result;
  }

  function backupDocument(snapshot, now) {
    return {
      format:'listing-videos-legacy-backup-v1',exportedAt:(now || (()=>new Date().toISOString()))(),
      sourceOrigin:'https://summergjlong.github.io',
      videos:clone(snapshot.videos),types:clone(snapshot.types),examples:clone(snapshot.examples),
      raw:clone(snapshot.raw),errors:clone(snapshot.errors)
    };
  }

  async function browserDigest(text) {
    if (!root.crypto || !root.crypto.subtle) throw new Error('This browser cannot prepare a safe transfer. Download your saved copy and use a current browser.');
    const bytes = await root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(bytes), value=>value.toString(16).padStart(2,'0')).join('');
  }

  function browserUUID() {
    if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID();
    if (!root.crypto || !root.crypto.getRandomValues) throw new Error('This browser cannot prepare a safe transfer. Download your saved copy first.');
    const bytes = new Uint8Array(16);
    root.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');
    return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);
  }

  async function prepareOperation(storage, snapshot, options) {
    if (snapshot.errors.length) throw new Error('Your saved copy needs recovery before it can be moved. Download it first.');
    const data = {videos:clone(snapshot.videos),types:clone(snapshot.types),examples:clone(snapshot.examples)};
    const hash = await (options.digest || browserDigest)(JSON.stringify(data));
    let record = null;
    try { record = JSON.parse(storage.getItem(REQUEST_KEY) || 'null'); } catch (_) {}
    if (!record || record.hash !== hash || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.operationId || '')) {
      record = {hash,operationId:(options.uuid || browserUUID)()};
      try { storage.setItem(REQUEST_KEY, JSON.stringify(record)); }
      catch (_) { throw new Error('The transfer ID could not be kept in this browser. Download your saved copy first, then enable browser storage and retry.'); }
    }
    return {hash,body:Object.assign({operationId:record.operationId},data)};
  }

  function validAcknowledgment(body, snapshot) {
    if (!body || !Number.isInteger(body.revision) || !body.imported || !body.duplicates) return false;
    return Object.keys(LEGACY_KEYS).every(kind => {
      const added = body.imported[kind], duplicate = body.duplicates[kind];
      return Number.isInteger(added) && added >= 0 && Number.isInteger(duplicate) && duplicate >= 0 && added + duplicate === snapshot.counts[kind];
    });
  }

  class Bridge {
    constructor(options) {
      this.storage = options.storage;
      this.fetch = options.fetch;
      this.location = options.location;
      this.digest = options.digest || browserDigest;
      this.uuid = options.uuid || browserUUID;
      this.onChange = options.onChange || (()=>{});
      this.now = options.now || (()=>new Date().toISOString());
      this.timeoutMs = options.timeoutMs || 25000;
      this.AbortController = options.AbortController || root.AbortController;
      this.snapshot = null;
      this.busy = false;
      this.state = {phase:'loading',message:'Checking your saved copy…',retriable:false};
    }
    emit() { this.onChange(this.state, this.snapshot); }
    set(phase, message, extra) {
      this.state = Object.assign({phase,message,retriable:false},extra || {});
      this.emit();
    }
    init() {
      this.snapshot = readLegacy(this.storage);
      let recovery = false;
      try { recovery = new URL(this.location.href).searchParams.get('recover') === '1'; } catch (_) {}
      if (this.snapshot.errors.length) this.set('error',this.snapshot.errors.join('\n'));
      else if (!this.snapshot.hasData) {
        this.set('empty','No previous Listing Videos Day records were found in this browser.');
        if (!recovery) this.location.replace(CANONICAL_URL);
      } else this.set('ready','Your earlier browser copy is here. Move it once to add it to the shared list.');
      return this.snapshot;
    }
    async migrate() {
      if (this.busy) return false;
      // Another old tab may have added records since this recovery page opened.
      this.snapshot = readLegacy(this.storage);
      if (this.snapshot.errors.length) { this.set('error',this.snapshot.errors.join('\n')); return false; }
      if (!this.snapshot.hasData) { this.set('empty','No previous records were found. Open the new site below.'); return false; }
      const submitted = this.snapshot;
      this.busy = true;
      this.set('moving','Moving your saved copy… Keep this page open until the server confirms it.');
      let timer = null;
      try {
        const prepared = await prepareOperation(this.storage,submitted,{digest:this.digest,uuid:this.uuid});
        const abort = this.AbortController ? new this.AbortController() : null;
        if (abort) timer = setTimeout(()=>abort.abort(),this.timeoutMs);
        const response = await this.fetch(API_URL,{
          method:'POST',mode:'cors',credentials:'omit',
          headers:{'Content-Type':'application/json','X-Listing-Request':'1'},
          body:JSON.stringify(prepared.body),signal:abort ? abort.signal : undefined
        });
        let body = null;
        try { body = await response.json(); } catch (_) {}
        if (response.status === 429 || response.status >= 500) {
          this.set('retry','The shared server is temporarily unavailable. Your original copy is safe. Retry the move.',{retriable:true});
          return false;
        }
        if (response.status === 409) {
          this.set('conflict','A saved video conflicts with an existing shared submission. Nothing from this batch was moved. Download your saved copy and ask Summer to review the details below.',{conflicts:body && Array.isArray(body.conflicts) ? body.conflicts : []});
          return false;
        }
        if (!response.ok) {
          const detail = body && typeof body.message === 'string' ? '\n'+body.message.slice(0,1600) : '';
          this.set('error','This saved copy needs review before it can be moved. Your original copy is unchanged. Download it for recovery.'+detail);
          return false;
        }
        if (!validAcknowledgment(body,submitted)) {
          this.set('retry','The server did not confirm the complete move. Your original copy is safe. Retry with the same transfer ID.',{retriable:true});
          return false;
        }
        const receipt = {operationId:prepared.body.operationId,hash:prepared.hash,confirmedAt:this.now(),revision:body.revision,imported:body.imported,duplicates:body.duplicates};
        let receiptKept = true;
        try { this.storage.setItem(RECEIPT_PREFIX+prepared.hash,JSON.stringify(receipt)); } catch (_) { receiptKept=false; }
        const latest = readLegacy(this.storage);
        if (latest.errors.length) {
          this.snapshot = latest;
          this.set('error','The server confirmed the submitted copy, but the latest browser copy could not be read. Download your saved copy for recovery.',{receipt,receiptKept});
          return true;
        }
        const latestHash = await this.digest(JSON.stringify({videos:latest.videos,types:latest.types,examples:latest.examples}));
        if (latestHash !== prepared.hash) {
          this.snapshot = latest;
          this.set('ready','The server confirmed the submitted copy. More browser changes arrived while it was moving. Move the saved copy again to include them.',{receipt,receiptKept});
          return true;
        }
        const total = Object.values(submitted.counts).reduce((a,b)=>a+b,0);
        this.set('success','Moved successfully. The server confirmed all '+total+' saved record(s), including any already in the shared list. Your original browser copy stays here.',{receipt,receiptKept});
        return true;
      } catch (error) {
        const message = error && typeof error.message === 'string' ? error.message : '';
        if (/could not be kept|safe transfer|needs recovery/.test(message)) this.set('error',message);
        else this.set('retry','The connection was interrupted. Your original copy is safe. Retry the move; it will not create duplicate submissions.',{retriable:true});
        return false;
      } finally {
        if (timer !== null) clearTimeout(timer);
        this.busy = false;
        this.emit();
      }
    }
    backup() {
      return backupDocument(readLegacy(this.storage),this.now);
    }
  }

  function mount(document, options) {
    let storage;
    try { storage = options && options.storage || root.localStorage; }
    catch (_) { storage = {getItem(){throw new Error('Storage is blocked');},setItem(){throw new Error('Storage is blocked');}}; }
    const location = options && options.location || root.location;
    const byId = id=>document.getElementById(id);
    const bridge = new Bridge({storage,location,fetch:(options && options.fetch || root.fetch.bind(root)),
      onChange:(state,snapshot)=>{
        const status = byId('status');
        status.textContent = state.message;
        status.className = 'status' + (state.phase === 'success' ? ' success' : ['error','conflict'].includes(state.phase) ? ' error' : state.phase === 'retry' ? ' retry' : '');
        const move = byId('moveBtn');
        move.disabled = bridge.busy || !snapshot || !snapshot.hasData || snapshot.errors.length > 0 || state.phase === 'success';
        move.textContent = state.retriable ? 'Retry moving my saved submissions' : state.phase === 'success' ? 'Saved to the shared server' : 'Move my saved submissions and open new site';
        byId('counts').replaceChildren();
        if (snapshot) for (const kind of Object.keys(LEGACY_KEYS)) {
          const block = document.createElement('div');block.className='count';
          const number = document.createElement('b');number.textContent=String(snapshot.counts[kind]);
          const label = document.createElement('span');label.textContent=kind==='types'?'custom types':kind==='examples'?'example links':'saved videos';
          block.append(number,label);byId('counts').append(block);
        }
        byId('preview').replaceChildren();
        if (snapshot) for (const video of snapshot.videos.slice(0,8)) {
          const item = document.createElement('li');
          item.textContent = video && typeof video==='object' ? [video.name || '(name missing)',video.group || '(group missing)',video.link || '(link missing)'].map(String).join(' · ') : String(video);
          byId('preview').append(item);
        }
        if (state.conflicts) for (const conflict of state.conflicts) {
          const item = document.createElement('li');
          const existing = conflict.existing || {};
          item.textContent = 'Conflict: '+String(conflict.link || '')+' · Shared owner: '+String(existing.name || '')+' / '+String(existing.group || '');
          byId('preview').append(item);
        }
        byId('savedDetails').hidden = !snapshot || (!snapshot.hasData && !snapshot.errors.length);
        if (snapshot) byId('savedRecords').textContent=JSON.stringify(backupDocument(snapshot,bridge.now),null,2);
        if (state.phase==='success' || state.phase==='empty') {
          byId('openLink').textContent='Open new site';
          byId('openHint').textContent=state.phase==='success'?'Your saved copy has been confirmed by the server. Continue on the shared site.':'Continue on the shared site. If your earlier records are on another device, open the old link there.';
        }
      }});
    byId('moveBtn').addEventListener('click',()=>bridge.migrate());
    byId('backupBtn').addEventListener('click',()=>{
      const blob = new Blob([JSON.stringify(bridge.backup(),null,2)],{type:'application/json'});
      const url = root.URL.createObjectURL(blob);
      const anchor = document.createElement('a');anchor.href=url;anchor.download='listing-videos-browser-backup-'+new Date().toISOString().slice(0,10)+'.json';anchor.click();
      setTimeout(()=>root.URL.revokeObjectURL(url),1000);
    });
    bridge.init();
    return bridge;
  }
  const api = {CANONICAL_URL,API_URL,LEGACY_KEYS,REQUEST_KEY,RECEIPT_PREFIX,readLegacy,backupDocument,prepareOperation,validAcknowledgment,Bridge,mount};
  if (typeof module!=='undefined' && module.exports) module.exports=api;
  else {
    root.ListingMigration=api;
    if (root.document) {
      const start = ()=>mount(root.document);
      if (root.document.readyState==='loading') root.document.addEventListener('DOMContentLoaded',start,{once:true});else start();
    }
  }
})(typeof window!=='undefined'?window:globalThis);
