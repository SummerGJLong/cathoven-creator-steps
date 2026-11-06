(function (root) {
  'use strict';
  const copy = value => JSON.parse(JSON.stringify(value));
  const uuid = () => root.crypto && root.crypto.randomUUID ? root.crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r=Math.random()*16|0; return (c==='x'?r:(r&3)|8).toString(16); });
  class Client {
    constructor(options) {
      this.fetch=options.fetch; this.storage=options.storage; this.base=options.base||'./api/';
      this.onState=options.onState||(()=>{}); this.onChange=options.onChange||(()=>{}); this.onResult=options.onResult||(()=>{});
      this.prefix=options.prefix||'listingPendingOperationV1:'; this.persisted=new Set();
      this.data={revision:-1,videos:[],types:[],counts:{total:0,groups:{},people:{}}};
      this.queue=[]; this.loaded=false; this.sending=false; this.offline=false; this.blocked=null; this.storageError=false;
      try {
        for(let i=0;i<this.storage.length;i++) {
          const key=this.storage.key(i); if(!key||!key.startsWith(this.prefix))continue;
          const operation=JSON.parse(this.storage.getItem(key)||'null');
          if(operation&&operation.operationId&&['videos','types','import'].includes(operation.path)&&operation.payload) {
            this.queue.push(operation); this.persisted.add(operation.operationId);
          }
        }
        this.queue.sort((a,b)=>(a.createdAt||0)-(b.createdAt||0)||a.operationId.localeCompare(b.operationId));
      } catch(error) { this.storageError=true; }
    }
    status() { return {loaded:this.loaded,sending:this.sending,offline:this.offline,blocked:this.blocked,pending:this.queue.length,storageError:this.storageError,revision:this.data.revision}; }
    emit() { this.onState(this.status(),copy(this.queue)); }
    accept(body) {
      if(!body||!Number.isInteger(body.revision))throw new Error('The server returned an incomplete response. Your pending submission is kept.');
      if(body.unchanged)return;
      if(!Array.isArray(body.videos)||!Array.isArray(body.types))throw new Error('Shared records could not be read. Your pending submission is kept.');
      if(body.revision>=this.data.revision) {
        const changed=body.revision!==this.data.revision||!this.loaded;
        this.data=copy(body); if(changed)this.onChange(copy(this.data));
      }
    }
    async request(path,options) {
      const response=await this.fetch(this.base+path,Object.assign({credentials:'omit',cache:'no-store'},options||{}));
      if(response.status===429||response.status>=500)throw new Error('The server is temporarily unavailable. We will retry your saved pending submission.');
      let body;try{body=await response.json();}catch(error){throw new Error('The shared list could not be reached. Pending submissions are kept for retry.');}
      return {response,body};
    }
    async load() {
      try {
        const {response,body}=await this.request('state');
        if(!response.ok)throw new Error(body.message||body.error||'The shared list could not load.');
        this.accept(body); this.loaded=true; this.offline=false; this.emit();
        await this.drain();
      }catch(error){this.offline=true;this.error=error.message;this.emit();}
    }
    enqueue(path,payload,meta) {
      if(!this.loaded)throw new Error('Wait for the shared list to load before submitting.');
      if(!['videos','types','import'].includes(path))throw new Error('Invalid submission type.');
      const operation={operationId:uuid(),path,payload:copy(payload),meta:copy(meta||{}),createdAt:Date.now()};
      try{this.storage.setItem(this.prefix+operation.operationId,JSON.stringify(operation));this.persisted.add(operation.operationId);}catch(error){this.storageError=true;}
      this.queue.push(operation);this.emit();this.drain();return copy(operation);
    }
    acknowledge(operation) {
      try{this.storage.removeItem(this.prefix+operation.operationId);this.persisted.delete(operation.operationId);}catch(error){this.storageError=true;}
    }
    async drain() {
      if(!this.loaded||this.sending||this.blocked||!this.queue.length)return;
      this.sending=true;this.offline=false;this.emit();
      try {
        while(this.queue.length&&!this.blocked) {
          let operation=this.queue[0];
          let durable=null,storageReadable=true;
          try{durable=JSON.parse(this.storage.getItem(this.prefix+operation.operationId)||'null');}catch(error){this.storageError=true;storageReadable=false;}
          if(durable)operation=durable;
          else if(storageReadable&&this.persisted.has(operation.operationId)){this.persisted.delete(operation.operationId);this.queue.shift();continue;}
          const payload=Object.assign({operationId:operation.operationId},operation.payload);
          const {response,body}=await this.request(operation.path,{method:'POST',headers:{'Content-Type':'application/json','X-Listing-Request':'1'},body:JSON.stringify(payload)});
          if(!response.ok) {
            if(Number.isInteger(body.revision)&&Array.isArray(body.videos)&&Array.isArray(body.types))this.accept(body);
            this.blocked={operationId:operation.operationId,kind:response.status===409?'conflict':'invalid',message:body.message||body.error||'The server could not accept this submission.',conflicts:body.conflicts||[],status:response.status};
            this.emit();break;
          }
          this.accept(body);this.queue.shift();this.acknowledge(operation);this.onResult(copy(operation),copy(body));this.emit();
        }
      }catch(error){this.offline=true;this.error=error.message;}
      finally{this.sending=false;this.emit();}
    }
    async poll() {
      if(!this.loaded)return this.load();
      if(this.blocked)return;
      if(this.queue.length)return this.drain();
      if(this.sending)return;
      try {
        const {response,body}=await this.request('state?since='+encodeURIComponent(this.data.revision));
        if(!response.ok)throw new Error('The shared list could not refresh.');
        this.accept(body);this.offline=false;this.emit();
      }catch(error){this.offline=true;this.error=error.message;this.emit();}
    }
    keepAsDraft(operationId) {
      const operation=this.queue.find(item=>item.operationId===operationId);
      if(!operation)return null;
      // A review action keeps a recovery copy before removing this exact queued item.
      this.storage.setItem('listingRecoveryV1:'+uuid(),JSON.stringify({savedAt:new Date().toISOString(),operation}));
      this.acknowledge(operation);this.queue=this.queue.filter(item=>item.operationId!==operationId);
      if(this.blocked&&this.blocked.operationId===operationId)this.blocked=null;
      this.emit();this.drain();return copy(operation);
    }
    exportPending(){return {format:'listing-pending-v1',exportedAt:new Date().toISOString(),operations:copy(this.queue)};}
  }
  function legacyPayload(storage) {
    function array(key){const value=JSON.parse(storage.getItem(key)||'[]');if(!Array.isArray(value))throw new Error('The previous browser copy is not a valid list. Download a recovery copy before continuing.');return value;}
    return {videos:array('listingVideosV2'),types:array('listingCustomTypes'),examples:array('listingExamplesV1')};
  }
  function importPayload(value) {
    if(Array.isArray(value))value={videos:value,types:[],examples:[]};
    if(!value||typeof value!=='object')throw new Error('Choose a Listing Videos JSON backup.');
    if(value.format==='listing-pending-v1')throw new Error('This file contains pending operations. Use the original browser Retry button, or import its individual submissions after review.');
    const payload={videos:value.videos||[],types:value.types||[],examples:value.examples||[]};
    if(!Array.isArray(payload.videos)||!Array.isArray(payload.types)||!Array.isArray(payload.examples))throw new Error('The backup must contain video, type and example lists.');
    if(!payload.videos.length&&!payload.types.length&&!payload.examples.length)throw new Error('No saved submissions or types were found in this file.');
    // Server exports contain generated fields; only submit the accepted input fields.
    payload.videos=payload.videos.map(item=>{const row={};for(const field of ['group','name','link','date','typeKey','typeName'])if(item[field]!=null)row[field]=item[field];return row;});
    payload.types=payload.types.map(item=>({key:item.key||item.id,name:item.name,video:item.video||''}));
    payload.examples=payload.examples.map(item=>({link:item.link,date:item.date}));
    return payload;
  }
  const api={Client,legacyPayload,importPayload,copy};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.ListingShared=api;
})(typeof window!=='undefined'?window:globalThis);
