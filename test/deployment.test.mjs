import test from 'node:test';
import assert from 'node:assert/strict';
import { settings, resourceNames, client, listAll, privateLifecycleRules, provision, deploymentConfig, verifyPublication } from '../scripts/cloudflare-deploy.mjs';

const auth = { token: 'test-not-a-real-token', accountId: 'a'.repeat(32), enableSync: true };
const databaseId = '12345678-1234-1234-1234-123456789abc';
const base = {
  name: 'jevnews', limits: { cpu_ms: 30000 }, ai: { binding: 'AI' },
  d1_databases: [{ binding: 'DB', database_name: 'jevnews', database_id: '00000000-0000-0000-0000-000000000000' }],
  r2_buckets: [{ binding: 'CONTENT', bucket_name: 'jevnews-content' }],
  queues: { producers: [{ binding: 'TASKS', queue: 'jevnews-tasks' }], consumers: [{ queue: 'jevnews-tasks', dead_letter_queue: 'jevnews-dlq' }] },
  vars: { ANALYSIS_ENABLED: 'true', RULE_COMPILATION_ENABLED: 'true', REGISTRATION_OPEN: 'true' },
};
const ok = result => ({ success: true, result });

test('credentials are required and error messages never contain a token', () => {
  assert.throws(() => settings({}), /authorization missing/);
  assert.throws(() => settings({ CLOUDFLARE_API_TOKEN: auth.token, CLOUDFLARE_ACCOUNT_ID: 'wrong' }), error => !error.message.includes(auth.token));
  assert.equal(settings({ CLOUDFLARE_API_TOKEN: auth.token, CLOUDFLARE_ACCOUNT_ID: auth.accountId }).enableSync, true);
});
test('synchronization toggle is strict', () => {
  assert.equal(settings({ CLOUDFLARE_API_TOKEN: auth.token, CLOUDFLARE_ACCOUNT_ID: auth.accountId, DEPLOY_ENABLE_SYNC: 'false' }).enableSync, false);
  assert.throws(() => settings({ CLOUDFLARE_API_TOKEN: auth.token, CLOUDFLARE_ACCOUNT_ID: auth.accountId, DEPLOY_ENABLE_SYNC: 'yes' }));
});
test('migration skip is explicit and strict', () => {
  assert.equal(settings({ CLOUDFLARE_API_TOKEN: auth.token, CLOUDFLARE_ACCOUNT_ID: auth.accountId, DEPLOY_SKIP_MIGRATIONS: 'true' }).skipMigrations, true);
  assert.equal(settings({ CLOUDFLARE_API_TOKEN: auth.token, CLOUDFLARE_ACCOUNT_ID: auth.accountId }).skipMigrations, false);
  assert.throws(() => settings({ CLOUDFLARE_API_TOKEN: auth.token, CLOUDFLARE_ACCOUNT_ID: auth.accountId, DEPLOY_SKIP_MIGRATIONS: 'yes' }));
});
test('analysis toggle is explicit and strict', () => {
  assert.equal(settings({ CLOUDFLARE_API_TOKEN: auth.token, CLOUDFLARE_ACCOUNT_ID: auth.accountId, DEPLOY_ENABLE_ANALYSIS: 'true' }).enableAnalysis, true);
  assert.equal(settings({ CLOUDFLARE_API_TOKEN: auth.token, CLOUDFLARE_ACCOUNT_ID: auth.accountId }).enableAnalysis, false);
  assert.throws(() => settings({ CLOUDFLARE_API_TOKEN: auth.token, CLOUDFLARE_ACCOUNT_ID: auth.accountId, DEPLOY_ENABLE_ANALYSIS: 'yes' }));
});
test('no unsafe names or custom DNS routes are accepted', () => {
  assert.equal(resourceNames(base).bucket, 'jevnews-content');
  assert.throws(() => resourceNames({ ...base, name: '../other' }));
  assert.throws(() => resourceNames({ ...base, routes: ['example.com/*'] }));
});
test('API client cannot send credentials to an arbitrary URL or subscription API', async () => {
  let calls = 0;
  const api = client(auth, async () => { calls++; return Response.json(ok({})); });
  await assert.rejects(api('https://elsewhere.example'), /Unexpected/);
  await assert.rejects(api('/subscriptions'), /Unexpected/);
  assert.equal(calls, 0);
});
test('API client fails closed on authorization errors and does not print response bodies', async () => {
  const api = client(auth, async (_url, init) => {
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, `Bearer ${auth.token}`);
    return Response.json({ success: false, errors: [{ code: 10000, message: auth.token }] }, { status: 403 });
  });
  await assert.rejects(api('/workers/subdomain'), error => error.message.includes('10000') && !error.message.includes(auth.token));
});
test('404 is only treated as absent when explicitly allowed', async () => {
  const api = client(auth, async () => Response.json({ success: false }, { status: 404 }));
  assert.equal(await api('/r2/buckets/jevnews-content', { allow404: true }), null);
  await assert.rejects(api('/r2/buckets/jevnews-content'));
});
test('resource pagination follows all pages', async () => {
  let calls = 0;
  const results = await listAll(async () => ({ ...ok(calls++ ? [{ name: 'last' }] : Array.from({ length: 100 }, () => ({ name: 'first' }))) }), '/queues');
  assert.equal(results.length, 101);
  assert.equal(calls, 2);
});
test('lifecycle rules preserve unrelated rules and are idempotent', () => {
  const existing = [{ id: 'unrelated-backup-rule', enabled: true, conditions: { prefix: 'backups/' } }];
  const updated = privateLifecycleRules(existing);
  assert.equal(existing.length, 1);
  assert.equal(updated.length, 3);
  assert.deepEqual(updated[0], existing[0]);
  assert.equal(updated[1].deleteObjectsTransition.condition.maxAge, 30 * 86400);
  assert.deepEqual(privateLifecycleRules(updated), updated);
});
test('conflicting lifecycle policies are never silently overwritten', () => {
  const rules = privateLifecycleRules([]);
  rules[0].deleteObjectsTransition.condition.maxAge = 86400;
  assert.throws(() => privateLifecycleRules(rules), /conflicts/);
});
function mockApi({ existing = false, publicBucket = false, deny = false } = {}) {
  const calls = [];
  const api = async (path, options = {}) => {
    calls.push([path, options]);
    if (deny) throw new Error('unauthorized');
    if (path === '/workers/subdomain') return ok({ subdomain: 'example-account' });
    if (path.startsWith('/d1/database?')) return ok(existing ? [{ name: 'jevnews', uuid: databaseId }] : []);
    if (path === '/d1/database' && options.method === 'POST') return ok({ name: 'jevnews', uuid: databaseId });
    if (path === '/r2/buckets/jevnews-content') return existing ? ok({ name: 'jevnews-content' }) : null;
    if (path === '/r2/buckets' && options.method === 'POST') return ok({ name: 'jevnews-content' });
    if (path.endsWith('/domains/managed')) return ok({ enabled: publicBucket });
    if (path.endsWith('/domains/custom')) return ok({ domains: [] });
    if (path.endsWith('/lifecycle')) return ok({ rules: existing ? privateLifecycleRules([]) : [] });
    if (path.startsWith('/queues?')) return ok(existing ? [{ queue_name: 'jevnews-tasks' }, { queue_name: 'jevnews-dlq' }] : []);
    if (path === '/queues' && options.method === 'POST') return ok({ queue_name: options.body.queue_name });
    throw new Error(`Unexpected mock route ${path}`);
  };
  return { api, calls };
}
test('provisioning creates only declared resources and bounded retention', async () => {
  const { api, calls } = mockApi();
  const result = await provision(api, resourceNames(base));
  assert.equal(result.databaseId, databaseId);
  assert.equal(result.url, 'https://jevnews.example-account.workers.dev');
  const writes = calls.filter(([, o]) => o.method);
  assert.equal(writes.length, 5);
  assert.equal(writes.filter(([p]) => p === '/queues').length, 2);
  assert.ok(writes.filter(([p]) => p === '/queues').every(([, o]) => o.body.settings.message_retention_period === 86400));
});
test('repeat provisioning reuses resources without writes', async () => {
  const { api, calls } = mockApi({ existing: true });
  await provision(api, resourceNames(base));
  assert.equal(calls.filter(([, o]) => o.method).length, 0);
});
test('invalid authorization stops before any resource creation', async () => {
  const { api, calls } = mockApi({ deny: true });
  await assert.rejects(provision(api, resourceNames(base)), /unauthorized/);
  assert.equal(calls.length, 1);
});
test('public content buckets are rejected without changing their public access', async () => {
  const { api, calls } = mockApi({ existing: true, publicBucket: true });
  await assert.rejects(provision(api, resourceNames(base)), /public domain/);
  assert.equal(calls.filter(([, o]) => o.method).length, 0);
});
test('publication config disables AI and registration without changing checked-in config', () => {
  const output = deploymentConfig(base, auth, { databaseId });
  assert.equal(output.d1_databases[0].database_id, databaseId);
  assert.equal(output.vars.SYNC_ENABLED, 'true');
  assert.equal(output.vars.ANALYSIS_ENABLED, 'false');
  assert.equal(output.vars.RULE_COMPILATION_ENABLED, 'false');
  assert.equal(output.vars.REGISTRATION_OPEN, 'false');
  assert.equal(output.ai, undefined);
  assert.equal(output.limits, undefined);
  assert.equal(base.vars.ANALYSIS_ENABLED, 'true');
  assert.ok(!JSON.stringify(output).includes(auth.token));
});
test('publication config keeps the AI binding only when analysis is enabled', () => {
  const disabled = deploymentConfig(base, { ...auth, enableAnalysis: false }, { databaseId });
  assert.equal(disabled.ai, undefined);
  const enabled = deploymentConfig(base, { ...auth, enableAnalysis: true }, { databaseId });
  assert.deepEqual(enabled.ai, base.ai);
  assert.equal(enabled.vars.ANALYSIS_ENABLED, 'true');
  assert.equal(enabled.vars.ANALYSIS_PROVIDER, 'workers-ai');
});
test('verification checks both health and a database-backed page', async () => {
  const urls = [];
  await verifyPublication('https://example.invalid', async url => {
    urls.push(url);
    return url.endsWith('/healthz') ? Response.json({ service: 'jevnews' }) : new Response('<title>JevNews</title>');
  });
  assert.equal(urls.length, 2);
});
test('verification never reports a broken publication as successful', async () => {
  let calls = 0;
  await assert.rejects(verifyPublication('https://example.invalid', async () => { calls++; return new Response('error', { status: 500 }); }, async () => {}), /did not pass/);
  assert.equal(calls, 8);
});

test('an empty lifecycle object represents no rules', async () => {
  const { api } = mockApi({ existing: true });
  let wrote = false;
  const wrapped = async (path, options = {}) => {
    if (path.endsWith('/lifecycle')) {
      if (options.method === 'PUT') { wrote = true; assert.equal(options.body.rules.length, 2); return ok({}); }
      return ok({});
    }
    return api(path, options);
  };
  await provision(wrapped, resourceNames(base));
  assert.equal(wrote, true);
});
