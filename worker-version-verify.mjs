#!/usr/bin/env node
// worker-version-verify — prove the Cloudflare Worker version you are about to deploy is the one you meant to build.
//
// Compares an uploaded (not yet deployed) Worker version with a base version, by default the one serving traffic now:
// every module byte for byte (SHA-256 and content type), bindings (plain-text values; secrets by name and type),
// compatibility date and flags, usage model and static-asset routing. `_headers` and `_redirects` travel with the code
// as asset configuration and are listed on their own. Zero dependencies.
//
// Usage: worker-version-verify <worker> <new-version-id> [base-version-id|live] [--allow NAME[,NAME]] [--json]
// Env:   CLOUDFLARE_API_TOKEN (Workers Scripts: Read), CLOUDFLARE_ACCOUNT_ID
// Exit:  0 same except static files and allowed bindings, 1 different, 2 usage or API error
import { createHash } from 'node:crypto';

const API = 'https://api.cloudflare.com/client/v4';
const STATIC_CONFIG = new Set(['_headers', '_redirects']);

export async function cloudflare(path, { token, fetcher = fetch } = {}) {
  const response = await fetcher(API + path, { headers: { authorization: `Bearer ${token}` } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) throw new Error(`Cloudflare API ${response.status} for ${path}: ${(body.errors || []).map((e) => e.message).join('; ') || 'no detail'}`);
  return body.result;
}

// The version serving 100% of traffic, or an error naming the split when a gradual deployment is in progress.
export async function liveVersion(worker, { account, token, fetcher }) {
  const result = await cloudflare(`/accounts/${account}/workers/scripts/${worker}/deployments`, { token, fetcher });
  const versions = result?.deployments?.[0]?.versions || [];
  if (versions.length !== 1) throw new Error(`${worker} is not on a single version (${versions.map((v) => `${v.version_id}@${v.percentage}%`).join(', ') || 'no deployment'}); name the base version`);
  return versions[0].version_id;
}

const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const moduleName = (name) => name.replace(/^\.\//, '');
const hashes = (version, keep) => Object.fromEntries((version.modules || [])
  .map((m) => [moduleName(m.name), `${m.content_type} ${createHash('sha256').update(Buffer.from(m.content_base64, 'base64')).digest('hex')}`])
  .filter(([name]) => keep(name)));

export function compareVersions(base, next, { allow = [] } = {}) {
  const allowed = new Set(allow);
  const bindings = (v) => [...(v.bindings || [])]
    .map((b) => (allowed.has(b.name) && b.type === 'plain_text' ? { ...b, text: '(allowed to differ)' } : b))
    .sort((a, b) => a.name.localeCompare(b.name));
  const checks = {
    main_module: (v) => v.main_module,
    compatibility_date: (v) => v.compatibility_date,
    compatibility_flags: (v) => v.compatibility_flags || [],
    usage_model: (v) => v.usage_model,
    bindings,
    modules: (v) => hashes(v, (n) => !STATIC_CONFIG.has(n)),
    assets_config: (v) => v.assets?.config || null
  };
  const results = Object.entries(checks).map(([name, read]) => {
    const a = JSON.stringify(canon(read(base))), b = JSON.stringify(canon(read(next)));
    return { check: name, same: a === b, ...(a === b ? {} : { base: JSON.parse(a), next: JSON.parse(b) }) };
  });
  const allowedChanges = [...allowed].map((name) => ({ name, base: base.bindings?.find((b) => b.name === name)?.text ?? null, next: next.bindings?.find((b) => b.name === name)?.text ?? null }));
  return { same: results.every((r) => r.same), results, allowedChanges, staticConfig: hashes(next, (n) => STATIC_CONFIG.has(n)) };
}

export async function verifyVersion({ worker, next, base = 'live', allow = [], account, token, fetcher }) {
  const baseId = base === 'live' ? await liveVersion(worker, { account, token, fetcher }) : base;
  const get = (id) => cloudflare(`/accounts/${account}/workers/workers/${worker}/versions/${id}?include=modules`, { token, fetcher });
  const [a, b] = await Promise.all([get(baseId), get(next)]);
  return { worker, base: baseId, next, ...compareVersions(a, b, { allow }) };
}

function report(r) {
  const lines = r.results.map((x) => (x.same ? `SAME ${x.check}` : `DIFFERENT ${x.check}\n  base ${JSON.stringify(x.base).slice(0, 2000)}\n  new  ${JSON.stringify(x.next).slice(0, 2000)}`));
  for (const c of r.allowedChanges) lines.push(`ALLOWED ${c.name}: ${c.base} -> ${c.next}`);
  if (Object.keys(r.staticConfig).length) lines.push(`STATIC ${JSON.stringify(r.staticConfig)}`);
  lines.push(r.same ? `${r.next} matches ${r.base} except its static files` : `${r.next} differs from ${r.base}: do not deploy`);
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2), json = args.includes('--json');
  const at = args.indexOf('--allow'), allow = at >= 0 ? (args[at + 1] || '').split(',').filter(Boolean) : [];
  const [worker, next, base = 'live'] = args.filter((a, i) => a !== '--json' && i !== at && i !== at + 1);
  const token = process.env.CLOUDFLARE_API_TOKEN, account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!worker || !next || !token || !account) {
    console.error('usage: worker-version-verify <worker> <new-version-id> [base-version-id|live] [--allow NAME[,NAME]] [--json]\nenv: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID');
    process.exit(2);
  }
  try {
    const r = await verifyVersion({ worker, next, base, allow, account, token });
    console.log(json ? JSON.stringify(r, null, 2) : report(r));
    process.exit(r.same ? 0 : 1);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}
