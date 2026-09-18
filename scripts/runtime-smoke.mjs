/** Real local workerd + D1/R2/Queues/DO smoke test. No production credentials. */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const state=mkdtempSync(join(tmpdir(),'jevnews-smoke-'));
const cli='node_modules/wrangler/bin/wrangler.js',config='wrangler.local.jsonc',port=8799;
const origin=`http://127.0.0.1:${port}`,env={...process.env,WRANGLER_SEND_METRICS:'false'};
const migration=spawnSync(process.execPath,[cli,'d1','migrations','apply','jevnews','--local','--config',config,'--persist-to',state],{env,encoding:'utf8',timeout:45000});
if(migration.status!==0)throw new Error(migration.stderr||migration.stdout);
const worker=spawn(process.execPath,[cli,'dev','--config',config,'--ip','127.0.0.1','--port',String(port),'--persist-to',state],{env,detached:true,stdio:['ignore','pipe','pipe']});
let logs='';worker.stdout.on('data',d=>{logs+=d;});worker.stderr.on('data',d=>{logs+=d;});
const cookies=new Map();
async function request(path,fields,authorized=true){
  const response=await fetch(origin+path,{method:fields?'POST':'GET',redirect:'manual',signal:AbortSignal.timeout(5000),headers:{...(authorized?{Cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; ')}:{}),...(fields?{Origin:origin,'Content-Type':'application/x-www-form-urlencoded'}:{})},body:fields?new URLSearchParams(fields):undefined});
  if(authorized)for(const line of response.headers.getSetCookie()){const pair=line.split(';')[0],i=pair.indexOf('=');cookies.set(pair.slice(0,i),pair.slice(i+1));}
  return {response,text:await response.text()};
}
function csrf(text){const result=/name="csrf" value="([^"]+)"/.exec(text);assert.ok(result,'CSRF form token');return result[1];}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try{
  let ready=false;
  for(let n=0;n<60;n++){try{if((await request('/healthz')).response.status===200){ready=true;break;}}catch{}await sleep(500);}
  assert.ok(ready,'workerd startup');
  const home=await request('/');assert.equal(home.response.status,200);assert.match(home.text,/JevNews/);
  const css=await request('/style.css');assert.equal(css.response.status,200);assert.match(css.text,/Verdana/);
  const registration=await request('/register');
  const account=await request('/register',{csrf:csrf(registration.text),username:'smoke_reader',password:'A-strong-test-only-password-762'});
  assert.equal(account.response.status,200);assert.match(account.text,/recovery/i);assert.ok(cookies.get('jev_session'));
  const rules=await request('/rules');assert.equal(rules.response.status,200);
  const created=await request('/rules',{csrf:csrf(rules.text),name:'My engineering feed',prompt:'',base:'engineering'});assert.equal(created.response.status,302);
  const list=await request('/rules');const match=/name="id" value="([^"]+)"/.exec(list.text);assert.ok(match,'rule persisted to local D1');
  const url='/?rule='+encodeURIComponent(match[1]);let published=false;
  for(let n=0;n<35;n++){const page=await request(url);assert.equal(page.response.status,200);if(/data-feed="[^"]+"/.test(page.text)){published=true;break;}await sleep(500);}
  assert.ok(published,'local Queue consumer publishes a private R2 snapshot');
  const privateAttempt=await request(url,undefined,false);assert.equal(privateAttempt.response.status,401);
  const denied=await request('/item-state',{csrf:'invalid',id:'123',action:'save'});assert.equal(denied.response.status,403);
  const sync=await fetch(origin+'/internal/sync',{method:'POST',headers:{Authorization:'Bearer local-test-token-32-characters-or-more'},signal:AbortSignal.timeout(5000)});
  assert.equal(sync.status,200);assert.deepEqual(await sync.json(),{enabled:false});
  const latestRules=await request('/rules');const saved=await request('/item-state',{csrf:csrf(latestRules.text),id:'123',action:'save'});assert.equal(saved.response.status,302);
  const savedPage=await request('/saved');assert.equal(savedPage.response.status,200);
  console.log('PASS: workerd, static assets, D1 registration, private rules, Queue → R2 snapshot, ownership, CSRF, disabled DO, saved state (10 smoke checks).');
}catch(error){console.error(logs.slice(-8000));throw error;}
finally{try{process.kill(-worker.pid,'SIGTERM');}catch{}await sleep(500);rmSync(state,{recursive:true,force:true});}
