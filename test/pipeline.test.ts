import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './helpers.ts';
import { syncTick, handleJob, consume } from '../src/pipeline.ts';
import { enqueue, claim } from '../src/tasks.ts';
import { checkpoint, storeItem } from '../src/db.ts';
import { baseRule } from '../src/core.ts';
import { analysisQuestions } from '../src/providers.ts';
import { validateItem } from '../src/sources.ts';
test('new item IDs are recorded before the scan cursor advances',async()=>{
  const e=makeEnv();e.env.SYNC_ENABLED='true';let max=100;const oldFetch=globalThis.fetch;
  globalThis.fetch=(async(input:any)=>{const path=new URL(String(input)).pathname;if(path.endsWith('/maxitem.json'))return Response.json(max);if(path.endsWith('/updates.json'))return Response.json({items:[]});return Response.json([100,99]);}) as typeof fetch;
  try{await syncTick(e.env);max=103;await syncTick(e.env);assert.equal(await checkpoint(e.env,'scan_cursor'),'103');for(let id=101;id<=103;id++)assert.ok(e.sqlite.prepare("SELECT id FROM jobs WHERE kind='item' AND json_extract(payload,'$.id')=?").get(id));}
  finally{globalThis.fetch=oldFetch;}
});
test('inline HN text is analyzed once and shared by seven feeds',async()=>{
  const e=makeEnv();e.env.ANALYSIS_ENABLED='true';e.env.TYPESAFE_API_KEY='fixture';const oldFetch=globalThis.fetch;let calls=0;
  const item={id:101,type:'story',title:'Fixture database incident report',text:'We built a database and describe measured recovery behavior and concrete tradeoffs. '.repeat(10),time:Math.floor(Date.now()/1000),score:1};
  globalThis.fetch=(async(input:any)=>{
    if(String(input).includes('hacker-news.firebaseio.com'))return Response.json(item);
    if(String(input)==='https://api.typesafe.ai/v1/systemone'){
      calls++;const answers=Object.fromEntries(Object.entries(analysisQuestions()).map(([k,q])=>[k,q.type==='noul'?{type:'noul',noul:k==='topic_databases'?.9:.2}:q.type==='choice'?{type:'choice',choice:'experience'}:{type:'score',score:2.5}]));
      return Response.json({model:e.env.JEV_MODEL,answers,usage:{input_tokens:1000,output_tokens:0}});
    }throw new Error('unexpected network request');
  }) as typeof fetch;
  try{
    for(const [kind,payload] of [['item',{id:101}],['document',{documentId:'',itemId:101}]] as const){
      const body=kind==='document'?{documentId:String(e.sqlite.prepare('SELECT document_id FROM hn_items').get()!.document_id),itemId:101}:payload;
      const id=await enqueue(e.env,kind,'fixture-'+kind,body);const job=await claim(e.env,id);await handleJob(e.env,job!);
    }
    const job=e.sqlite.prepare("SELECT * FROM jobs WHERE kind='analysis'").get() as any;await handleJob(e.env,job);await handleJob(e.env,job);assert.equal(calls,1);
    await handleJob(e.env,{id:'pub',kind:'publish',payload:'{}',attempts:1,lease_token:'test'});
    assert.equal(e.sqlite.prepare('SELECT count(*) n FROM feed_heads').get()!.n,7);assert.equal(e.objects.size,8);
    // Deleted HN records may be only { id, deleted }, without a type field.
    const tombstone=validateItem({id:101,deleted:true},101);assert.equal(tombstone?.deleted,true);
    globalThis.fetch=(async()=>Response.json({id:101,deleted:true})) as typeof fetch;
    await handleJob(e.env,{id:'delete',kind:'item',payload:'{"id":101}',attempts:1,lease_token:'test'});
    const deleted=e.sqlite.prepare('SELECT deleted,text_html,title FROM hn_items WHERE id=101').get()!;
    assert.equal(deleted.deleted,1);assert.equal(deleted.text_html,'');assert.equal(deleted.title,null);
  }finally{globalThis.fetch=oldFetch;}
});
test('Workers AI fallback produces a real structured analysis',async()=>{
  const e=makeEnv();e.env.ANALYSIS_ENABLED='true';e.env.ANALYSIS_PROVIDER='workers-ai';e.env.DAILY_ANALYSIS_CALLS='100';
  e.env.AI={run:async()=>({response:JSON.stringify({topics:Object.fromEntries(['ai','databases','systems','engineering','security','hardware','science','math','design','products','startups','history','other'].map(topic=>[topic,topic==='databases'?1:0])),kind:'experience',depth:.8,evidence:.7,firsthand:.9,promotion:.1,difficulty:.6})})} as any;
  await e.env.CONTENT.put('documents/ai.txt','Concrete database recovery report with measured tradeoffs.');
  const id=await enqueue(e.env,'analysis','workers-ai',{hash:'ai',key:'documents/ai.txt',title:'Database recovery',scope:'extracted'});
  const job=await claim(e.env,id);await handleJob(e.env,job!);
  const row=e.sqlite.prepare('SELECT data_json,model FROM analyses').get() as any;
  assert.equal(row.model,e.env.JEV_MODEL);assert.equal(JSON.parse(row.data_json).model,e.env.RULE_MODEL);assert.equal(JSON.parse(row.data_json).kind,'experience');
});
test('disabled model leaves task pending, not a fabricated zero-score analysis',async()=>{const e=makeEnv();await e.env.CONTENT.put('documents/hash.txt','test content');const id=await enqueue(e.env,'analysis','hash',{hash:'hash',key:'documents/hash.txt',title:'test',scope:'extracted'});let ack=false;await consume(e.env,{messages:[{body:{id},ack(){ack=true;},retry(){}}]} as any);assert.equal(ack,true);assert.equal(e.sqlite.prepare('SELECT status FROM jobs').get()!.status,'pending');assert.equal(e.sqlite.prepare('SELECT count(*) n FROM analyses').get()!.n,0);});
test('private condition tasks require substantive source analysis',async()=>{const e=makeEnv();e.sqlite.exec("INSERT INTO users VALUES('a','alice','hash','recovery',0)");e.sqlite.prepare('INSERT INTO private_rules(id,owner_id,name,prompt,compiled_json,created_at) VALUES(?,?,?,?,?,0)').run('r','a','rule','',JSON.stringify({...baseRule(),semantic:[{question:'supports recovery?',required:true}]}));await storeItem(e.env,{id:1,type:'story',title:'unknown',time:Math.floor(Date.now()/1000)});await handleJob(e.env,{id:'p',kind:'private-feed',payload:JSON.stringify({owner:'a',ruleId:'r'}),attempts:1,lease_token:'test'});assert.equal(e.sqlite.prepare("SELECT count(*) n FROM jobs WHERE kind='evaluate'").get()!.n,0);});
