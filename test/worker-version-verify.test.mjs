import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions, liveVersion, verifyVersion } from '../worker-version-verify.mjs';

const b64 = (s) => Buffer.from(s).toString('base64');
const version = (overrides = {}) => ({
  main_module: 'index.js',
  compatibility_date: '2026-10-18',
  compatibility_flags: ['nodejs_compat'],
  usage_model: 'standard',
  assets: { config: { run_worker_first: false, html_handling: 'auto-trailing-slash', not_found_handling: 'none' } },
  bindings: [
    { name: 'API_ORIGIN', type: 'plain_text', text: 'https://origin.example' },
    { name: 'DB', type: 'd1', id: 'db-1' },
    { name: 'SECRET_KEY', type: 'secret_text' }
  ],
  modules: [
    { name: './index.js', content_type: 'application/javascript+module', content_base64: b64('export default { fetch() {} }') },
    { name: 'page.html', content_type: 'text/plain', content_base64: b64('<p>hi</p>') }
  ],
  ...overrides
});

test('an identical upload passes, with module names normalized', () => {
  const next = version({ modules: version().modules.map((m) => ({ ...m, name: m.name.replace('./', '') })) });
  const r = compareVersions(version(), next);
  assert.equal(r.same, true);
});

test('a changed module, binding or flag fails and names what changed', () => {
  const changed = version({ modules: [version().modules[0], { ...version().modules[1], content_base64: b64('<p>bye</p>') }] });
  const r = compareVersions(version(), changed);
  assert.equal(r.same, false);
  assert.deepEqual(r.results.filter((x) => !x.same).map((x) => x.check), ['modules']);
  assert.equal(compareVersions(version(), version({ compatibility_flags: [] })).results.find((x) => x.check === 'compatibility_flags').same, false);
  const rebound = version({ bindings: version().bindings.map((b) => (b.name === 'DB' ? { ...b, id: 'db-2' } : b)) });
  assert.equal(compareVersions(version(), rebound).same, false);
});

test('an allowed plain-text binding may differ; a secret is compared by name and type only', () => {
  const moved = version({ bindings: version().bindings.map((b) => (b.name === 'API_ORIGIN' ? { ...b, text: 'https://new-origin.example' } : b)) });
  assert.equal(compareVersions(version(), moved).same, false);
  const r = compareVersions(version(), moved, { allow: ['API_ORIGIN'] });
  assert.equal(r.same, true);
  assert.deepEqual(r.allowedChanges, [{ name: 'API_ORIGIN', base: 'https://origin.example', next: 'https://new-origin.example' }]);
  const noSecret = version({ bindings: version().bindings.filter((b) => b.name !== 'SECRET_KEY') });
  assert.equal(compareVersions(version(), noSecret).same, false, 'a dropped secret is a difference');
});

test('_headers and _redirects are listed as static configuration, not code', () => {
  const withHeaders = version({ modules: [...version().modules, { name: '_headers', content_type: 'text/plain', content_base64: b64('/*\n  X-Frame-Options: DENY\n') }] });
  const r = compareVersions(version(), withHeaders);
  assert.equal(r.same, true);
  assert.match(Object.keys(r.staticConfig)[0], /^_headers$/);
});

test('the base defaults to the version serving all traffic; a split deployment needs an explicit base', async () => {
  const api = (deployments, versions) => async (url) => {
    const body = url.includes('/deployments') ? { success: true, result: { deployments } } : { success: true, result: versions[url.split('/versions/')[1].split('?')[0]] };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const fetcher = api([{ versions: [{ version_id: 'live-1', percentage: 100 }] }], { 'live-1': version(), 'new-2': version() });
  const r = await verifyVersion({ worker: 'w', next: 'new-2', account: 'a', token: 't', fetcher });
  assert.equal(r.base, 'live-1');
  assert.equal(r.same, true);
  const split = api([{ versions: [{ version_id: 'a', percentage: 90 }, { version_id: 'b', percentage: 10 }] }], {});
  await assert.rejects(liveVersion('w', { account: 'a', token: 't', fetcher: split }), /not on a single version \(a@90%, b@10%\)/);
});
