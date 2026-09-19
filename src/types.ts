export interface Env {
  DB: D1Database; CONTENT: R2Bucket; TASKS: Queue<{ id: string }>;
  SYNC: DurableObjectNamespace; ASSETS: Fetcher; AI: Ai;
  APP_ENV: string; SYNC_ENABLED: string; SYNC_INTERVAL_MS: string;
  ANALYSIS_ENABLED: string; ANALYSIS_PROVIDER?: string; DAILY_ANALYSIS_CALLS?: string;
  RULE_COMPILATION_ENABLED?: string; REGISTRATION_OPEN: string;
  JEV_MODEL: string; RULE_MODEL: string; DAILY_TOKEN_BUDGET: string;
  DAILY_COMPILE_BUDGET: string; MAX_SCAN_IDS: string; MAX_CANDIDATES: string;
  TURNSTILE_SITE_KEY: string; TURNSTILE_HOSTNAME: string;
  TYPESAFE_API_KEY?: string; TURNSTILE_SECRET_KEY?: string; ADMIN_TOKEN?: string;
}
export interface Item {
  id: number; type: string; title?: string; url?: string; by?: string;
  time?: number; score?: number; descendants?: number; parent?: number;
  kids?: number[]; text?: string; deleted?: boolean; dead?: boolean;
}
export const TOPICS = ['ai','databases','systems','engineering','security','hardware','science','math','design','products','startups','history','other'] as const;
export const KINDS = ['tutorial','explanation','experience','postmortem','benchmark','research','project','release','news','essay','question'] as const;
export type Topic = typeof TOPICS[number];
export type Kind = typeof KINDS[number];
export interface Analysis {
  topics: Partial<Record<Topic, number>>; kind: Kind;
  depth: number; evidence: number; firsthand: number; promotion: number;
  difficulty: number; scope: 'extracted'|'truncated'|'metadata'; model: string;
}
export interface Candidate { item: Item; analysis: Analysis|null; documentHash?: string }
export type Expr = { all: Expr[] } | { any: Expr[] } | { not: Expr } |
  { field: 'topic'|'kind'|'domain'|'depth'|'evidence'|'firsthand'|'promotion'; value: string|number };
export interface Rule {
  base: string; topicWeights: Partial<Record<Topic,number>>;
  preferKinds: Kind[]; avoidKinds: Kind[]; excludeDomains: string[];
  require: Expr|null; exception: Expr|null;
  semantic: { question: string; required: boolean }[]; unsupported: string[];
}
export interface User { id: string; username: string; csrf: string }
export interface Job { id: string; kind: string; payload: string; attempts: number; lease_token: string }
export interface Feed {
  id: string; view: string; owner: string|null; ids: number[]; picks: number[];
  createdAt: number; expiresAt: number; coverage: string;
}
export interface RuleRow {
  id: string; owner_id: string; name: string; prompt: string;
  compiled_json: string; draft_json: string|null; version: number; state: string;
}
