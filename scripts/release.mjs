#!/usr/bin/env node
// Release steps for .github/workflows/deploy.yml, using Cloudflare Worker versions and deployments.
//   node scripts/release.mjs deploy   --target test|production [--percentage 1-100] [--tag T] [--message M] [--dry-run]
//   node scripts/release.mjs rollback --target test|production [--version <uuid>] [--message M] [--dry-run]
// Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment. Never prints either.
// deploy = upload a new version (`cf workers versions create`, which builds the project), check that it
// still has the Worker secrets, then point traffic at it (100%, or a gradual split with the current version).
// rollback = point 100% of traffic at an older version (the previous deployment's main version by default).
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import site from '../site.config.js';

export const SCRIPTS = { production: site.workers.production, test: site.workers.test };
export const REQUIRED_SECRETS = ['AUTH_SECRET', 'INTERNAL_SECRET'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseArgs(argv) {
  const [command, ...rest] = argv, opts = { command };
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i];
    if (k === '--dry-run') opts.dryRun = true;
    else if (/^--(target|percentage|tag|message|version)$/.test(k) && i + 1 < rest.length) opts[k.slice(2)] = rest[++i];
    else throw new Error('Unknown argument: ' + k);
  }
  if (!['deploy', 'rollback'].includes(command)) throw new Error('Command must be deploy or rollback');
  if (!Object.hasOwn(SCRIPTS, opts.target)) throw new Error('--target must be test or production');
  opts.percentage = opts.percentage === undefined || opts.percentage === '' ? 100 : Number(opts.percentage);
  if (!Number.isInteger(opts.percentage) || opts.percentage < 1 || opts.percentage > 100) throw new Error('--percentage must be an integer from 1 to 100');
  if (opts.target === 'test' && opts.percentage !== 100) throw new Error('Gradual deployments are for production only');
  if (opts.version && !UUID.test(opts.version)) throw new Error('--version must be a Worker version UUID');
  opts.tag = String(opts.tag || '').slice(0, 25);
  opts.message = String(opts.message || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 100);
  return opts;
}

// The main version of a deployment is the one carrying the most traffic.
export const mainVersion = (deployment) => [...(deployment?.versions || [])].sort((a, b) => b.percentage - a.percentage)[0]?.version_id || null;
const newestFirst = (list) => [...list].sort((a, b) => String(b.created_on).localeCompare(String(a.created_on)));

export function findVersionByTag(versions, tag) {
  return newestFirst((versions || []).map((v) => ({ ...v, created_on: v.metadata?.created_on }))).find((v) => v.annotations?.['workers/tag'] === tag)?.id || null;
}

export function planDeploy(deployments, newVersion, percentage) {
  const current = mainVersion(newestFirst(deployments || [])[0]);
  if (percentage === 100 || !current || current === newVersion) return { previous: current, versions: [{ version_id: newVersion, percentage: 100 }] };
  return { previous: current, versions: [{ version_id: newVersion, percentage }, { version_id: current, percentage: 100 - percentage }] };
}

export function planRollback(deployments, requested) {
  const list = newestFirst(deployments || []), current = mainVersion(list[0]);
  if (requested) return { previous: current, target: requested };
  const target = list.slice(1).map(mainVersion).find((id) => id && id !== current) || null;
  return { previous: current, target };
}

export function missingSecrets(versionDetail) {
  const names = new Set((versionDetail?.resources?.bindings || []).map((b) => b.name));
  return REQUIRED_SECRETS.filter((n) => !names.has(n));
}

export function api(env, fetchImpl = fetch) {
  const account = env.CLOUDFLARE_ACCOUNT_ID, token = env.CLOUDFLARE_API_TOKEN;
  if (!token || !/^[a-f0-9]{32}$/.test(account || '')) throw new Error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required');
  return async (path, init = {}) => {
    const r = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${path}`, { ...init, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } });
    const data = await r.json().catch(() => null);
    if (!r.ok || data?.success === false) throw new Error(`Cloudflare API ${r.status} on ${path.split('?')[0]}: ${(data?.errors || []).map((e) => e.message).join('; ') || 'request failed'}`);
    return data.result;
  };
}

function uploadVersion(opts) {
  const args = ['cf', 'workers', 'versions', 'create', ...(opts.target === 'test' ? ['--mode', 'test'] : []), '--tag', opts.tag, '--message', opts.message || 'deploy ' + opts.tag];
  const r = spawnSync('npx', args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error('cf workers versions create failed (exit ' + r.status + ')');
}

function summary(lines) {
  console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
}

export async function run(opts, env = process.env, deps = {}) {
  const call = api(env, deps.fetch), script = SCRIPTS[opts.target], log = deps.summary || summary;
  const deployments = async () => (await call(script + '/deployments')).deployments || [];
  const deployTo = (versions, message) => call(script + '/deployments', { method: 'POST', body: JSON.stringify({ strategy: 'percentage', versions, annotations: { 'workers/message': message || opts.message || opts.command } }) });
  if (opts.command === 'rollback') {
    const plan = planRollback(await deployments(), opts.version);
    if (!plan.target) throw new Error('No earlier version to roll back to; pass --version');
    if (!opts.dryRun) await deployTo([{ version_id: plan.target, percentage: 100 }], opts.message || 'rollback');
    log([`### Rollback ${opts.target}${opts.dryRun ? ' (dry run)' : ''}`, `- Worker: ${script}`, `- From: ${plan.previous || 'none'}`, `- To: ${plan.target} (100%)`]);
    return plan;
  }
  if (!opts.tag) throw new Error('--tag is required for deploy');
  if (!opts.dryRun) (deps.upload || uploadVersion)(opts);
  const versions = (await call(script + '/versions')).items || [];
  const versionId = findVersionByTag(versions, opts.tag);
  if (!versionId) throw new Error(opts.dryRun ? 'Dry run: no uploaded version is tagged ' + opts.tag : 'Uploaded version with tag ' + opts.tag + ' not found');
  const missing = missingSecrets(await call(script + '/versions/' + versionId));
  if (missing.length) throw new Error('New version is missing secrets ' + missing.join(', ') + '; set them with cf deploy --secrets-file first. Traffic was not moved.');
  const plan = planDeploy(await deployments(), versionId, opts.percentage);
  if (!opts.dryRun) await deployTo(plan.versions);
  log([`### Deploy ${opts.target}${opts.dryRun ? ' (dry run)' : ''}`, `- Worker: ${script}`, `- Tag: ${opts.tag}`, `- New version: ${versionId}`, `- Previous version: ${plan.previous || 'none'}`, `- Traffic: ${plan.versions.map((v) => v.version_id + ' ' + v.percentage + '%').join(', ')}`, `- Roll back with: operation=rollback target=${opts.target}`]);
  return { versionId, ...plan };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { await run(parseArgs(process.argv.slice(2))); }
  catch (error) { console.error('release: ' + error.message); process.exit(1); }
}
