(function(root){
  'use strict';
  const OLD_URL='https://summergjlong.github.io/cathoven-creator-steps/listing-videos-day/?recover=1';
  function safeURL(value,optional){
    const raw=String(value||'').trim();if(!raw&&optional)return '';
    if(/^[a-z][a-z0-9+.-]*:/i.test(raw)&&!/^https?:\/\//i.test(raw))return null;
    try{const url=new URL(/^https?:\/\//i.test(raw)?raw:'https://'+raw);if(!['https:','http:'].includes(url.protocol)||url.username||url.password||/[\s<>"'\u0000-\u001f]/.test(raw))return null;return url.href;}catch(error){return null;}
  }
  function videoDraftMatches(form,draft){return form.group===draft.group&&form.name.trim()===draft.name&&form.link.trim()===draft.link;}
  function typeDraftMatches(form,draft){return form.name.trim()===draft.name&&form.video.trim()===draft.video;}
  function readableError(error){
    const message=error&&error.message||String(error||'The submission could not be saved.');
    return message.replace(/_/g,' ');
  }
  const api={safeURL,videoDraftMatches,typeDraftMatches,readableError};
  if(typeof module!=='undefined'&&module.exports){module.exports=api;return;}
  const $=id=>document.getElementById(id);
  const groups=['Aira','Asher','Eya','Jackie','Kyla'];
  let storageLimited=false,storage;
  try{storage=root.localStorage;}catch(error){storageLimited=true;const map=new Map();storage={get length(){return map.size;},key:i=>Array.from(map.keys())[i]||null,getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k)};}
  let lastTypes='';
  function showMessage(id,message,bad){const el=$(id);el.textContent=message;el.style.display='block';el.style.color=bad?'#a52536':'#1a7a3a';}
  function getVideoDraft(){return {group:$('group').value,name:$('name').value.trim(),link:$('link').value.trim()};}
  function getTypeDraft(){return {name:$('newTypeName').value.trim(),video:$('newTypeVideo').value.trim()};}
  function downloadJSON(value,name){const a=document.createElement('a'),url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);}
  function refreshTypes(types){
    const signature=JSON.stringify(types);if(signature===lastTypes)return;lastTypes=signature;
    const reserved=new Set(['simple','logo','outcome','skill','compareNoLogo','__proto__','constructor','prototype']);
    types.forEach(item=>{
      const key=String(item.key||item.id||'');
      if(!/^[A-Za-z0-9_-]{1,160}$/.test(key)||reserved.has(key))return;
      const video=safeURL(item.video,true);if(video===null)return;
      root.EXAMPLES[key]={type:'list',title:String(item.name||''),hook:'Watch the original video.',layout:'Watch the original video.',video};
      let button=$('tab-'+key);
      if(!button){button=document.createElement('button');button.id='tab-'+key;button.dataset.sharedType='true';button.style.cssText='flex:1 0 auto;padding:9px 12px;border-radius:999px;border:2px solid #d9d5ea;background:#fff;color:#372179;font-size:13px;font-weight:800;white-space:nowrap';button.onclick=()=>root.showExample(key);$('exampleTabs').appendChild(button);}
      button.textContent=String(item.name||'');
    });
  }
  function renderState(status,queue){
    const bar=$('sharedStatusBar'),text=$('sharedStatusText'),detail=$('sharedStatusDetail'),actions=$('sharedStatusActions');
    bar.className='shared-status';detail.textContent='';actions.replaceChildren();
    if(!status.loaded){text.textContent=status.offline?'Shared list could not load. Please retry.':'Loading the shared list…';bar.classList.add('pending');}
    else if(status.blocked){text.textContent='Needs review — this submission is not saved';bar.classList.add('problem');detail.textContent=readableError(status.blocked)+(status.blocked.conflicts.length?'\n'+status.blocked.conflicts.map(item=>{const existing=item.existing||{};return (existing.name||'A creator')+' · '+(existing.group||'')+' already submitted '+(item.link||existing.link||'this link');}).join('\n'):'');}
    else if(status.offline){text.textContent=status.pending?'Offline — '+status.pending+' submission(s) waiting to save':'Offline — showing the last shared list';bar.classList.add('pending');}
    else if(status.sending||status.pending){text.textContent='Saving to the shared list…';bar.classList.add('pending');}
    else{text.textContent='Saved on the server · Team sync is on';}
    if((status.storageError||storageLimited)&&status.pending)detail.textContent+=(detail.textContent?'\n':'')+'Browser recovery storage is unavailable. Keep this page open until the server confirms the save.';
    function button(label,handler){const b=document.createElement('button');b.className='ghost compact';b.textContent=label;b.onclick=handler;actions.appendChild(b);}
    if(status.offline||!status.loaded)button('Retry connection',()=>client.poll());
    if(status.pending)button('Download pending submissions',()=>downloadJSON(client.exportPending(),'listing-pending-submissions.json'));
    if(status.blocked)button('Keep as a draft and edit',()=>{
      try{
        const operation=client.keepAsDraft(status.blocked.operationId);
        if(operation&&operation.path==='videos'){
          const draft=operation.payload.video;$('group').value=draft.group;$('name').value=draft.name;$('link').value=draft.link;showMessage('formMsg','Your submission is kept here as a draft. Fix it, then tap Add my video.',true);$('videoForm').scrollIntoView({block:'start'});
        }else if(operation&&operation.path==='types'){api.openType();$('newTypeName').value=operation.payload.type.name;$('newTypeVideo').value=operation.payload.type.video||'';showMessage('typeMsg','Your type is kept as a draft. Fix it, then save again.',true);}
        else showMessage('recoveryMsg','The import was kept in browser recovery. Review your JSON file and import again.',true);
      }catch(error){detail.textContent='A recovery copy could not be kept. Download pending submissions first. '+readableError(error);}
    });
    $('addVideoButton').disabled=!status.loaded||!!status.blocked;
    $('addTypeButton').disabled=!status.loaded||!!status.blocked;
    $('saveTypeButton').disabled=!status.loaded||!!status.blocked;
    $('importLocalButton').disabled=!status.loaded||!!status.blocked;
    $('backupInput').disabled=!status.loaded||!!status.blocked;
    $('downloadSharedButton').disabled=!status.loaded;
    let count=0;try{const old=ListingShared.legacyPayload(storage);count=old.videos.length+old.types.length+old.examples.length;}catch(error){showMessage('recoveryMsg',readableError(error),true);}
    $('localRecovery').hidden=!count;
    $('localRecoveryCount').textContent=count?String(count):'';
  }
  const client=new ListingShared.Client({fetch:root.fetch.bind(root),storage,onChange:data=>{
    root.videos=data.videos;root.sharedLoaded=true;root.renderList();refreshTypes(data.types);
  },onState:renderState,onResult:(operation,body)=>{
    if(operation.path==='videos'){
      const draft=operation.payload.video;
      if(videoDraftMatches(getVideoDraft(),draft))$('link').value='';
      showMessage('formMsg',body.duplicate?'This video was already saved. It is counted once.':'Saved to the shared list. Your coordinator can see it now.',false);
    }else if(operation.path==='types'){
      const draft=operation.payload.type;
      if(typeDraftMatches(getTypeDraft(),draft)){api.closeType();$('newTypeName').value='';$('newTypeVideo').value='';}
      if(body.type){refreshTypes(body.types);root.showExample(body.type.key||body.type.id);}
      showMessage('typeResult',body.duplicate?'This type is already in the shared tabs.':'New type saved for everyone.',false);
    }else{
      const imported=body.imported||{};
      showMessage('recoveryMsg','Import saved on the server. Added '+(imported.videos||0)+' video(s) and '+(imported.types||0)+' type(s). Repeated entries are counted once. Your original browser copy is kept.',false);
    }
  }});
  api.client=client;
  api.addVideo=()=>{
    const draft=getVideoDraft();
    if(!draft.name){showMessage('formMsg','Type your name first.',true);return;}
    if(!draft.link||!safeURL(draft.link,false)){showMessage('formMsg','Paste a valid http or https video link.',true);return;}
    const ex=root.EXAMPLES[root.currentExample]||{};
    const video=Object.assign({},draft,{date:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila'}).format(new Date()),typeKey:root.currentExample,typeName:ex.title||''});
    try{client.enqueue('videos',{video},{draft});showMessage('formMsg','Waiting for server confirmation. Keep this page open.',false);}catch(error){showMessage('formMsg',readableError(error),true);}
  };
  api.openType=()=>{$('typeModal').hidden=false;$('typeMsg').style.display='none';};
  api.closeType=()=>{$('typeModal').hidden=true;};
  api.saveType=()=>{
    const draft=getTypeDraft();
    if(!draft.name){showMessage('typeMsg','Type a name for this video type.',true);return;}
    if(draft.video&&!safeURL(draft.video,true)){showMessage('typeMsg','Paste a valid video link, or leave it blank.',true);return;}
    try{client.enqueue('types',{type:draft},{draft});showMessage('typeMsg','Waiting for server confirmation. Your type will appear for everyone after it is saved.',false);}catch(error){showMessage('typeMsg',readableError(error),true);}
  };
  api.importLocal=()=>{
    try{const payload=ListingShared.legacyPayload(storage);if(!payload.videos.length&&!payload.types.length&&!payload.examples.length)throw new Error('No previous browser submissions were found on this website. Use the original-site recovery link below.');client.enqueue('import',payload,{source:'previous-browser-copy'});showMessage('recoveryMsg','Import queued. Wait for the server confirmation. Your old copy is kept.',false);}catch(error){showMessage('recoveryMsg',readableError(error),true);}
  };
  api.importFile=async input=>{
    try{if(!input.files||!input.files[0])return;if(input.files[0].size>2*1024*1024)throw new Error('This file is too large. Import a smaller JSON backup.');const payload=ListingShared.importPayload(JSON.parse(await input.files[0].text()));client.enqueue('import',payload,{source:'JSON-backup'});showMessage('recoveryMsg','Import queued. Wait for the server confirmation.',false);}catch(error){showMessage('recoveryMsg',readableError(error),true);}finally{input.value='';}
  };
  api.downloadShared=()=>downloadJSON({format:'listing-videos-backup-v1',exportedAt:new Date().toISOString(),revision:client.data.revision,videos:client.data.videos,types:client.data.types,examples:[]},'listing-videos-shared-backup.json');
  api.downloadLocal=()=>{try{downloadJSON({format:'listing-videos-legacy-v1',exportedAt:new Date().toISOString(),...ListingShared.legacyPayload(storage)},'listing-videos-browser-recovery.json');}catch(error){showMessage('recoveryMsg',readableError(error),true);}};
  api.oldURL=OLD_URL;root.ListingUI=api;
  renderState(client.status(),client.queue);client.load();
  setInterval(()=>client.poll(),4000);root.addEventListener('online',()=>client.poll());root.addEventListener('focus',()=>client.poll());
  root.addEventListener('beforeunload',event=>{if(client.queue.length){event.preventDefault();event.returnValue='Some submissions are not saved to the server yet.';}});
})(typeof window!=='undefined'?window:globalThis);
