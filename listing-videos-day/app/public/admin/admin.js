(function(root){
  'use strict';
  function authenticatedFetch(fetch){return (url,options)=>fetch(url,Object.assign({},options||{},{credentials:'same-origin'}));}
  function typeDraft(value){
    const name=String(value.name||'').trim(),video=String(value.video||'').trim();
    if(!name||name.length>200)throw new Error('Enter a type name with 1–200 characters.');
    if(video){
      if(/[\s<>"'\u0000-\u001f]/.test(video)||(/^[a-z][a-z0-9+.-]*:/i.test(video)&&!/^https?:\/\//i.test(video)))throw new Error('Paste a valid http or https example link, or leave it blank.');
      let url;try{url=new URL(/^https?:\/\//i.test(video)?video:'https://'+video);}catch(_){throw new Error('Paste a valid http or https example link, or leave it blank.');}
      if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('Paste a valid http or https example link, or leave it blank.');
    }
    return {name,video};
  }
  class AdminController{
    constructor(options){
      this.fetch=authenticatedFetch(options.fetch);this.storage=options.storage;this.Client=options.Client;
      this.importPayload=options.importPayload;this.onAuth=options.onAuth||(()=>{});
      this.onState=options.onState||(()=>{});this.onChange=options.onChange||(()=>{});this.onResult=options.onResult||(()=>{});
      this.authorized=false;this.client=null;this.starting=false;
    }
    async start(){
      if(this.starting)return;
      if(this.client)return this.client.poll();
      this.starting=true;
      try{
        const response=await this.fetch('./api/admin-session',{cache:'no-store'});
        let body;try{body=await response.json();}catch(_){throw new Error('Administrator access could not be verified. Reload this page and sign in again.');}
        if(!response.ok||body.authenticated!==true||body.role!=='admin')throw new Error('Administrator access is required. Reload this page and sign in with the administrator account.');
        this.authorized=true;this.onAuth({authorized:true});
        this.client=new this.Client({fetch:this.fetch,storage:this.storage,base:'./api/',prefix:'viralAdminPendingV1:',onState:this.onState,onChange:this.onChange,onResult:this.onResult});
        await this.client.load();
      }catch(error){
        if(!this.client)this.authorized=false;
        this.onAuth({authorized:this.authorized,error:error.message||'The administrator page could not connect.'});
      }finally{this.starting=false;}
    }
    requireAccess(){if(!this.authorized||!this.client||!this.client.loaded)throw new Error('Wait until administrator access and the shared list are ready.');if(this.client.blocked)throw new Error('Resolve the pending submission before adding another change.');}
    submitType(value){this.requireAccess();const draft=typeDraft(value);return this.client.enqueue('types',{type:draft},{draft});}
    importBackup(value){this.requireAccess();return this.client.enqueue('import',this.importPayload(value),{source:'admin-JSON-backup'});}
    retry(){return this.client?this.client.poll():this.start();}
  }
  const api={authenticatedFetch,typeDraft,AdminController};
  if(typeof module!=='undefined'&&module.exports){module.exports=api;return;}
  const $=id=>document.getElementById(id);
  const controllerOptions={fetch:root.fetch.bind(root),Client:root.ListingShared.Client,importPayload:root.ListingShared.importPayload};
  let limitedStorage=false;
  try{controllerOptions.storage=root.localStorage;}catch(_){limitedStorage=true;const map=new Map();controllerOptions.storage={get length(){return map.size;},key:i=>Array.from(map.keys())[i]||null,getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k)};}
  function show(id,message,bad){const el=$(id);el.textContent=message;el.style.color=bad?'#a52536':'#205d37';}
  function download(value,filename){const a=document.createElement('a'),url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);}
  function lockControls(locked){for(const id of ['adminTypeName','adminTypeVideo','adminSaveType','adminBackupInput'])$(id).disabled=locked;}
  function action(label,callback){const button=document.createElement('button');button.className='ghost';button.textContent=label;button.addEventListener('click',callback);$('adminActions').appendChild(button);}
  function render(status){
    const bar=$('adminStatus'),text=$('adminStatusText'),details=$('adminStatusDetails');bar.className='status';details.textContent='';$('adminActions').replaceChildren();
    if(!controller.authorized){text.textContent='Administrator access is required';bar.classList.add('problem');}
    else if(!status.loaded){text.textContent=status.offline?'The shared list could not load':'Loading shared data…';}
    else if(status.blocked){text.textContent='Needs review — this change is not saved';bar.classList.add('problem');details.textContent=status.blocked.message||'Review this saved copy before retrying.';
      for(const conflict of status.blocked.conflicts||[]){const existing=conflict.existing||{};details.textContent+='\n'+String(conflict.link||'')+' · '+String(existing.name||'')+' / '+String(existing.group||'');}
    }else if(status.offline){text.textContent=status.pending?'Offline — changes are waiting to save':'Offline — showing the last shared data';}
    else if(status.sending||status.pending){text.textContent='Saving to the shared server…';}
    else{text.textContent='Admin signed in · Saved to the shared server';bar.classList.add('good');}
    if(status.pending&&(status.storageError||limitedStorage))details.textContent+='\nBrowser recovery storage is unavailable. Keep this page open until the server confirms the save.';
    if(status.offline||!status.loaded)action('Retry connection',()=>controller.retry());
    if(status.pending)action('Download pending changes',()=>download(controller.client.exportPending(),'viral-video-pool-admin-pending.json'));
    if(status.blocked)action('Keep as a draft and review',()=>{
      try{const operation=controller.client.keepAsDraft(status.blocked.operationId);if(operation&&operation.path==='types'){$('adminTypeName').value=operation.payload.type.name;$('adminTypeVideo').value=operation.payload.type.video||'';show('adminTypeMessage','The change is kept as a draft. Review the details and save again.',true);}else show('adminImportMessage','A browser recovery copy was kept. Review the original JSON file before importing again.',true);}
      catch(error){details.textContent='Download pending changes before closing this page. '+error.message;}
    });
    lockControls(!controller.authorized||!status.loaded||!!status.blocked);
  }
  controllerOptions.onAuth=state=>{
    if(!state.authorized){lockControls(true);$('adminStatus').className='status problem';$('adminStatusText').textContent='Administrator access could not be verified';$('adminStatusDetails').textContent=state.error||'';$('adminActions').replaceChildren();action('Retry connection',()=>controller.retry());}
  };
  controllerOptions.onState=render;
  controllerOptions.onChange=state=>{
    $('adminCounts').textContent=state.videos.length+' saved video link(s) · '+state.types.length+' shared custom type(s)';
    $('adminTypeList').replaceChildren();
    if(!state.types.length){const item=document.createElement('li');item.textContent='No custom types yet. The creator page still includes the original examples.';$('adminTypeList').appendChild(item);}
    for(const type of state.types){const item=document.createElement('li'),title=document.createElement('strong');title.textContent=String(type.name||'');item.appendChild(title);if(type.video){try{const draft=typeDraft(type);const link=document.createElement('a');link.href=/^https?:\/\//i.test(draft.video)?draft.video:'https://'+draft.video;link.target='_blank';link.rel='noopener noreferrer';link.textContent=draft.video;item.appendChild(link);}catch(_){}}$('adminTypeList').appendChild(item);}
  };
  controllerOptions.onResult=(operation,body)=>{
    if(operation.path==='types'){
      const draft=operation.payload.type;
      if($('adminTypeName').value.trim()===draft.name&&$('adminTypeVideo').value.trim()===draft.video){$('adminTypeName').value='';$('adminTypeVideo').value='';}
      show('adminTypeMessage',body.duplicate?'This type was already saved and is counted once.':'Shared type saved. Creators can use it now.',false);
    }else{const added=body.imported||{};show('adminImportMessage','Recovery saved: '+(added.videos||0)+' video link(s), '+(added.types||0)+' type(s) and '+(added.examples||0)+' example(s) added. Repeated entries are counted once.',false);}
  };
  const controller=new AdminController(controllerOptions);api.controller=controller;root.ViralAdmin=api;
  $('typeForm').addEventListener('submit',event=>{event.preventDefault();try{controller.submitType({name:$('adminTypeName').value,video:$('adminTypeVideo').value});show('adminTypeMessage','Waiting for server confirmation…',false);}catch(error){show('adminTypeMessage',error.message,true);}});
  $('adminBackupInput').addEventListener('change',async event=>{
    const input=event.target;
    try{if(!input.files||!input.files[0])return;if(input.files[0].size>2*1024*1024)throw new Error('This file is too large. Choose a smaller JSON recovery file.');controller.importBackup(JSON.parse(await input.files[0].text()));show('adminImportMessage','Recovery queued. Wait for the green server confirmation.',false);}catch(error){show('adminImportMessage',error.message,true);}finally{input.value='';}
  });
  controller.start();setInterval(()=>{if(controller.client)controller.client.poll();},4000);
  root.addEventListener('online',()=>controller.retry());root.addEventListener('focus',()=>{if(controller.authorized)controller.retry();});
  root.addEventListener('beforeunload',event=>{if(controller.client&&controller.client.queue.length){event.preventDefault();event.returnValue='Administrator changes are not saved to the server yet.';}});
})(typeof window!=='undefined'?window:globalThis);
