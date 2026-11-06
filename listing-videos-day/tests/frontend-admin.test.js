const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ListingShared=require('../app/public/shared-client.js');
const {authenticatedFetch,AdminController,typeDraft}=require('../app/public/admin/admin.js');
const {creatorImportPayload}=require('../app/public/shared-ui.js');
class Storage{
  constructor(){this.map=new Map();}get length(){return this.map.size;}key(i){return Array.from(this.map.keys())[i]||null;}
  getItem(key){return this.map.get(key)||null;}setItem(key,value){this.map.set(key,String(value));}removeItem(key){this.map.delete(key);}
}
const response=(body,status=200)=>({ok:status>=200&&status<300,status,json:async()=>JSON.parse(JSON.stringify(body))});
const state=()=>({revision:0,updatedAt:'now',videos:[],types:[],counts:{total:0,groups:{},people:{}}});
const settle=async client=>{for(let i=0;i<100&&client.sending;i++)await new Promise(resolve=>setImmediate(resolve));assert.equal(client.sending,false);};

test('administrator credentials are sent on session, state and write requests without a browser role header',async()=>{
  const calls=[],storage=new Storage();let current=state();
  const fetch=async(url,options={})=>{
    calls.push({url,options});assert.equal(options.credentials,'same-origin');
    assert.equal(options.headers&&options.headers['X-Listing-Admin'],undefined);
    assert.equal(options.headers&&options.headers['X-Listing-Key'],undefined);
    if(url.endsWith('/admin-session'))return response({authenticated:true,role:'admin'});
    if(options.method==='POST'){
      const body=JSON.parse(options.body);assert.equal(options.headers['X-Listing-Request'],'1');
      current={...current,revision:1,types:[{id:'t1',key:'custom-t1',...body.type}]};
      return response({...current,type:current.types[0],added:true,duplicate:false});
    }
    return response(current);
  };
  const controller=new AdminController({fetch,storage,Client:ListingShared.Client,importPayload:ListingShared.importPayload});
  assert.throws(()=>controller.submitType({name:'A'}),/administrator access/);
  await controller.start();assert.equal(controller.authorized,true);assert.equal(controller.client.loaded,true);
  controller.submitType({name:'  New shared type  ',video:'https://example.com/video'});await settle(controller.client);
  assert.deepEqual(controller.client.data.types[0],{id:'t1',key:'custom-t1',name:'New shared type',video:'https://example.com/video'});
  assert.deepEqual(calls.map(call=>call.url),['./api/admin-session','./api/state','./api/types']);
  assert.equal(controller.client.queue.length,0);
});

test('administrator fetch wrapper cannot inherit omit from the shared client',async()=>{
  const original={credentials:'omit',method:'POST',headers:{'Content-Type':'application/json'},body:'{}'};let actual;
  await authenticatedFetch(async(_url,options)=>{actual=options;return response({});})('./api/types',original);
  assert.equal(actual.credentials,'same-origin');assert.equal(original.credentials,'omit');assert.equal(actual.body,'{}');
});

test('failed or non-admin sessions cannot create a shared client or privileged outbox',async()=>{
  for(const [body,status] of [[{authenticated:false},403],[{authenticated:true,role:'creator'},200]]){
    let constructed=0;const calls=[],auth=[],storage=new Storage();
    const controller=new AdminController({storage,fetch:async(url)=>{calls.push(url);return response(body,status);},Client:class{constructor(){constructed++;}},onAuth:value=>auth.push(value),importPayload:ListingShared.importPayload});
    await controller.start();assert.equal(controller.authorized,false);assert.equal(constructed,0);assert.equal(storage.length,0);
    assert.deepEqual(calls,['./api/admin-session']);assert.equal(auth.at(-1).authorized,false);
    assert.throws(()=>controller.importBackup({videos:[]}),/administrator access/);
  }
});

test('administrator login never replays creator pending operations with administrator rights',async()=>{
  const storage=new Storage();storage.setItem('listingPendingOperationV1:creator-op',JSON.stringify({operationId:'creator-op',path:'types',payload:{type:{name:'Unapproved creator type'}}}));
  const before=Array.from(storage.map.entries()),calls=[];
  const controller=new AdminController({storage,Client:ListingShared.Client,importPayload:ListingShared.importPayload,fetch:async(url,options={})=>{calls.push({url,options});return response(url.endsWith('/admin-session')?{authenticated:true,role:'admin'}:state());}});
  await controller.start();assert.equal(controller.client.prefix,'viralAdminPendingV1:');assert.equal(controller.client.queue.length,0);
  assert.equal(calls.some(call=>call.options.method==='POST'),false);assert.deepEqual(Array.from(storage.map.entries()),before);
});

test('administrator recovery uses the existing input whitelist and durable admin operation',async()=>{
  const storage=new Storage();let posted;
  const controller=new AdminController({storage,Client:ListingShared.Client,importPayload:ListingShared.importPayload,fetch:async(url,options={})=>{
    if(url.endsWith('/admin-session'))return response({authenticated:true,role:'admin'});
    if(options.method==='POST'){posted=JSON.parse(options.body);return response({...state(),imported:{videos:1,types:1,examples:0},duplicates:{videos:0,types:0,examples:0}});}
    return response(state());
  }});
  await controller.start();const operation=controller.importBackup({videos:[{id:'generated',createdAt:'server-generated',group:'Aira',name:'Creator',link:'https://example.com/video',date:'2026-11-06'}],types:[{id:'type1',key:'custom-1',name:'Type',video:''}]});
  await settle(controller.client);assert.equal(posted.operationId,operation.operationId);assert.equal(posted.videos[0].id,undefined);assert.equal(posted.videos[0].createdAt,undefined);assert.equal(posted.types[0].name,'Type');assert.equal(controller.client.queue.length,0);
});

test('public recovery cannot enqueue a shared type change and never changes the saved copy',()=>{
  const payload={videos:[{group:'Aira',name:'Creator',link:'https://example.com/video'}],types:[{key:'old-type',name:'Saved type',video:''}],examples:[]};
  const before=JSON.stringify(payload);assert.throws(()=>creatorImportPayload(payload),/password-protected Admin page/);assert.equal(JSON.stringify(payload),before);
  const videosOnly={...payload,types:[]};assert.equal(creatorImportPayload(videosOnly),videosOnly);
});

class Element{
  constructor(){this.value='';this.disabled=true;this.hidden=false;this.textContent='';this.className='';this.style={};this.children=[];this.dataset={};this.classList={add:()=>{}};}
  replaceChildren(...children){this.children=children;}appendChild(child){this.children.push(child);}addEventListener(){}scrollIntoView(){}
}
function publicPage(blockedType){
  const ids=['sharedStatusBar','sharedStatusText','sharedStatusDetail','sharedStatusActions','addVideoButton','importLocalButton','backupInput','downloadSharedButton','localRecovery','localRecoveryCount','recoveryMsg','formMsg','group','name','link','videoForm'];
  const nodes=Object.fromEntries(ids.map(id=>[id,new Element()]));nodes.group.value='Aira';
  const storage=new Storage();let created;
  class FakeClient{
    constructor(options){this.options=options;this.loaded=true;this.queue=[];this.data=state();created=this;}
    status(){return {loaded:true,pending:blockedType?1:0,sending:false,offline:false,storageError:false,blocked:blockedType?{operationId:'prior-type',message:'Administrator required',conflicts:[]}:null};}
    load(){this.options.onChange(this.data);this.options.onState(this.status(),this.queue);}
    enqueue(kind,payload){this.lastEnqueued={kind,payload};}
    keepAsDraft(){return {path:'types',payload:{type:{name:'Earlier saved type'}}};}
  }
  const root={localStorage:storage,fetch:async()=>response(state()),ListingShared:{...ListingShared,Client:FakeClient},EXAMPLES:{simple:{title:'Website List'}},currentExample:'simple',renderList(){},showExample(){},addEventListener(){}};
  const context={window:root,ListingShared:root.ListingShared,document:{getElementById:id=>nodes[id],createElement:()=>new Element()},URL,Intl,Date,setInterval:()=>0,setTimeout:()=>0};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../app/public/shared-ui.js'),'utf8'),context);
  return {root,nodes,client:created};
}
test('public page still loads and submits videos when all type/editor DOM controls are absent',()=>{
  const page=publicPage(false);assert.equal(page.nodes.addVideoButton.disabled,false);assert.equal(page.root.ListingUI.saveType,undefined);assert.equal(page.root.ListingUI.openType,undefined);
  page.nodes.name.value='Creator';page.nodes.link.value='https://example.com/video';page.root.ListingUI.addVideo();assert.equal(page.client.lastEnqueued.kind,'videos');assert.equal(page.client.lastEnqueued.payload.video.name,'Creator');
  const html=fs.readFileSync(path.join(__dirname,'../app/public/index.html'),'utf8');
  assert.equal(/toggleEdit|downloadPage|contentEditable|id="(?:editBtn|addTypeButton|typeModal)"/.test(html),false);
  assert.ok(html.includes('href="./admin/"'));
});

test('a recovered public type operation keeps its draft without touching removed modal fields',()=>{
  const page=publicPage(true);const review=page.nodes.sharedStatusActions.children.find(button=>button.textContent==='Keep as a draft and edit');assert.ok(review);review.onclick();
  assert.match(page.nodes.recoveryMsg.textContent,/administrator|Admin/);assert.equal(page.nodes.addTypeButton,undefined);assert.equal(page.nodes.newTypeName,undefined);
});

test('administrator type drafts reject unsafe links without storing authentication details',()=>{
  assert.throws(()=>typeDraft({name:'Type',video:'javascript:alert(1)'}),/valid http/);assert.throws(()=>typeDraft({name:'Type',video:'https://user:password@example.com/video'}),/valid http/);
  assert.deepEqual(typeDraft({name:' Type ',video:'www.tiktok.com/@creator/video/1',password:'never-send',admin:true}),{name:'Type',video:'www.tiktok.com/@creator/video/1'});
});
