import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseRule, validateRule, validateExpr, matches, rank, grade, PRESETS } from '../src/core.ts';
import { richText, escapeHTML, publicURL, publicIP, hashPassword, verifyPassword, assertSameOrigin } from '../src/security.ts';
import { robotsAllowed, limitedText, validateItem } from '../src/sources.ts';
import { analysisQuestions, parseAnswers, jev } from '../src/providers.ts';
import type { Candidate, Analysis } from '../src/types.ts';
import { makeEnv } from './helpers.ts';
const analysis:Analysis={topics:{databases:.99,systems:.8},kind:'postmortem',depth:.9,evidence:.8,firsthand:.9,promotion:.1,difficulty:.8,scope:'extracted',model:'test'};
const c:Candidate={item:{id:1,type:'story',url:'https://db.example.net/post',title:'A storage incident',time:Date.now()/1000,score:1},analysis};
test('seven presets and valid defaults',()=>{assert.equal(Object.keys(PRESETS).length,7);for(const id in PRESETS)assert.deepEqual(validateRule(baseRule(id)),baseRule(id));});
test('unknown executable fields and code rejected',()=>{assert.throws(()=>validateRule({...baseRule(),sql:'DROP TABLE users'}));assert.throws(()=>validateRule({...baseRule(),base:'__proto__'}));});
test('invalid and nonfinite weights rejected',()=>{for(const weight of [NaN,Infinity,4])assert.throws(()=>validateRule({...baseRule(),topicWeights:{ai:weight}}));});
test('semantic count and types bounded',()=>{assert.throws(()=>validateRule({...baseRule(),semantic:Array(4).fill({question:'some condition',required:true})}));assert.throws(()=>validateRule({...baseRule(),semantic:[{question:'ok?',required:'yes'}]}));});
test('conditions have bounded nesting',()=>{assert.throws(()=>validateExpr({not:{not:{not:{not:{field:'topic',value:'ai'}}}}}));});
test('unknown condition remains unknown under NOT',()=>{assert.equal(matches({not:{field:'topic',value:'ai'}},{...c,analysis:null}),null);});
test('three-valued and/or semantics',()=>{const missing={...c,analysis:null};assert.equal(matches({all:[{field:'domain',value:'different.net'},{field:'topic',value:'ai'}]},missing),false);assert.equal(matches({any:[{field:'domain',value:'db.example.net'},{field:'topic',value:'ai'}]},missing),true);});
test('hard domain exclusion cannot be undone by exception',()=>{const r={...baseRule(),excludeDomains:['example.net'],exception:{field:'topic' as const,value:'databases'}};assert.equal(grade(c,r,Date.now()).match,false);});
test('promotion penalty works without exception',()=>{const p={...c,analysis:{...analysis,promotion:1,depth:0}};assert.ok(grade(p,baseRule(),Date.now()).score<grade({...p,analysis:{...p.analysis,promotion:0}},baseRule(),Date.now()).score);});
test('rank can surface low-vote deep articles',()=>{const shallow={...c,item:{...c.item,id:2,score:1000,url:'https://other.net'},analysis:{...analysis,depth:0,evidence:0,firsthand:0,kind:'news' as const}};assert.equal(rank([shallow,c],baseRule('systems')).ids[0],1);});
test('deleted and duplicate documents excluded',()=>{const d={...c,item:{...c.item,id:3},documentHash:'same'};const r=rank([{...c,documentHash:'same'},d,{...c,item:{...c.item,id:4,deleted:true}}],baseRule());assert.equal(r.ids.length,1);assert.ok(!r.ids.includes(4));});
test('required unassessed semantics are not a match',()=>{const r={...baseRule(),semantic:[{question:'Supports recovery?',required:true}]};assert.equal(grade(c,r,Date.now()).match,null);assert.equal(grade(c,r,Date.now(),[.5]).match,null);assert.equal(grade(c,r,Date.now(),[.9]).match,true);assert.equal(grade(c,r,Date.now(),[.1]).match,false);});
test('metadata-only judgment cannot satisfy hard content constraint',()=>{assert.equal(matches({field:'depth',value:.5},{...c,analysis:{...analysis,scope:'metadata'}}),null);});
test('HTML renderer never emits dangerous source attributes',()=>{
  for(const payload of ['<img src=x onerror=alert(1)>','<svg onload=alert(1)>','<script>alert(1)</script>','<a href="javascript:alert(1)" onclick="alert(1)">x</a>','<a href="jav&#97;script:alert(1)">x</a>']){
    const s=richText(payload);assert.ok(!/<(script|img|svg)\b/.test(s));assert.ok(!/<a[^>]+(?:onclick=|href="javascript:)/.test(s));
  }
});
test('safe comment markup and links survive',()=>{assert.match(richText('<p>Hello <i>world</i> <a href="https://example.net/?a=1&amp;b=2">link</a></p>'),/<i>world<\/i>/);assert.equal(escapeHTML('<&'),'&lt;&amp;');});
test('URL guard rejects protocols, credentials and local addresses',()=>{for(const url of ['file:///etc/passwd','http://127.0.0.1','http://2130706433','http://[::1]','https://user:pass@example.com','http://service.internal','http://host.local','https://example.com:8080'])assert.throws(()=>publicURL(url));assert.equal(publicURL('https://example.com/path#x').hash,'');});
test('DNS address checks block private and mapped networks',()=>{for(const ip of ['127.0.0.1','10.2.3.4','192.168.0.1','169.254.169.254','172.16.0.1','100.64.0.1','::1','::ffff:127.0.0.1','fd00::1'])assert.equal(publicIP(ip),false,ip);assert.equal(publicIP('1.1.1.1'),true);});
test('robots longest matching path, allow exceptions and wildcard',()=>{assert.equal(robotsAllowed('User-agent: *\nDisallow: /private\nAllow: /private/public','/private/secret'),false);assert.equal(robotsAllowed('User-agent: *\nDisallow: /private\nAllow: /private/public','/private/public/a'),true);assert.equal(robotsAllowed('User-agent: *\nDisallow: /*.pdf$','/a.pdf'),false);});
test('response bodies have a hard byte limit',async()=>{await assert.rejects(limitedText(new Response('123456'),5),/too_large/);});
test('HN validates item identity',()=>{assert.throws(()=>validateItem({id:2,type:'story'},1));assert.equal(validateItem(null,1),null);});
test('cross-origin POST rejected',()=>{assert.throws(()=>assertSameOrigin(new Request('https://site.net/post',{method:'POST',headers:{origin:'https://evil.net'}})));});
test('scrypt hash is salted and verifies securely',async()=>{const h=await hashPassword('a-long-test-password');assert.equal(await verifyPassword('a-long-test-password',h),true);assert.equal(await verifyPassword('a-different-password',h),false);assert.notEqual(h,await hashPassword('a-long-test-password'));assert.equal(await verifyPassword('short',h),false);});
test('Jev wire contract uses noul/score/choice, not generated value fields',()=>{const q={yes:{type:'noul' as const,instructions:'yes?'},depth:{type:'score' as const,instructions:'depth',criteria:['none','some','full']}};assert.deepEqual(parseAnswers({answers:{yes:{type:'noul',noul:.8},depth:{type:'score',score:1}}},q),{yes:.8,depth:.5});assert.throws(()=>parseAnswers({answers:{yes:{type:'noul',value:true}}},q));assert.ok(Object.keys(analysisQuestions()).length>15);});
test('Jev response validation rejects missing, nonfinite, out-of-range values',()=>{const q={a:{type:'noul' as const,instructions:'x'}};for(const v of [-1,2,NaN])assert.throws(()=>parseAnswers({answers:{a:{type:'noul',noul:v}}},q));});
test('Jev reserves and settles actual token use without live credentials',async()=>{
  const {env,sqlite}=makeEnv();env.ANALYSIS_ENABLED='true';env.TYPESAFE_API_KEY='fixture-not-a-key';let body:any;
  const fetcher=(async(_url:any,init:any)=>{body=JSON.parse(init.body);return Response.json({model:'jev-1.13.0',answers:{a:{type:'noul',noul:.8}},usage:{input_tokens:123,output_tokens:0}});}) as typeof fetch;
  const r=await jev(env,'test-job',{text:'fixture'},{a:{type:'noul',instructions:'x'}},fetcher);
  assert.equal(body.model,'jev-1.13.0');assert.equal(r.tokens,123);assert.equal(sqlite.prepare('SELECT amount FROM budgets').get()!.amount,123);
});
test('uncertain external call retains reservation',async()=>{const {env,sqlite}=makeEnv();env.ANALYSIS_ENABLED='true';env.TYPESAFE_API_KEY='fixture';await assert.rejects(jev(env,'job','source',{a:{type:'noul',instructions:'x'}},async()=>{throw new Error('network_lost');}));assert.equal(sqlite.prepare('SELECT state FROM ai_calls').get()!.state,'uncertain');assert.ok(Number(sqlite.prepare('SELECT amount FROM budgets').get()!.amount)>0);});
