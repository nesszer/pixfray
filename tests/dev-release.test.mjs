// Deploy flow: scripts/release.mjs logic against a fake Cloudflare API, and the workflow YAML files.
// The YAML check uses Python's PyYAML (no YAML parser is installed in node_modules); it skips if absent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs, planDeploy, planRollback, findVersionByTag, missingSecrets, mainVersion, run } from '../scripts/release.mjs';

const V = (n) => `0000000${n}-0000-4000-8000-000000000000`;
const ENV = { CLOUDFLARE_API_TOKEN: 'test-only-cf', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32) };
const deployments = [
  { id: 'd1', created_on: '2026-09-29T00:00:00Z', versions: [{ version_id: V(1), percentage: 100 }] },
  { id: 'd3', created_on: '2026-10-01T00:00:00Z', versions: [{ version_id: V(3), percentage: 90 }, { version_id: V(2), percentage: 10 }] },
  { id: 'd2', created_on: '2026-09-30T00:00:00Z', versions: [{ version_id: V(2), percentage: 100 }] },
];

test('release arguments are validated', () => {
  assert.deepEqual(parseArgs(['deploy', '--target', 'test', '--tag', 'gh-1']), { command: 'deploy', target: 'test', tag: 'gh-1', percentage: 100, message: '' });
  assert.equal(parseArgs(['deploy', '--target', 'production', '--percentage', '25']).percentage, 25);
  assert.equal(parseArgs(['deploy', '--target', 'production', '--tag', 'x'.repeat(40)]).tag.length, 25);
  for (const argv of [[], ['ship', '--target', 'test'], ['deploy'], ['deploy', '--target', 'staging'], ['deploy', '--target', 'test', '--percentage', '50'],
    ['deploy', '--target', 'production', '--percentage', '0'], ['deploy', '--target', 'production', '--percentage', '1.5'], ['rollback', '--target', 'test', '--version', 'v1'], ['deploy', '--target', 'test', '--force']])
    assert.throws(() => parseArgs(argv), undefined, argv.join(' '));
});

test('deploy and rollback plans pick the right versions', () => {
  assert.equal(mainVersion(deployments[1]), V(3));
  assert.deepEqual(planDeploy(deployments, V(4), 100), { previous: V(3), versions: [{ version_id: V(4), percentage: 100 }] });
  assert.deepEqual(planDeploy(deployments, V(4), 10), { previous: V(3), versions: [{ version_id: V(4), percentage: 10 }, { version_id: V(3), percentage: 90 }] });
  assert.deepEqual(planDeploy([], V(4), 10).versions, [{ version_id: V(4), percentage: 100 }]);
  assert.deepEqual(planRollback(deployments), { previous: V(3), target: V(2) });
  assert.deepEqual(planRollback(deployments, V(1)), { previous: V(3), target: V(1) });
  assert.equal(planRollback([deployments[0]]).target, null);
  assert.equal(findVersionByTag([{ id: V(5), metadata: { created_on: '1' }, annotations: { 'workers/tag': 'gh-a' } }, { id: V(6), metadata: { created_on: '2' }, annotations: { 'workers/tag': 'gh-a' } }], 'gh-a'), V(6));
  assert.equal(findVersionByTag([], 'gh-a'), null);
  assert.deepEqual(missingSecrets({ resources: { bindings: [{ name: 'AUTH_SECRET', type: 'secret_text' }] } }), ['INTERNAL_SECRET']);
});

function fakeCloudflare(versionBindings = [{ name: 'AUTH_SECRET' }, { name: 'INTERNAL_SECRET' }]) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url), method = init.method || 'GET';
    calls.push({ path: u.pathname, method, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers.Authorization });
    const ok = (result) => new Response(JSON.stringify({ success: true, result }));
    if (u.pathname.endsWith('/deployments') && method === 'GET') return ok({ deployments });
    if (u.pathname.endsWith('/deployments') && method === 'POST') return ok({ id: 'new' });
    if (u.pathname.endsWith('/versions')) return ok({ items: [{ id: V(7), metadata: { created_on: '2026-10-01T01:00:00Z' }, annotations: { 'workers/tag': 'gh-abc1234-99' } }] });
    if (u.pathname.endsWith('/versions/' + V(7))) return ok({ resources: { bindings: versionBindings } });
    return new Response(JSON.stringify({ success: false, errors: [{ message: 'not found' }] }), { status: 404 });
  };
  return { calls, fetch };
}

test('deploy uploads, verifies secrets, then moves traffic on the right Worker', async () => {
  const cf = fakeCloudflare(), uploads = [], logs = [];
  const result = await run(parseArgs(['deploy', '--target', 'production', '--percentage', '20', '--tag', 'gh-abc1234-99', '--message', 'promote #7']), ENV, { fetch: cf.fetch, upload: (o) => uploads.push(o), summary: (l) => logs.push(...l) });
  assert.equal(uploads.length, 1);
  assert.equal(result.versionId, V(7));
  const post = cf.calls.find((c) => c.method === 'POST');
  assert.equal(post.path, `/client/v4/accounts/${'a'.repeat(32)}/workers/scripts/nesszerra-mini-chat/deployments`);
  assert.deepEqual(post.body, { strategy: 'percentage', versions: [{ version_id: V(7), percentage: 20 }, { version_id: V(3), percentage: 80 }], annotations: { 'workers/message': 'promote #7' } });
  assert.ok(cf.calls.every((c) => c.auth === 'Bearer test-only-cf'));
  assert.ok(logs.some((l) => l.includes(V(7))));
  assert.ok(!logs.join('\n').includes('test-only-cf'));
});

test('deploy refuses to move traffic to a version without the Worker secrets', async () => {
  const cf = fakeCloudflare([{ name: 'AUTH_SECRET' }]);
  await assert.rejects(run(parseArgs(['deploy', '--target', 'test', '--tag', 'gh-abc1234-99']), ENV, { fetch: cf.fetch, upload() {}, summary() {} }), /missing secrets INTERNAL_SECRET/);
  assert.ok(!cf.calls.some((c) => c.method === 'POST'));
  assert.ok(cf.calls.every((c) => c.path.includes('/nesszerra-mini-chat-test/')));
});

test('rollback points all traffic at the previous version; dry run changes nothing', async () => {
  const cf = fakeCloudflare();
  const plan = await run(parseArgs(['rollback', '--target', 'production', '--message', 'bad deploy']), ENV, { fetch: cf.fetch, summary() {} });
  assert.equal(plan.target, V(2));
  assert.deepEqual(cf.calls.at(-1).body.versions, [{ version_id: V(2), percentage: 100 }]);
  const dry = fakeCloudflare();
  await run(parseArgs(['rollback', '--target', 'test', '--dry-run']), ENV, { fetch: dry.fetch, summary() {} });
  assert.ok(!dry.calls.some((c) => c.method === 'POST'));
  await assert.rejects(run(parseArgs(['rollback', '--target', 'test']), {}, { fetch: dry.fetch }), /CLOUDFLARE_API_TOKEN/);
});

function loadYaml(t, file) {
  const py = spawnSync('python', ['-c', 'import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1], encoding="utf-8"))))', file], { encoding: 'utf8' });
  if (py.error || py.status !== 0) {
    if (/No module named|ENOENT|not found/i.test(String(py.error?.message || '') + py.stderr)) { t.skip('python with PyYAML is not available'); return null; }
    assert.fail('YAML did not parse: ' + py.stderr);
  }
  return JSON.parse(py.stdout);
}

test('deploy workflow parses and exposes the inputs /api/dev dispatches', (t) => {
  const wf = loadYaml(t, '.github/workflows/deploy.yml');
  if (!wf) return;
  const on = wf.on ?? wf[true]; // YAML 1.1 reads a bare `on` key as boolean true
  const inputs = on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs).sort(), ['hotfix', 'operation', 'percentage', 'reason', 'request_id', 'sha', 'target', 'version_id']);
  assert.deepEqual(inputs.operation.options, ['deploy', 'rollback']);
  assert.deepEqual(inputs.target.options, ['test', 'production']);
  assert.deepEqual(Object.keys(wf.jobs).sort(), ['deploy', 'rollback']);
  assert.deepEqual(wf.permissions, { contents: 'read' });
  assert.match(wf['run-name'], /inputs\.request_id/);
  for (const job of Object.values(wf.jobs)) for (const step of job.steps) {
    // Untrusted inputs must reach shell only through env.
    if (step.run) assert.doesNotMatch(step.run, /\$\{\{/, step.name || step.run);
  }
  const src = readFileSync('.github/workflows/deploy.yml', 'utf8');
  assert.match(src, /node scripts\/release\.mjs deploy/);
  assert.match(src, /node scripts\/release\.mjs rollback/);
});

test('CI workflow parses and never sees secrets', (t) => {
  const wf = loadYaml(t, '.github/workflows/ci.yml');
  if (!wf) return;
  assert.ok(wf.jobs.test.steps.some((s) => s.run === 'npm run test:unit'));
  assert.doesNotMatch(readFileSync('.github/workflows/ci.yml', 'utf8'), /secrets\./);
});
