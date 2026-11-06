const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {Client,legacyPayload,importPayload}=require('../app/public/shared-client.js');
const {safeURL,videoDraftMatches}=require('../app/public/shared-ui.js');
class Storage{
  constructor(){this.map=new Map();}
  get length(){return this.map.size;}key(i){return Array.from(this.map.keys())[i]||null;}
  getItem(k){return this.map.get(k)||null;}setItem(k,v){this.map.set(k,String(v));}removeItem(k){this.map.delete(k);}
}
const video=(name='Test creator',link='https://www.tiktok.com/@test/video/123')=>({group:'Aira',name,link,date:'2026-11-06'});
const response=(body,status=200)=>({ok:status>=200&&status<300,status,json:async()=>JSON.parse(JSON.stringify(body))});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const settle=async client=>{for(let i=0;i<100&&client.sending;i++)await new Promise(r=>setImmediate(r));assert.equal(client.sending,false);};
function fakeServer(){
  let revision=0;const videos=[],types=[],operations=new Map(),requests=[];
  const state=()=>({revision,updatedAt:'now',videos:JSON.parse(JSON.stringify(videos)),types:JSON.parse(JSON.stringify(types)),counts:{total:videos.length,groups:{Aira:videos.filter(v=>v.group==='Aira').length},people:{}}});
  const fetch=async(url,options={})=>{
    requests.push({url,options});
    if(options.method!=='POST')return response(url.includes('?since='+revision)?{revision,updatedAt:'now',unchanged:true}:state());
    assert.equal(options.credentials,'omit');assert.equal(options.headers['X-Listing-Request'],'1');
    const payload=JSON.parse(options.body),digest=JSON.stringify(payload);
    if(operations.has(payload.operationId)){assert.equal(operations.get(payload.operationId),digest);return response({...state(),duplicate:true});}
    let duplicate=false,record;
    if(url.endsWith('/videos')){
      const old=videos.find(v=>v.link===payload.video.link);
      if(old&&(old.name!==payload.video.name||old.group!==payload.video.group))return response({...state(),error:'submission_conflict',conflicts:[{link:old.link,existing:old}]},409);
      duplicate=!!old;record=old||{id:'v'+(videos.length+1),...payload.video};if(!old){videos.push(record);revision++;}
    }else if(url.endsWith('/types')){
      const old=types.find(v=>v.name===payload.type.name&&v.video===payload.type.video);duplicate=!!old;record=old||{id:'t'+(types.length+1),key:'custom-'+(types.length+1),...payload.type};if(!old){types.push(record);revision++;}
    }else if(url.endsWith('/import')){
      for(const v of payload.videos||[])if(!videos.some(x=>x.link===v.link)){videos.push({id:'v'+(videos.length+1),...v});revision++;}
    }
    operations.set(payload.operationId,digest);
    return response({...state(),duplicate,added:!duplicate,video:record,type:record,imported:{videos:0,types:0,examples:0}});
  };
  return {fetch,state,requests,operations};
}
test('late queued submissions survive an earlier response and clear only after acknowledgement',async()=>{
  const server=fakeServer(),gate=deferred();let first=true;
  const client=new Client({storage:new Storage(),fetch:async(u,o)=>{if(o?.method==='POST'&&first){first=false;await gate.promise;}return server.fetch(u,o);}});
  await client.load();client.enqueue('videos',{video:video('First','https://example.com/1')});client.enqueue('videos',{video:video('Second','https://example.com/2')});
  assert.equal(client.status().pending,2);assert.equal(client.data.videos.length,0);gate.resolve();await settle(client);
  assert.equal(client.data.videos.length,2);assert.equal(client.queue.length,0);
});
test('503, 429 and 502 retain the same durable operation and retry exactly once',async()=>{
  for(const status of [503,429,502]){
    const server=fakeServer(),storage=new Storage();let fail=true;
    const client=new Client({storage,fetch:(u,o)=>o?.method==='POST'&&fail?Promise.resolve(response({error:'temporary'},status)):server.fetch(u,o)});
    await client.load();const operation=client.enqueue('videos',{video:video()});await settle(client);
    assert.equal(client.offline,true);assert.equal(client.blocked,null);assert.equal(client.queue[0].operationId,operation.operationId);assert.ok(storage.getItem(client.prefix+operation.operationId));
    fail=false;await client.poll();assert.equal(server.state().videos.length,1);assert.equal(server.operations.size,1);assert.equal(client.queue.length,0);
  }
});
test('a lost response recovers after reload without recounting the saved video',async()=>{
  const server=fakeServer(),storage=new Storage();let lose=true;
  const client=new Client({storage,fetch:async(u,o)=>{const result=await server.fetch(u,o);if(o?.method==='POST'&&lose){lose=false;throw new Error('response lost');}return result;}});
  await client.load();const operation=client.enqueue('videos',{video:video()});await settle(client);
  assert.equal(server.state().videos.length,1);assert.equal(client.queue.length,1);
  const recovered=new Client({storage,fetch:server.fetch});await recovered.load();
  assert.equal(server.state().videos.length,1);assert.equal(recovered.queue.length,0);assert.equal(server.operations.size,1);assert.equal(storage.getItem(client.prefix+operation.operationId),null);
});
test('two offline tabs retain independent operation keys and both recover safely',async()=>{
  const storage=new Storage(),server=fakeServer();let offline=false;
  const fetch=(u,o)=>offline&&o?.method==='POST'?Promise.reject(new Error('offline')):server.fetch(u,o);
  const a=new Client({storage,fetch}),b=new Client({storage,fetch});await a.load();await b.load();offline=true;
  a.enqueue('videos',{video:video('A','https://example.com/a')});b.enqueue('videos',{video:video('B','https://example.com/b')});await settle(a);await settle(b);
  assert.equal(storage.length,2);offline=false;
  const recoveredA=new Client({storage,fetch}),recoveredB=new Client({storage,fetch});await Promise.all([recoveredA.load(),recoveredB.load()]);
  assert.equal(server.state().videos.length,2);assert.equal(server.operations.size,2);assert.equal(storage.length,0);
});
test('conflicting credit preserves the submission and never reports a saved result',async()=>{
  const server=fakeServer(),storage=new Storage(),results=[];
  const first=new Client({storage:new Storage(),fetch:server.fetch});await first.load();first.enqueue('videos',{video:video('Original')});await settle(first);
  const client=new Client({storage,fetch:server.fetch,onResult:(...args)=>results.push(args)});await client.load();const payload={video:video('Different person')};
  client.enqueue('videos',payload);await settle(client);
  assert.equal(client.blocked.kind,'conflict');assert.deepEqual(client.queue[0].payload,payload);assert.equal(results.length,0);assert.equal(server.state().videos[0].name,'Original');
});
test('review keeps a recovery copy and removes only the selected rejected item',async()=>{
  const server=fakeServer(),storage=new Storage();let fail=true;
  const client=new Client({storage,fetch:(u,o)=>fail&&o?.method==='POST'?Promise.resolve(response({error:'invalid',message:'Fix the URL'},400)):server.fetch(u,o)});
  await client.load();const rejected=client.enqueue('videos',{video:video()});await settle(client);
  const otherKey=client.prefix+'other-tab-operation';storage.setItem(otherKey,JSON.stringify({operationId:'other-tab-operation',path:'videos',payload:{video:video('Other')}}));
  const draft=client.keepAsDraft(rejected.operationId);assert.equal(draft.payload.video.name,'Test creator');assert.ok(storage.getItem(otherKey));
  assert.ok(Array.from(storage.map.keys()).some(k=>k.startsWith('listingRecoveryV1:')));assert.equal(client.blocked,null);
});
test('stale polling results cannot replace a newer confirmed shared state',async()=>{
  const server=fakeServer(),gate=deferred();let hold=false;
  const client=new Client({storage:new Storage(),fetch:(u,o)=>hold&&u.includes('?since=')?gate.promise:server.fetch(u,o)});
  await client.load();hold=true;const poll=client.poll();client.enqueue('videos',{video:video()});await settle(client);
  gate.resolve(response({revision:0,videos:[],types:[],counts:{total:0}}));await poll;
  assert.equal(client.data.revision,1);assert.equal(client.data.videos.length,1);
});
test('unchanged polls do not rebuild the form or list and teammate state is global',async()=>{
  const server=fakeServer();let changes=0;
  const a=new Client({storage:new Storage(),fetch:server.fetch,onChange:()=>changes++}),b=new Client({storage:new Storage(),fetch:server.fetch});
  await a.load();await a.poll();assert.equal(changes,1);await b.load();b.enqueue('videos',{video:video()});await settle(b);await a.poll();
  assert.equal(a.data.counts.total,1);assert.equal(a.data.counts.groups.Aira,1);assert.equal(changes,2);
});
test('new custom types are confirmed by the server and appear in another client',async()=>{
  const server=fakeServer(),a=new Client({storage:new Storage(),fetch:server.fetch}),b=new Client({storage:new Storage(),fetch:server.fetch});await a.load();await b.load();
  a.enqueue('types',{type:{name:'New shared type',video:''}});await settle(a);await b.poll();assert.equal(b.data.types[0].name,'New shared type');
  a.enqueue('types',{type:{name:'New shared type',video:''}});await settle(a);assert.equal(server.state().types.length,1);
});
test('server writes remain available when browser recovery storage is blocked',async()=>{
  const storage={get length(){throw Error('blocked');},getItem(){throw Error('blocked');},setItem(){throw Error('blocked');},removeItem(){throw Error('blocked');}};
  const server=fakeServer(),client=new Client({storage,fetch:server.fetch});await client.load();client.enqueue('videos',{video:video()});await settle(client);
  assert.equal(client.storageError,true);assert.equal(client.queue.length,0);assert.equal(server.state().videos.length,1);
});
test('legacy recovery reads do not erase any original browser values',()=>{
  const storage=new Storage();storage.setItem('listingVideosV2',JSON.stringify([video()]));storage.setItem('listingCustomTypes','[{"key":"custom1","name":"Old type","video":""}]');storage.setItem('listingExamplesV1','[{"link":"https://example.com/example","date":"2026-11-04"}]');
  const before=Array.from(storage.map.entries());const payload=legacyPayload(storage);assert.equal(payload.videos.length,1);assert.equal(payload.types.length,1);assert.equal(payload.examples.length,1);assert.deepEqual(Array.from(storage.map.entries()),before);
});
test('JSON import strips generated metadata and repeated import keeps one shared link',async()=>{
  const server=fakeServer(),client=new Client({storage:new Storage(),fetch:server.fetch});await client.load();
  const payload=importPayload({format:'listing-videos-backup-v1',videos:[{id:'old',createdAt:'old',...video()}],types:[{id:'type-id',key:'custom-old',name:'Old',video:''}]});
  assert.equal(payload.videos[0].id,undefined);assert.equal(payload.videos[0].createdAt,undefined);
  client.enqueue('import',payload);await settle(client);client.enqueue('import',payload);await settle(client);assert.equal(server.state().videos.length,1);
  assert.throws(()=>importPayload({C:[]}),/No saved submissions/);
});
test('safe links and late typed input are protected',()=>{
  assert.equal(safeURL('javascript:alert(1)'),null);assert.equal(safeURL('ftp://example.com/file'),null);assert.equal(safeURL('https://u:p@example.com/file'),null);assert.equal(safeURL("https://example.com/a' onclick='bad"),null);
  assert.equal(safeURL('www.tiktok.com/@test/video/123'),'https://www.tiktok.com/@test/video/123');
  const submitted=video();assert.equal(videoDraftMatches({...submitted,link:'https://example.com/new'},submitted),false);assert.equal(videoDraftMatches(submitted,submitted),true);
  const html=fs.readFileSync(path.join(__dirname,'../app/public/index.html'),'utf8');const start=html.indexOf('  function esc('),end=html.indexOf('  function addVideo(',start);
  const scope={URL};vm.runInNewContext(html.slice(start,end),scope);
  assert.ok(!scope.linkHtml('javascript:alert(1)').includes('<a'));
  assert.ok(!scope.linkHtml('https://example.com/\" onmouseover=\"bad').includes('" onmouseover="'));
  assert.ok(scope.esc("O'Reilly <script>").includes('&#39;'));
});
