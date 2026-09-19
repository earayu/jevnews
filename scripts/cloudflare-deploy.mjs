/**
 * Authenticated first publication of JevNews. No billing, DNS, or AI API calls.
 * Required environment: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.
 * Resource operations are scoped to names already declared in wrangler.jsonc.
 */
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const API = 'https://api.cloudflare.com/client/v4';
const NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function settings(env = process.env) {
  const token = env.CLOUDFLARE_API_TOKEN?.trim();
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (!token || !accountId) throw new Error('Cloudflare authorization missing. Add CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID to repository Actions secrets. No deployment was attempted.');
  if (!/^[a-f0-9]{32}$/i.test(accountId)) throw new Error('CLOUDFLARE_ACCOUNT_ID must be a 32-character account ID, not a zone ID or email.');
  if (env.DEPLOY_ENABLE_SYNC !== undefined && !['true', 'false'].includes(env.DEPLOY_ENABLE_SYNC)) throw new Error('DEPLOY_ENABLE_SYNC must be true or false.');
  if (env.DEPLOY_SKIP_MIGRATIONS !== undefined && !['true', 'false'].includes(env.DEPLOY_SKIP_MIGRATIONS)) throw new Error('DEPLOY_SKIP_MIGRATIONS must be true or false.');
  return {
    token,
    accountId,
    enableSync: env.DEPLOY_ENABLE_SYNC !== 'false',
    skipMigrations: env.DEPLOY_SKIP_MIGRATIONS === 'true',
  };
}

export function resourceNames(base) {
  const names = {
    worker: base.name,
    database: base.d1_databases?.find(x => x.binding === 'DB')?.database_name,
    bucket: base.r2_buckets?.find(x => x.binding === 'CONTENT')?.bucket_name,
    queue: base.queues?.producers?.find(x => x.binding === 'TASKS')?.queue,
    deadLetter: base.queues?.consumers?.[0]?.dead_letter_queue,
  };
  for (const [key, value] of Object.entries(names)) {
    if (typeof value !== 'string' || !NAME.test(value)) throw new Error(`Missing or unsafe ${key} resource name in wrangler.jsonc.`);
  }
  if (names.queue === names.deadLetter) throw new Error('Task and dead-letter queues must be different.');
  if (base.queues.consumers.length !== 1 || base.queues.consumers[0].queue !== names.queue) throw new Error('Expected a single matching task queue consumer.');
  if (base.routes?.length || base.route || base.zone_id) throw new Error('This first-publication helper supports workers.dev only; it will not change DNS or custom routes.');
  return names;
}

export function client({ token, accountId }, fetcher = fetch) {
  return async (path, { method = 'GET', body, allow404 = false } = {}) => {
    // Never accept a URL supplied by an API response or forward credentials to a redirect.
    if (!/^\/(workers\/subdomain|d1\/database|queues|r2\/buckets)([/?]|$)/.test(path) || path.includes('..')) throw new Error('Unexpected Cloudflare API operation.');
    const response = await fetcher(`${API}/accounts/${accountId}${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 404 && allow404) return null;
    let payload;
    try { payload = await response.json(); } catch { throw new Error(`Cloudflare returned a non-JSON response (${response.status}).`); }
    if (!response.ok || payload.success !== true) {
      const codes = (payload.errors || []).map(x => Number(x.code)).filter(Number.isFinite).join(',');
      // Deliberately exclude request/response bodies, which can contain credentials.
      throw new Error(`Cloudflare ${method} ${path.split('?')[0]} failed: HTTP ${response.status}, codes ${codes || 'unknown'}. Check token permissions, account, and R2 activation. No plan is upgraded automatically.`);
    }
    return payload;
  };
}

export async function listAll(api, path) {
  const items = [];
  for (let page = 1; page <= 100; page++) {
    const data = await api(`${path}${path.includes('?') ? '&' : '?'}page=${page}&per_page=100`);
    if (!Array.isArray(data.result)) throw new Error('Unexpected resource list response.');
    items.push(...data.result);
    if (data.result.length < 100 || (data.result_info?.total_pages && page >= data.result_info.total_pages)) return items;
  }
  throw new Error('Resource list exceeded the bounded pagination limit.');
}

export function privateLifecycleRules(rules) {
  if (!Array.isArray(rules)) throw new Error('Unexpected R2 lifecycle response; existing rules were not changed.');
  const output = structuredClone(rules);
  for (const [id, prefix, days] of [
    ['jevnews-documents-30d', 'documents/', 30],
    ['jevnews-snapshots-3d', 'snapshots/', 3],
  ]) {
    const expected = { id, enabled: true, conditions: { prefix }, deleteObjectsTransition: { condition: { type: 'Age', maxAge: days * 86400 } } };
    const existing = output.find(rule => rule.id === id);
    if (existing) {
      const condition = existing.deleteObjectsTransition?.condition;
      if (existing.enabled !== true || existing.conditions?.prefix !== prefix || condition?.type !== 'Age' || condition.maxAge !== days * 86400) {
        throw new Error(`R2 lifecycle ${id} conflicts with the documented retention policy. Review it manually; not overwritten.`);
      }
    } else output.push(expected);
  }
  return output;
}

export async function provision(api, names) {
  // Validate workers.dev before creating resources. Never choose/change an account subdomain.
  const domain = (await api('/workers/subdomain')).result?.subdomain;
  if (typeof domain !== 'string' || !NAME.test(domain)) throw new Error('Configure your workers.dev subdomain in the Cloudflare dashboard first.');
  const databases = (await listAll(api, `/d1/database?name=${encodeURIComponent(names.database)}`)).filter(x => x.name === names.database);
  if (databases.length > 1) throw new Error('More than one exact-name database was found; refusing to choose.');
  const database = databases[0] || (await api('/d1/database', { method: 'POST', body: { name: names.database, primary_location_hint: 'apac' } })).result;
  if (!UUID.test(database?.uuid || '') || database.uuid === '00000000-0000-0000-0000-000000000000') throw new Error('Cloudflare did not return a usable database UUID.');

  const bucketPath = `/r2/buckets/${encodeURIComponent(names.bucket)}`;
  if (!await api(bucketPath, { allow404: true })) await api('/r2/buckets', { method: 'POST', body: { name: names.bucket } });
  // The deployment helper never enables an R2 public domain. Fail closed if one already exists.
  const managed = (await api(`${bucketPath}/domains/managed`)).result;
  const custom = (await api(`${bucketPath}/domains/custom`)).result;
  if (typeof managed?.enabled !== 'boolean' || !Array.isArray(custom?.domains)) throw new Error('Unable to verify that the content bucket is private.');
  if (managed.enabled || custom.domains.length > 0) throw new Error('The content bucket has a public domain. Disable it before deploying; public access was not changed automatically.');
  const lifecycle = (await api(`${bucketPath}/lifecycle`)).result;
  if (!lifecycle || typeof lifecycle !== 'object') throw new Error('Unexpected R2 lifecycle result.');
  const currentRules = lifecycle.rules ?? [];
  const rules = privateLifecycleRules(currentRules);
  if (rules.length !== currentRules.length) await api(`${bucketPath}/lifecycle`, { method: 'PUT', body: { rules } });

  const queues = await listAll(api, '/queues');
  for (const name of [names.queue, names.deadLetter]) {
    const matches = queues.filter(x => x.queue_name === name);
    if (matches.length > 1) throw new Error('Ambiguous queue name; refusing to choose.');
    if (!matches.length) await api('/queues', { method: 'POST', body: { queue_name: name, settings: { message_retention_period: 86400 } } });
  }
  return { databaseId: database.uuid, url: `https://${names.worker}.${domain}.workers.dev` };
}

export function deploymentConfig(base, config, resources) {
  const output = structuredClone(base);
  output.account_id = config.accountId;
  output.workers_dev = true;
  output.d1_databases.find(x => x.binding === 'DB').database_id = resources.databaseId;
  // Let the existing account plan set CPU limits. This is NOT a plan upgrade.
  delete output.limits;
  // Initial publication deliberately excludes AI and public registration.
  delete output.ai;
  Object.assign(output.vars, {
    APP_ENV: 'production', SYNC_ENABLED: String(config.enableSync),
    ANALYSIS_ENABLED: 'false', RULE_COMPILATION_ENABLED: 'false', REGISTRATION_OPEN: 'false',
  });
  return output;
}

export async function verifyPublication(url, fetcher = fetch, pause = sleep) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const health = await fetcher(`${url}/healthz`, { redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (!health.ok || (await health.json()).service !== 'jevnews') throw new Error('Health check failed.');
      const home = await fetcher(`${url}/news?view=hn`, { redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (!home.ok || !(await home.text()).includes('JevNews')) throw new Error('Database-backed page check failed.');
      return;
    } catch { if (attempt < 7) await pause(5000); }
  }
  throw new Error('Worker upload completed, but the public HTTP checks did not pass. Inspect Cloudflare logs before treating this as a successful release.');
}

export async function main(env = process.env) {
  const config = settings(env); // Must happen before every resource or filesystem write.
  const base = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
  const names = resourceNames(base);
  console.log('Preparing JevNews resources. AI and registration remain disabled; no billing plan or domain changes.');
  const resources = await provision(client(config), names);
  const generated = 'wrangler.deploy.json';
  await writeFile(generated, JSON.stringify(deploymentConfig(base, config, resources), null, 2) + '\n', { mode: 0o600 });
  const cli = resolve('node_modules/wrangler/bin/wrangler.js');
  const execute = args => execFileSync(process.execPath, [cli, ...args], {
    stdio: 'inherit', timeout: 300000,
    env: { ...env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
  });
  if (config.skipMigrations) console.log('Skipping remote D1 migrations by explicit request; the database schema is already provisioned.');
  else execute(['d1', 'migrations', 'apply', names.database, '--remote', '--config', generated]);
  execute(['deploy', '--config', generated, '--no-x-provision']);
  await verifyPublication(resources.url);
  console.log(`Verified JevNews publication: ${resources.url}`);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY,
    `## Cloudflare publication verified\n\n[Open JevNews](${resources.url})\n\n- HN synchronization: ${config.enableSync ? 'enabled; Cron starts the coordinator' : 'disabled'}\n- AI analysis / rule compilation: disabled\n- Public registration: disabled pending Turnstile verification\n- No domain purchase or subscription upgrade\n\nHTTP checks verify the application and database-backed page, not continuous synchronization or model quality.\n`);
  return resources.url;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(async error => {
    console.error(error.message);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `## Cloudflare publication not verified\n\nSee the failed step. Partial resources may have been created; the script never deletes a database or bucket on failure. Fix authorization/configuration and rerun.\n`);
    process.exitCode = 1;
  });
}
