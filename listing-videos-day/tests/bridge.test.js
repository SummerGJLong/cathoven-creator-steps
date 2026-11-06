const test=require('node:test');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {
  CANONICAL_URL,API_URL,LEGACY_KEYS,REQUEST_KEY,RECEIPT_PREFIX,
  readLegacy,backupDocument,prepareOperation,Bridge
}=require('../legacy/bridge.js');

class Storage {
  constructor(entries){this.values=new Map(Object.entries(entries||{}));this.reads=[];this.writes=[];}
  getItem(key){this.reads.push(key);return this.values.has(key)?this.values.get(key):null;}
  setItem(key,value){this.writes.push(key);this.values.set(key,String(value));}
}
const video={group:'Aira',name:'Test creator',link:'https://www.tiktok.com/@test/video/123',date:'2026-11-05'};
const custom={key:'custom123',name:'Test type',video:'https://www.instagram.com/reel/test/'};
const example={link:'https://www.youtube.com/watch?v=test',date:'2026-11-05'};
const initial=()=>({listingVideosV2:JSON.stringify([video]),listingCustomTypes:JSON.stringify([custom]),listingExamplesV1:JSON.stringify([example])});
const originals=storage=>Object.fromEntries(Object.values(LEGACY_KEYS).map(key=>[key,storage.values.has(key)?storage.values.get(key):null]));
const digest=async text=>createHash('sha256').update(text).digest('hex');
let sequence=0;
const uuid=()=>`00000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`;
const response=(status,body)=>({status,ok:status>=200&&status<300,json:async()=>body});
const ack=(body,revision=2)=>({revision,imported:{videos:body.videos.length,types:body.types.length,examples:body.examples.length},duplicates:{videos:0,types:0,examples:0}});
function fixture(options={}){
  const storage=options.storage||new Storage(initial());
  const location={href:'https://summergjlong.github.io/cathoven-creator-steps/listing-videos-day/'+(options.query||''),replacements:[],replace(url){this.replacements.push(url);}};
  const calls=[];
  const fetch=options.fetch||(async(url,init)=>{calls.push({url,init});return response(200,ack(JSON.parse(init.body)));});
  const bridge=new Bridge({storage,location,fetch,digest,uuid,AbortController,now:()=> '2026-11-06T00:00:00Z'});
  bridge.init();
  return {storage,location,calls,bridge};
}

test('reads only the three original legacy keys and reports their counts',()=>{
  const storage=new Storage({...initial(),unrelatedSecret:'do not read'});
  const snapshot=readLegacy(storage);
  assert.deepEqual(storage.reads,Object.values(LEGACY_KEYS));
  assert.deepEqual(snapshot.counts,{videos:1,types:1,examples:1});
  assert.equal(snapshot.hasData,true);
  assert.deepEqual(snapshot.errors,[]);
});

test('reading saved records does not send or alter them before an explicit move',()=>{
  const {storage,bridge,location,calls}=fixture();
  assert.equal(bridge.state.phase,'ready');
  assert.equal(calls.length,0);
  assert.deepEqual(storage.writes,[]);
  assert.deepEqual(location.replacements,[]);
});

test('empty old pages redirect only to the fixed HTTPS site',()=>{
  const {location,bridge,calls}=fixture({storage:new Storage(),query:'?next=https://untrusted.example/&name=private'});
  assert.equal(bridge.state.phase,'empty');
  assert.deepEqual(location.replacements,[CANONICAL_URL]);
  assert.equal(new URL(location.replacements[0]).protocol,'https:');
  assert.equal(new URL(location.replacements[0]).search,'');
  assert.equal(calls.length,0);
});

test('recover=1 keeps an empty recovery page open',()=>{
  const {location,bridge}=fixture({storage:new Storage(),query:'?recover=1'});
  assert.equal(bridge.state.phase,'empty');
  assert.deepEqual(location.replacements,[]);
});

test('broken JSON is retained verbatim in the recovery download and blocks migration',async()=>{
  const storage=new Storage({...initial(),listingVideosV2:'[{broken original data'});
  const before=originals(storage);
  const {bridge,calls,location}=fixture({storage});
  assert.equal(bridge.state.phase,'error');
  assert.equal(await bridge.migrate(),false);
  const download=bridge.backup();
  assert.equal(download.raw.listingVideosV2,'[{broken original data');
  assert.ok(download.errors.length);
  assert.deepEqual(download.types,[custom]);
  assert.deepEqual(originals(storage),before);
  assert.equal(calls.length,0);
  assert.deepEqual(location.replacements,[]);
});

test('non-list saved data is a recovery error, not an empty successful copy',()=>{
  const snapshot=readLegacy(new Storage({listingVideosV2:'{"video":"kept"}'}));
  assert.ok(snapshot.errors.length);
  const backup=backupDocument(snapshot,()=> 'test');
  assert.equal(backup.raw.listingVideosV2,'{"video":"kept"}');
});

test('blocked browser storage never causes an empty auto-redirect',()=>{
  const storage={getItem(){throw new Error('blocked');},setItem(){throw new Error('blocked');}};
  const {bridge,location}=fixture({storage});
  assert.equal(bridge.state.phase,'error');
  assert.deepEqual(location.replacements,[]);
});

test('a lost response retries after reload with the exact durable operation ID',async()=>{
  const storage=new Storage(initial()),before=originals(storage),sent=[];
  const first=fixture({storage,fetch:async(url,init)=>{sent.push(JSON.parse(init.body));throw new Error('response lost');}});
  assert.equal(await first.bridge.migrate(),false);
  assert.equal(first.bridge.state.phase,'retry');
  const second=fixture({storage,fetch:async(url,init)=>{const body=JSON.parse(init.body);sent.push(body);return response(200,ack(body));}});
  assert.equal(await second.bridge.migrate(),true);
  assert.equal(sent[0].operationId,sent[1].operationId);
  assert.deepEqual(sent[0],sent[1]);
  assert.deepEqual(originals(storage),before);
  assert.deepEqual(first.location.replacements,[]);
  assert.deepEqual(second.location.replacements,[]);
});

test('changed source records get a new transfer ID and the latest data is read at click time',async()=>{
  const storage=new Storage(initial());
  const snapshot=readLegacy(storage);
  const first=await prepareOperation(storage,snapshot,{digest,uuid});
  const secondVideo={...video,link:'https://www.tiktok.com/@test/video/456'};
  storage.values.set('listingVideosV2',JSON.stringify([video,secondVideo]));
  const {bridge,calls}=fixture({storage});
  assert.equal(await bridge.migrate(),true);
  const sent=JSON.parse(calls[0].init.body);
  assert.notEqual(sent.operationId,first.body.operationId);
  assert.equal(sent.videos.length,2);
});

test('429 and 5xx leave the original copy and retry with the same transfer ID',async()=>{
  for(const status of [429,500,502,503]){
    const storage=new Storage(initial()),before=originals(storage),sent=[];
    let attempt=0;
    const {bridge}=fixture({storage,fetch:async(url,init)=>{
      const body=JSON.parse(init.body);sent.push(body);
      return ++attempt===1?response(status,{error:'temporary'}):response(200,ack(body));
    }});
    assert.equal(await bridge.migrate(),false);
    assert.equal(bridge.state.phase,'retry');
    assert.equal(bridge.state.retriable,true);
    assert.equal(await bridge.migrate(),true);
    assert.equal(sent[0].operationId,sent[1].operationId);
    assert.deepEqual(originals(storage),before);
  }
});

test('credit conflicts preserve all original rows and never redirect as success',async()=>{
  const storage=new Storage(initial()),before=originals(storage);
  const conflict={index:0,link:video.link,existing:{name:'Another creator',group:'Kyla'}};
  const {bridge,location}=fixture({storage,fetch:async()=>response(409,{error:'submission_conflict',conflicts:[conflict]})});
  assert.equal(await bridge.migrate(),false);
  assert.equal(bridge.state.phase,'conflict');
  assert.deepEqual(bridge.state.conflicts,[conflict]);
  assert.deepEqual(originals(storage),before);
  assert.deepEqual(location.replacements,[]);
  assert.equal([...storage.values.keys()].some(key=>key.startsWith(RECEIPT_PREFIX)),false);
});

test('validation errors give a review message and keep the source intact',async()=>{
  const storage=new Storage(initial()),before=originals(storage);
  const {bridge}=fixture({storage,fetch:async()=>response(400,{error:'invalid_request',message:'videos[0].link is invalid'})});
  assert.equal(await bridge.migrate(),false);
  assert.equal(bridge.state.phase,'error');
  assert.match(bridge.state.message,/videos\[0\]\.link/);
  assert.deepEqual(originals(storage),before);
});

test('a 200 response without a complete committed count is not called moved',async()=>{
  const storage=new Storage(initial()),before=originals(storage);
  const {bridge}=fixture({storage,fetch:async()=>response(200,{revision:2,imported:{videos:0,types:0,examples:0},duplicates:{videos:0,types:0,examples:0}})});
  assert.equal(await bridge.migrate(),false);
  assert.equal(bridge.state.phase,'retry');
  assert.deepEqual(originals(storage),before);
});

test('successful imports keep a separate receipt and never rewrite the originals',async()=>{
  const storage=new Storage(initial()),before=originals(storage);
  const {bridge,calls}=fixture({storage});
  assert.equal(await bridge.migrate(),true);
  assert.equal(bridge.state.phase,'success');
  assert.equal(calls[0].url,API_URL);
  assert.equal(calls[0].init.mode,'cors');
  assert.equal(calls[0].init.credentials,'omit');
  assert.equal(calls[0].init.headers['X-Listing-Request'],'1');
  assert.equal(calls[0].init.headers['Content-Type'],'application/json');
  assert.deepEqual(originals(storage),before);
  assert.ok([...storage.values.keys()].some(key=>key.startsWith(RECEIPT_PREFIX)));
  assert.equal(storage.writes.some(key=>Object.values(LEGACY_KEYS).includes(key)),false);
});

test('duplicate records are accepted only when counts cover the whole original copy',async()=>{
  const {bridge}=fixture({fetch:async()=>response(200,{revision:8,imported:{videos:0,types:0,examples:0},duplicates:{videos:1,types:1,examples:1}})});
  assert.equal(await bridge.migrate(),true);
  assert.equal(bridge.state.receipt.revision,8);
});

test('double-clicks share one in-flight transfer instead of issuing parallel imports',async()=>{
  let resolveResponse,calls=0;
  const {bridge}=fixture({fetch:async(url,init)=>{
    calls++;return new Promise(resolve=>{resolveResponse=()=>resolve(response(200,ack(JSON.parse(init.body))));});
  }});
  const first=bridge.migrate();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(bridge.busy,true);
  assert.equal(await bridge.migrate(),false);
  assert.equal(calls,1);
  resolveResponse();
  assert.equal(await first,true);
});

test('new records from another old tab during transfer remain visible for the next move',async()=>{
  let resolveResponse;
  const storage=new Storage(initial());
  const {bridge}=fixture({storage,fetch:async(url,init)=>new Promise(resolve=>{
    const body=JSON.parse(init.body);
    resolveResponse=()=>resolve(response(200,ack(body)));
  })});
  const moving=bridge.migrate();
  await new Promise(resolve=>setImmediate(resolve));
  const extra={...video,link:'https://www.tiktok.com/@test/video/789'};
  storage.values.set('listingVideosV2',JSON.stringify([video,extra]));
  resolveResponse();
  assert.equal(await moving,true);
  assert.equal(bridge.state.phase,'ready');
  assert.match(bridge.state.message,/More browser changes/);
  assert.equal(bridge.snapshot.counts.videos,2);
  assert.equal(JSON.parse(storage.values.get('listingVideosV2')).length,2);
});

test('a backup download during transfer does not change the batch being acknowledged',async()=>{
  let resolveResponse;
  const storage=new Storage(initial());
  const {bridge}=fixture({storage,fetch:async(url,init)=>new Promise(resolve=>{
    const body=JSON.parse(init.body);
    resolveResponse=()=>resolve(response(200,ack(body)));
  })});
  const moving=bridge.migrate();
  await new Promise(resolve=>setImmediate(resolve));
  const submittedSnapshot=bridge.snapshot;
  bridge.backup();
  assert.equal(bridge.snapshot,submittedSnapshot);
  resolveResponse();
  assert.equal(await moving,true);
  assert.equal(bridge.state.phase,'success');
});

test('a durable transfer ID is required before any request is sent',async()=>{
  const storage=new Storage(initial());
  storage.setItem=()=>{throw new Error('quota');};
  const {bridge,calls}=fixture({storage});
  assert.equal(await bridge.migrate(),false);
  assert.equal(bridge.state.phase,'error');
  assert.match(bridge.state.message,/transfer ID/);
  assert.equal(calls.length,0);
});

test('destination is fixed HTTPS and source data never enters a query string',async()=>{
  const malicious={...video,name:'Private Name',link:'https://elsewhere.example/?secret=private'};
  const storage=new Storage({...initial(),listingVideosV2:JSON.stringify([malicious])});
  const {bridge,calls}=fixture({storage,query:'?recover=1&next=https://untrusted.example/'});
  assert.equal(await bridge.migrate(),true);
  assert.equal(calls[0].url,'https://srv2054680.hstgr.cloud/listing-videos-day/api/import');
  assert.equal(new URL(calls[0].url).search,'');
  assert.equal(calls[0].url.includes('Private'),false);
});

test('bridge UI avoids native dialogs, clipboard writes and user-derived HTML injection',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../legacy/bridge.js'),'utf8');
  const html=fs.readFileSync(path.join(__dirname,'../legacy/index.html'),'utf8');
  assert.doesNotMatch(source,/\b(?:alert|confirm|prompt)\s*\(/);
  assert.doesNotMatch(source,/innerHTML|clipboard|execCommand/);
  assert.match(html,/src="\.\/bridge\.js"/);
  assert.match(html,/https:\/\/srv2054680\.hstgr\.cloud\/listing-videos-day\//);
  assert.equal(html.includes(video.name),false);
});
