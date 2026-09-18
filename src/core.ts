import { TOPICS, KINDS } from './types.ts';
import type { Topic, Kind, Candidate, Analysis, Expr, Rule } from './types.ts';

export const RUBRIC = 'v1';
export const PRESETS: Record<string, { name: string; description: string; topics: Topic[]; kinds: Kind[] }> = {
  balanced: { name:'Balanced', description:'Explanations, evidence and curiosity across subjects.', topics:[], kinds:['explanation','experience','research'] },
  engineering: { name:'Engineering', description:'Real implementations, incidents, measurements and tradeoffs.', topics:['engineering','systems','security'], kinds:['experience','postmortem','benchmark'] },
  'ai-builders': { name:'AI & Agents', description:'Building, evaluating and operating AI systems.', topics:['ai'], kinds:['experience','project','benchmark','research'] },
  systems: { name:'Systems & Databases', description:'Storage, databases, networks and system internals.', topics:['databases','systems'], kinds:['explanation','benchmark','postmortem'] },
  builders: { name:'Show & Build', description:'Concrete projects and small, low-visibility experiments.', topics:[], kinds:['project'] },
  startups: { name:'Products & Startups', description:'First-hand product and business lessons, not just announcements.', topics:['products','startups'], kinds:['experience','essay'] },
  curiosity: { name:'Curiosity', description:'Science, mathematics, history, hardware and design.', topics:['science','math','history','hardware','design'], kinds:['explanation','research','essay'] }
};
export function baseRule(base='balanced'): Rule {
  return { base: Object.hasOwn(PRESETS,base)?base:'balanced', topicWeights:{},preferKinds:[],avoidKinds:[],excludeDomains:[],require:null,exception:null,semantic:[],unsupported:[] };
}
function object(x: unknown): Record<string,unknown> {
  if(!x || typeof x!=='object' || Array.isArray(x)) throw new Error('Expected an object');
  return x as Record<string,unknown>;
}
function only(x:Record<string,unknown>, keys:string[]) {
  if(Object.keys(x).some(k=>!keys.includes(k))) throw new Error('Unsupported rule field');
}
function number(x:unknown,min:number,max:number): number {
  if(typeof x!=='number'||!Number.isFinite(x)||x<min||x>max) throw new Error('Number out of bounds');
  return x;
}
function list(x:unknown,allowed:readonly string[],max=15):string[] {
  if(!Array.isArray(x)||x.length>max||x.some(v=>typeof v!=='string'||!allowed.includes(v))) throw new Error('Unsupported list value');
  return [...new Set(x)];
}
export function validateExpr(value:unknown,depth=0):Expr|null {
  if(value===null) return null;
  if(depth>3) throw new Error('Condition nesting is too deep');
  const v=object(value);
  if('all' in v || 'any' in v) {
    const key='all' in v?'all':'any'; only(v,[key]);const a=v[key];
    if(!Array.isArray(a)||a.length<1||a.length>4) throw new Error('Invalid condition group');
    const children=a.map(x=>validateExpr(x,depth+1));
    if(children.some(x=>x===null))throw new Error('Empty condition');
    return { [key]:children } as Expr;
  }
  if('not' in v) {
    only(v,['not']);const c=validateExpr(v.not,depth+1);
    if(!c)throw new Error('Empty negation');return {not:c};
  }
  only(v,['field','value']);
  if(v.field==='topic')list([v.value],TOPICS);
  else if(v.field==='kind')list([v.value],KINDS);
  else if(v.field==='domain') {
    if(typeof v.value!=='string'||!validDomain(v.value))throw new Error('Invalid domain');
  }
  else if(['depth','evidence','firsthand','promotion'].includes(String(v.field))) number(v.value,0,1);
  else throw new Error('Unsupported condition');
  return v as unknown as Expr;
}
export function validDomain(x:string) {
  return x.length<=253 && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(x);
}
export function validateRule(value:unknown):Rule {
  if(JSON.stringify(value).length>12000)throw new Error('Rule too large');
  const v=object(value);only(v,['base','topicWeights','preferKinds','avoidKinds','excludeDomains','require','exception','semantic','unsupported']);
  if(typeof v.base!=='string'||!Object.hasOwn(PRESETS,v.base))throw new Error('Unknown preset');
  const weights=object(v.topicWeights);only(weights,[...TOPICS]);
  for(const x of Object.values(weights))number(x,-3,3);
  const domains=v.excludeDomains;
  if(!Array.isArray(domains)||domains.length>20||domains.some(x=>typeof x!=='string'||!validDomain(x)))throw new Error('Invalid excluded domains');
  const semantic=v.semantic;
  if(!Array.isArray(semantic)||semantic.length>3)throw new Error('At most three semantic conditions');
  for(const s of semantic){
    const q=object(s);only(q,['question','required']);
    if(typeof q.question!=='string'||q.question.trim().length<3||q.question.length>400||typeof q.required!=='boolean')throw new Error('Invalid semantic condition');
  }
  const unsupported=v.unsupported;
  if(!Array.isArray(unsupported)||unsupported.length>8||unsupported.some(x=>typeof x!=='string'||x.length>400))throw new Error('Invalid unsupported requirements');
  return {base:v.base,topicWeights:weights as Rule['topicWeights'],preferKinds:list(v.preferKinds,KINDS) as Kind[],avoidKinds:list(v.avoidKinds,KINDS) as Kind[],excludeDomains:domains.map(x=>x.toLowerCase()),require:validateExpr(v.require),exception:validateExpr(v.exception),semantic:semantic as Rule['semantic'],unsupported};
}
export type Truth = true|false|null;
export function domainOf(url?:string) {
  try{return new URL(url||'').hostname.toLowerCase().replace(/^www\./,'');}catch{return '';}
}
export function matches(expr:Expr|null,c:Candidate):Truth {
  if(!expr)return true;
  if('all' in expr){const r=expr.all.map(x=>matches(x,c));return r.includes(false)?false:r.includes(null)?null:true;}
  if('any' in expr){const r=expr.any.map(x=>matches(x,c));return r.includes(true)?true:r.includes(null)?null:false;}
  if('not' in expr){const r=matches(expr.not,c);return r===null?null:!r;}
  if(expr.field==='domain')return domainOf(c.item.url)===expr.value||domainOf(c.item.url).endsWith('.'+expr.value);
  const a=c.analysis;if(!a || a.scope==='metadata')return null;
  if(expr.field==='topic')return (a.topics[expr.value as Topic]??0)>=0.65;
  if(expr.field==='kind')return a.kind===expr.value;
  return a[expr.field]>=Number(expr.value);
}
export function grade(c:Candidate,rule:Rule,now:number,semantic?:number[]):{score:number;match:Truth;picked:boolean} {
  if(c.item.deleted||c.item.dead||c.item.type==='job')return {score:-Infinity,match:false,picked:false};
  const domain=domainOf(c.item.url);
  if(rule.excludeDomains.some(d=>domain===d||domain.endsWith('.'+d)))return {score:-Infinity,match:false,picked:false};
  let match=matches(rule.require,c);const a=c.analysis;let bonus=0;
  rule.semantic.forEach((q,i)=>{
    const p=semantic?.[i];
    if(q.required){if(p===undefined || p>0.2&&p<0.8){if(match!==false)match=null;}else if(p<=0.2)match=false;}
    else if(p!==undefined)bonus+=p*2;
  });
  if(match!==true)return {score:-Infinity,match,picked:false};
  const age=Math.max(0,(now/1000-(c.item.time||0))/3600);
  let score=1/(1+age/36)+Math.min(Math.log1p(c.item.score||0)/10,0.4)+bonus;
  if(a){
    const preset=PRESETS[rule.base]!;score+=a.depth*1.5+a.evidence+a.firsthand*.7;
    score+=preset.topics.reduce((m,t)=>Math.max(m,a.topics[t]||0),0)*3;
    if(preset.kinds.includes(a.kind))score+=1.2;
    for(const [t,w] of Object.entries(rule.topicWeights))score+=(a.topics[t as Topic]||0)*w!;
    if(rule.preferKinds.includes(a.kind))score+=1.5;
    if(!rule.exception||matches(rule.exception,c)!==true){
      if(rule.avoidKinds.includes(a.kind))score-=2;
      score-=a.promotion*(1-a.depth)*1.5;
    }
    if(a.scope==='metadata')score-=1;
  }
  return {score,match,picked:!!a&&a.scope!=='metadata'&&score>=4};
}
export function rank(candidates:Candidate[],rule:Rule,now=Date.now(),evaluations:Map<string,number[]>=new Map()) {
  let unknown=0;
  const ranked=candidates.flatMap(c=>{
    const g=grade(c,rule,now,evaluations.get(c.documentHash||''));
    if(g.match===null)unknown++;return g.match===true?[{...g,c}]:[];
  }).sort((a,b)=>b.score-a.score||b.c.item.id-a.c.item.id);
  const ids:number[]=[];const picks:number[]=[];const seen=new Set<string>();let last='';let run=0;
  while(ranked.length){
    let index=0;
    if(run>=3){const alternative=ranked.findIndex(x=>dominant(x.c.analysis)!==last);if(alternative>=0)index=alternative;}
    const x=ranked.splice(index,1)[0]!;const key=x.c.documentHash||x.c.item.url||String(x.c.item.id);
    if(seen.has(key))continue;seen.add(key);
    const topic=dominant(x.c.analysis);run=topic===last?run+1:1;last=topic;
    ids.push(x.c.item.id);if(x.picked)picks.push(x.c.item.id);
  }
  return {ids,picks,unknown};
}
function dominant(a:Analysis|null):string {
  return a?Object.entries(a.topics).sort((x,y)=>(y[1]||0)-(x[1]||0))[0]?.[0]||'other':'unknown';
}
export function boundedInt(s:string|undefined,fallback:number,min:number,max:number){
  const n=Number(s);return Number.isSafeInteger(n)&&n>=min&&n<=max?n:fallback;
}
