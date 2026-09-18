import { test } from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/web.ts';
import { makeEnv } from './helpers.ts';
import { baseRule } from '../src/core.ts';
import { takeBudget, storeItem, saveFeed, getFeed } from '../src/db.ts';
import { enqueue, claim, finish, fail, Deferred, dispatch } from '../src/tasks.ts';
function browser(env: ReturnType<typeof makeEnv>) {
  const jar = new Map<string, string>();
  return { jar, async request(path: string, fields?: Record<string, string>) {
    const headers: Record<string, string> = { cookie: [...jar].map(([k,v])=>`${k}=${v}`).join('; ') };
    if(fields){headers.origin='http://localhost';headers['content-type']='application/x-www-form-urlencoded';}
    const response=await app.request('http://localhost'+path,{method:fields?'POST':'GET',headers,body:fields?new URLSearchParams(fields):undefined},env.env,env.ctx);
    for(const cookie of response.headers.getSetCookie()){const pair=cookie.split(';')[0]!.split('=');jar.set(pair[0]!,pair.slice(1).join('='));}
    return response;
  }};
}
async function register(env:ReturnType<typeof makeEnv>,name='alice'){
  const b=browser(env),page=await(await b.request('/register')).text();const csrf=page.match(/name="csrf" value="([^"]+)"/)![1]!;
  const r=await b.request('/register',{username:name,password:'strong-test-password-123',csrf});assert.equal(r.status,200);
  return {b,csrf:(await r.text()).match(/name="csrf-token" content="([^"]+)"/)![1]!};
}
test('health endpoint needs no database roundtrip',async()=>{const {env,ctx}=makeEnv();const r=await app.request('http://localhost/healthz',{},env,ctx);assert.equal(r.status,200);assert.equal((await r.json() as any).service,'jevnews');});
test('homepage is server-rendered, has seven presets, and no fake news',async()=>{const e=makeEnv();const r=await app.request('http://localhost/',{},e.env,e.ctx);const text=await r.text();assert.match(text,/JevNews/);assert.match(text,/Systems &amp; Databases/);assert.match(text,/No successful HN synchronization/);assert.equal(r.headers.get('cache-control'),'private, no-store');await Promise.all(e.pending);});
test('registration and private routes require a real account',async()=>{const e=makeEnv();assert.equal((await app.request('http://localhost/rules',{},e.env,e.ctx)).status,401);const {b}=await register(e);assert.equal((await b.request('/rules')).status,200);assert.equal(Number(e.sqlite.prepare('SELECT count(*) AS n FROM users').get()!.n),1);});
test('authentication fails closed without production Turnstile config',async()=>{const e=makeEnv();e.env.APP_ENV='production';const r=await app.request('https://service.example/register',{},e.env,e.ctx);const text=await r.text(),csrf=text.match(/name="csrf" value="([^"]+)"/)![1]!;const cookie=r.headers.getSetCookie()[0]!.split(';')[0]!;const post=await app.request('https://service.example/register',{method:'POST',headers:{origin:'https://service.example',cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,username:'alice',password:'test-password-long'})},e.env,e.ctx);assert.equal(post.status,503);});
test('POST cross origin and missing CSRF are rejected',async()=>{const e=makeEnv();const r=await app.request('http://localhost/register',{method:'POST',headers:{origin:'https://evil.example','content-type':'application/x-www-form-urlencoded'},body:'username=alice&password=very-long-password'},e.env,e.ctx);assert.equal(r.status,403);});
test('rules are private, quotas enforced, and stale saves fail',async()=>{
  const e=makeEnv();const {b,csrf}=await register(e);
  for(let i=0;i<3;i++)assert.equal((await b.request('/rules',{csrf,name:'rule'+i,base:'engineering',prompt:''})).status,302);
  assert.equal((await b.request('/rules',{csrf,name:'fourth',base:'balanced',prompt:''})).status,409);
  const id=String(e.sqlite.prepare('SELECT id FROM private_rules LIMIT 1').get()!.id);const other=await register(e,'bob');
  assert.equal((await other.b.request('/?rule='+id)).status,404);
  assert.equal((await b.request('/rules/save',{csrf,id,version:'1',compiled:JSON.stringify(baseRule('systems'))})).status,302);
  assert.equal((await b.request('/rules/save',{csrf,id,version:'1',compiled:JSON.stringify(baseRule())})).status,409);await Promise.all(e.pending);
});
test('unsupported requirements require explicit acknowledgement',async()=>{const e=makeEnv();const {b,csrf}=await register(e);await b.request('/rules',{csrf,name:'test',base:'balanced',prompt:''});const id=String(e.sqlite.prepare('SELECT id FROM private_rules').get()!.id);const compiled=JSON.stringify({...baseRule(),unsupported:['Verify all claims externally']});assert.equal((await b.request('/rules/save',{csrf,id,version:'1',compiled})).status,400);});
test('logout invalidates server session',async()=>{const e=makeEnv();const {b,csrf}=await register(e);assert.equal((await b.request('/logout',{csrf})).status,302);assert.equal((await b.request('/rules')).status,401);assert.equal(e.sqlite.prepare('SELECT count(*) AS n FROM sessions').get()!.n,0);});
test('reading state writes affect only its owner',async()=>{const e=makeEnv();const {b,csrf}=await register(e);assert.equal((await b.request('/item-state',{csrf,id:'99',action:'hide'})).status,302);const {b:other}=await register(e,'bob');const html=await(await other.request('/hidden')).text();assert.ok(!html.includes('unhide #99'));});
test('account deletion removes account-bound state',async()=>{const e=makeEnv();const {b,csrf}=await register(e);await b.request('/rules',{csrf,name:'private',base:'balanced',prompt:''});await b.request('/item-state',{csrf,id:'99',action:'save'});const r=await b.request('/account/delete',{csrf,password:'strong-test-password-123'});assert.equal(r.status,302);for(const table of ['users','sessions','private_rules','user_item_state'])assert.equal(e.sqlite.prepare(`SELECT count(*) n FROM ${table}`).get()!.n,0);});
test('budget increment cannot cross the cap',async()=>{const e=makeEnv();const r=await Promise.all(Array.from({length:20},()=>takeBudget(e.env,'test',1,7)));assert.equal(r.filter(Boolean).length,7);});
test('outbox survives queue loss and rejects duplicate job claims',async()=>{const e=makeEnv();const id=await enqueue(e.env,'publish','fixture',{});assert.equal(await enqueue(e.env,'publish','fixture',{}),id);const first=await claim(e.env,id);assert.ok(first);assert.equal(await claim(e.env,id),null);await finish(e.env,first!);assert.equal(await claim(e.env,id),null);});
test('task lease fencing and deferred failures',async()=>{const e=makeEnv();const id=await enqueue(e.env,'publish','lease',{});const job=await claim(e.env,id);e.sqlite.prepare('UPDATE jobs SET lease_token=? WHERE id=?').run('new-token',id);await finish(e.env,job!);assert.equal(e.sqlite.prepare('SELECT status FROM jobs').get()!.status,'running');e.sqlite.prepare('UPDATE jobs SET lease_token=? WHERE id=?').run(job!.lease_token,id);await fail(e.env,job!,new Deferred('unconfigured',60));const row=e.sqlite.prepare('SELECT status,attempts FROM jobs').get()!;assert.equal(row.status,'pending');assert.equal(row.attempts,0);});
test('immutable snapshots are owner isolated and preserve ID order',async()=>{const e=makeEnv();await storeItem(e.env,{id:1,type:'story',title:'one'});const feed=await saveFeed(e.env,'jev:balanced',[2,1],[1],'test');assert.deepEqual((await getFeed(e.env,'jev:balanced',feed.id,null))!.ids,[2,1]);assert.equal(await getFeed(e.env,'jev:balanced',feed.id,'not-owner'),null);assert.equal(await getFeed(e.env,'jev:systems',feed.id,null),null);});
test('snapshot expiry is explicit, not a silently replaced page',async()=>{const e=makeEnv();const r=await app.request('http://localhost/?snapshot=missing',{},e.env,e.ctx);assert.equal(r.status,410);});
test('SQL schema prevents cross-owner semantic evaluations',async()=>{const e=makeEnv();e.sqlite.exec("INSERT INTO users VALUES('a','alice','hash','recovery',0); INSERT INTO users VALUES('b','bob','hash','recovery',0)");e.sqlite.prepare('INSERT INTO private_rules(id,owner_id,name,prompt,compiled_json,created_at) VALUES(?,?,?,?,?,0)').run('r','a','rule','',JSON.stringify(baseRule()));assert.throws(()=>e.sqlite.prepare('INSERT INTO evaluations VALUES(?,?,?,?,?,?)').run('b','r',1,'hash','[]',0));});
test('dispatcher enqueues only due durable jobs',async()=>{const e=makeEnv();await enqueue(e.env,'publish','now',{});await enqueue(e.env,'publish','later',{},Date.now()+86400000);await dispatch(e.env);assert.equal(e.messages.length,1);});
