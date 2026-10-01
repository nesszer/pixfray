import { chatStatus } from './game.js';
// Live-fix space (/api/dev/*). Owned by Lane E. worker.js and channel.js only call the exports below;
// keep the signatures (see CONTRACTS.md, "Lane modules"). Every route is owner-only (isOwner = the
// nesszerra Twitch account). Optional integrations degrade to 501 {reason:"*_not_configured"}:
//   GitHub (code editor + deploy flow): secret GITHUB_TOKEN, text GITHUB_REPO ("owner/name"),
//     optional GITHUB_BASE_BRANCH (main) and GITHUB_WORKFLOW (deploy.yml).
//   Cloudflare read-only API (request usage, versions): secret CF_API_TOKEN, text CF_ACCOUNT_ID.
//   Current version: version_metadata binding CF_VERSION_METADATA.
// The Worker never holds a token that can deploy; deploys run in GitHub Actions (docs/LIVE_FIX.md).
const MAX_LOG_ROWS = 500;
const VERSION = '0.2.0';
const DAILY_REQUEST_LIMIT = 100000;
const SCRIPTS = { production: 'nesszerra-mini-chat', test: 'nesszerra-mini-chat-test' };
const MAX_FILE_BYTES = 512 * 1024;
const BRANCH = /^(live-fix|hotfix)\/[a-z0-9][a-z0-9._-]{0,60}$/;
const SHA = /^[a-f0-9]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
// Paths the web editor may never read or write: local secrets, generated output, CI definitions.
const DENIED_PATH = /(^|\/)(\.dev\.vars[^/]*|\.secrets[^/]*|\.env[^/]*|node_modules|\.git|\.wrangler|\.cloudflare|dist)(\/|$)|^\.github\/|\.dpapi$/i;
const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const fail = (status, error, reason, extra = {}) => json({ error, reason, ...extra }, status);

// ---------- Worker side ----------
// c = { user, owner, dev (test-site dev token: no Origin check), url, path, roomFetch(channel, path, init?), chatAction(channel, action, { takeover? }), bodyJson(request, limit), waitUntil(promise) }
export async function handleDeveloper(request, env, c) {
  if (!c.user) return fail(401, 'Sign in with Twitch', 'sign_in_required');
  if (!c.owner) return fail(403, 'Owner only', 'owner_only');
  const method = request.method, op = c.path.slice('/api/dev/'.length).replace(/\/+$/, '');
  if (!c.dev && !['GET', 'HEAD'].includes(method) && request.headers.get('Origin') !== c.url.origin) return fail(403, 'Same-origin request required', 'cross_origin');
  const route = ROUTES[op];
  if (!route) return fail(404, 'Unknown developer route', 'unknown_route', { op });
  const handler = route[method === 'HEAD' ? 'GET' : method];
  if (!handler) return fail(405, 'Use ' + Object.keys(route).join(' or '), 'method_not_allowed', { op });
  let body = null;
  // Caught here because worker.js returns this promise without awaiting it inside its try block.
  if (method === 'POST') try { body = await c.bodyJson(request, op === 'code/save' ? MAX_FILE_BYTES * 2 + 4096 : 8000); } catch (e) { return fail(e.status || 400, e.message || 'Invalid request body', e.status === 413 ? 'body_too_large' : 'invalid_body'); }
  try { return await handler({ request, env, c, body, query: c.url.searchParams, room: (path, init) => c.roomFetch('nesszerra', path, init) }); }
  catch (error) { c.waitUntil?.(logWorkerError(env, error, { path: c.path })); return fail(503, 'Service unavailable; check owner diagnostics', 'upstream_error'); }
}

const ROUTES = {
  diagnostics: { GET: diagnostics },
  logs: { GET: ({ room, query }) => room('/dev/logs?' + logQuery(query)), DELETE: ({ room }) => room('/dev/logs', { method: 'DELETE' }) },
  settings: { GET: ({ room }) => room('/admin'), POST: settings },
  codex: { GET: ({ room }) => room('/dev/codex'), POST: codex },
  usage: { GET: async ({ env }) => json(await usage(env)) },
  versions: { GET: versions },
  'code/tree': { GET: withGithub(codeTree) },
  'code/file': { GET: withGithub(codeFile) },
  'code/save': { POST: withGithub(codeSave) },
  'code/pr': { POST: withGithub(codePr) },
  runs: { GET: withGithub(runs) },
  deploy: { POST: withGithub(deployTest) },
  promote: { POST: withGithub(promote) },
  hotfix: { POST: withGithub(hotfix) },
  rollback: { POST: withGithub(rollback) },
};

async function diagnostics({ env, room }) {
  const [r, codexRes, use] = await Promise.all([room('/dev/diagnostics'), room('/dev/codex'), usage(env)]);
  const meta = env.CF_VERSION_METADATA;
  return json({
    worker: { version: VERSION, twitchConfigured: !!(env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET), productionEnabled: false,
      deployedVersion: meta?.id ? { id: meta.id, tag: meta.tag || '', timestamp: meta.timestamp || '' } : null },
    room: r.ok ? await r.json() : { error: 'Room unavailable', status: r.status },
    integrations: { github: githubPublic(env), cloudflare: cloudflarePublic(env) },
    usage: use,
    codex: codexRes.ok ? await codexRes.json() : { authorized: false },
  });
}

function logQuery(query) {
  const out = new URLSearchParams(), source = query.get('source'), limit = Number(query.get('limit'));
  if (source === 'room' || source === 'worker') out.set('source', source);
  if (Number.isInteger(limit) && limit >= 1 && limit <= 100) out.set('limit', String(limit));
  return out.toString();
}

// Live settings editor: a thin passthrough to the room's versioned config (CONTRACTS.md section 7),
// plus the chat source lifecycle (connectChat / disconnectChat, handled by the Worker's EventSub helpers).
async function settings({ body, c, room }) {
  const action = body.action;
  if (action === 'connectChat' || action === 'disconnectChat') {
    try { return await c.chatAction('nesszerra', action, { takeover: body.takeover === true }); }
    catch (e) { if (e.status) return fail(e.status, e.message, 'chat_error', { ...(e.reconnect ? { reconnect: e.reconnect } : {}), ...(e.connectedElsewhere ? { connectedElsewhere: e.connectedElsewhere } : {}) }); throw e; }
  }
  if (action !== 'config' && action !== 'rollbackConfig') return fail(400, 'action must be config, rollbackConfig, connectChat or disconnectChat', 'invalid_action');
  const payload = body.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return fail(400, 'payload object required', 'invalid_payload');
  return room('/admin', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mini-User-Id': c.user.id }, body: JSON.stringify({ action, payload, actorId: c.user.id, actorName: c.user.displayName || c.user.login }) });
}

// Codex assistance is off until the owner turns it on. This only records the decision; no model is called.
async function codex({ body, c, room }) {
  if (typeof body.authorized !== 'boolean') return fail(400, 'authorized must be true or false', 'invalid_authorized');
  if (body.note !== undefined && typeof body.note !== 'string') return fail(400, 'note must be a string', 'invalid_note');
  return room('/dev/codex', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ authorized: body.authorized, note: clean(body.note || '', 200), by: c.user.login }) });
}

// ---------- Cloudflare (read-only) ----------
function cloudflarePublic(env) {
  const missing = [!env.CF_API_TOKEN && 'CF_API_TOKEN', !(env.CF_ACCOUNT_ID && /^[a-f0-9]{32}$/.test(env.CF_ACCOUNT_ID)) && 'CF_ACCOUNT_ID'].filter(Boolean);
  return { configured: !missing.length, missing, versionMetadata: !!env.CF_VERSION_METADATA };
}
async function cf(env, path, init = {}) {
  const r = await fetch('https://api.cloudflare.com/client/v4' + path, { ...init, headers: { Authorization: 'Bearer ' + env.CF_API_TOKEN, 'Content-Type': 'application/json' } });
  const data = await r.json().catch(() => null);
  return { ok: r.ok && data?.success !== false && !data?.errors?.length, status: r.status, data };
}

// Today's Worker requests (UTC day, account-wide, which is how the Free limit counts) from the GraphQL Analytics API.
export async function usage(env, now = Date.now()) {
  const day = new Date(now), since = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  const base = { limit: DAILY_REQUEST_LIMIT, since: since.toISOString(), resetsAt: new Date(since.getTime() + 86400000).toISOString() };
  if (!cloudflarePublic(env).configured) return { ...base, configured: false, reason: 'cloudflare_not_configured', error: 'Set CF_API_TOKEN and CF_ACCOUNT_ID to read request usage' };
  const query = 'query($a:String!,$s:Time!,$u:Time!){viewer{accounts(filter:{accountTag:$a}){workersInvocationsAdaptive(limit:100,filter:{datetime_geq:$s,datetime_leq:$u}){sum{requests errors subrequests} dimensions{scriptName}}}}}';
  try {
    const r = await cf(env, '/graphql', { method: 'POST', body: JSON.stringify({ query, variables: { a: env.CF_ACCOUNT_ID, s: since.toISOString(), u: new Date(now).toISOString() } }) });
    const rows = r.data?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive;
    if (!r.ok || !Array.isArray(rows)) return { ...base, configured: true, error: 'Analytics query failed', status: r.status };
    const scripts = {};
    for (const row of rows) {
      const s = scripts[row.dimensions?.scriptName || 'unknown'] ||= { requests: 0, errors: 0, subrequests: 0 };
      s.requests += row.sum?.requests || 0; s.errors += row.sum?.errors || 0; s.subrequests += row.sum?.subrequests || 0;
    }
    const requests = Object.values(scripts).reduce((n, s) => n + s.requests, 0);
    return { ...base, configured: true, requests, percent: Math.round(requests / DAILY_REQUEST_LIMIT * 1000) / 10, scripts };
  } catch { return { ...base, configured: true, error: 'Analytics unavailable' }; }
}

async function versions({ env }) {
  const conf = cloudflarePublic(env);
  if (!conf.configured) return fail(501, 'Cloudflare API is not configured: set CF_API_TOKEN and CF_ACCOUNT_ID', 'cloudflare_not_configured', { missing: conf.missing });
  const out = {};
  for (const [target, script] of Object.entries(SCRIPTS)) {
    const base = `/accounts/${env.CF_ACCOUNT_ID}/workers/scripts/${script}`;
    const [d, v] = await Promise.all([cf(env, base + '/deployments'), cf(env, base + '/versions')]);
    out[target] = {
      script,
      deployments: d.ok ? (d.data.result?.deployments || []).slice(0, 5).map((x) => ({ id: x.id, createdOn: x.created_on, source: x.source, message: x.annotations?.['workers/message'] || '', versions: (x.versions || []).map((y) => ({ versionId: y.version_id, percentage: y.percentage })) })) : [],
      versions: v.ok ? (v.data.result?.items || []).slice(0, 10).map((x) => ({ id: x.id, number: x.number, createdOn: x.metadata?.created_on, tag: x.annotations?.['workers/tag'] || '', message: x.annotations?.['workers/message'] || '' })) : [],
      error: d.ok && v.ok ? undefined : 'Cloudflare API error ' + (d.ok ? v.status : d.status),
    };
  }
  return json(out);
}

// ---------- GitHub ----------
function githubConfig(env) {
  const repo = String(env.GITHUB_REPO || ''), base = String(env.GITHUB_BASE_BRANCH || 'main'), workflow = String(env.GITHUB_WORKFLOW || 'deploy.yml');
  const missing = [!env.GITHUB_TOKEN && 'GITHUB_TOKEN', !REPO.test(repo) && 'GITHUB_REPO'].filter(Boolean);
  return { configured: !missing.length, missing, repo, base, workflow };
}
function githubPublic(env) { const { configured, missing, repo, base, workflow } = githubConfig(env); return { configured, missing, repo: configured ? repo : '', base, workflow }; }
function withGithub(fn) {
  return (ctx) => {
    const g = githubConfig(ctx.env);
    if (!g.configured) return fail(501, 'GitHub is not configured: set the GITHUB_TOKEN secret and GITHUB_REPO (see docs/LIVE_FIX.md)', 'github_not_configured', { missing: g.missing });
    return fn({ ...ctx, g, gh: (path, init) => gh(ctx.env, g, path, init) });
  };
}
async function gh(env, g, path, init = {}) {
  const r = await fetch('https://api.github.com/repos/' + g.repo + path, { ...init, headers: { Authorization: 'Bearer ' + env.GITHUB_TOKEN, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'nesszerra-mini-chat', ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
  const data = r.status === 204 ? null : await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, data };
}
function ghError(r, what) {
  const status = [404, 409, 422].includes(r.status) ? (r.status === 422 ? 409 : r.status) : 502;
  return fail(status, `${what}: GitHub ${r.status} ${clean(r.data?.message || '', 200)}`.trim(), 'github_error', { githubStatus: r.status });
}
const enc = (path) => path.split('/').map(encodeURIComponent).join('/');

export function validPath(path) {
  if (typeof path !== 'string' || path.length < 1 || path.length > 200 || !/^[A-Za-z0-9._\-/]+$/.test(path)) return false;
  if (path.split('/').some((s) => !s || s === '.' || s === '..')) return false;
  return !DENIED_PATH.test(path);
}
const validRef = (ref, base) => ref === base || BRANCH.test(ref);

async function codeTree({ g, gh, query }) {
  const ref = query.get('ref') || g.base;
  if (!validRef(ref, g.base)) return fail(400, 'ref must be the base branch, live-fix/* or hotfix/*', 'invalid_ref');
  const r = await gh('/git/trees/' + enc(ref) + '?recursive=1');
  if (!r.ok) return ghError(r, 'Read tree');
  const files = (r.data.tree || []).filter((x) => x.type === 'blob' && validPath(x.path)).slice(0, 2000).map((x) => ({ path: x.path, size: x.size }));
  return json({ ref, files, truncated: !!r.data.truncated });
}

// Reads from `branch` when it exists, otherwise from the base branch, so a new edit starts from main.
async function codeFile({ g, gh, query }) {
  const path = query.get('path'), branch = query.get('branch') || '';
  if (!validPath(path)) return fail(400, 'Invalid or protected path', 'invalid_path');
  if (branch && !validRef(branch, g.base)) return fail(400, 'branch must be live-fix/* or hotfix/*', 'invalid_branch');
  let ref = branch || g.base, r = await gh('/contents/' + enc(path) + '?ref=' + encodeURIComponent(ref));
  if (r.status === 404 && branch && branch !== g.base && !(await gh('/git/ref/heads/' + enc(branch))).ok) {
    ref = g.base; r = await gh('/contents/' + enc(path) + '?ref=' + encodeURIComponent(ref));
  }
  if (!r.ok) return ghError(r, 'Read file');
  if (Array.isArray(r.data) || r.data?.type !== 'file') return fail(400, 'Path is not a file', 'not_a_file');
  if (r.data.size > MAX_FILE_BYTES || r.data.encoding !== 'base64') return fail(413, 'File is too large for the web editor (512 KB max)', 'file_too_large');
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(fromBase64(r.data.content)); } catch { return fail(415, 'Binary files cannot be edited here', 'binary_file'); }
  return json({ path, ref, sha: r.data.sha, size: r.data.size, content });
}

async function ensureBranch(g, gh, branch) {
  const existing = await gh('/git/ref/heads/' + enc(branch));
  if (existing.ok) return { ok: true, created: false };
  if (existing.status !== 404) return { ok: false, response: ghError(existing, 'Read branch') };
  const base = await gh('/git/ref/heads/' + enc(g.base));
  if (!base.ok) return { ok: false, response: ghError(base, 'Read base branch') };
  const made = await gh('/git/refs', { method: 'POST', body: JSON.stringify({ ref: 'refs/heads/' + branch, sha: base.data.object.sha }) });
  return made.ok ? { ok: true, created: true } : { ok: false, response: ghError(made, 'Create branch') };
}

async function codeSave({ g, gh, body }) {
  const { path, content, branch, sha } = body;
  if (!validPath(path)) return fail(400, 'Invalid or protected path', 'invalid_path');
  if (typeof content !== 'string') return fail(400, 'content must be a string', 'invalid_content');
  const bytes = new TextEncoder().encode(content);
  if (bytes.length > MAX_FILE_BYTES) return fail(413, 'File is too large for the web editor (512 KB max)', 'file_too_large');
  if (typeof branch !== 'string' || !BRANCH.test(branch)) return fail(400, 'branch must look like live-fix/<name> or hotfix/<name>; the base branch only changes through promote', 'invalid_branch');
  if (sha !== undefined && (typeof sha !== 'string' || !SHA.test(sha))) return fail(400, 'sha must be a 40-character blob sha', 'invalid_sha');
  const message = clean(typeof body.message === 'string' && body.message.trim() ? body.message : 'Live fix: ' + path, 200);
  const b = await ensureBranch(g, gh, branch);
  if (!b.ok) return b.response;
  const r = await gh('/contents/' + enc(path), { method: 'PUT', body: JSON.stringify({ message, content: toBase64(bytes), branch, ...(sha ? { sha } : {}) }) });
  if (!r.ok) return ghError(r, r.status === 409 || r.status === 422 ? 'Save conflict (reload the file from this branch)' : 'Save file');
  return json({ ok: true, path, branch, branchCreated: b.created, sha: r.data.content?.sha, commit: r.data.commit?.sha });
}

async function openPr(g, gh, branch, title, text) {
  const owner = g.repo.split('/')[0];
  const found = await gh('/pulls?state=open&head=' + encodeURIComponent(owner + ':' + branch));
  if (found.ok && found.data?.[0]) return { ok: true, pr: { number: found.data[0].number, url: found.data[0].html_url, existing: true } };
  const r = await gh('/pulls', { method: 'POST', body: JSON.stringify({ title, head: branch, base: g.base, body: text }) });
  return r.ok ? { ok: true, pr: { number: r.data.number, url: r.data.html_url, existing: false } } : { ok: false, response: ghError(r, 'Open pull request') };
}

async function codePr({ g, gh, body }) {
  if (typeof body.branch !== 'string' || !BRANCH.test(body.branch)) return fail(400, 'branch must be live-fix/* or hotfix/*', 'invalid_branch');
  const p = await openPr(g, gh, body.branch, clean(body.title || 'Live fix: ' + body.branch, 120), clean(body.body || 'Opened from the mini-chat live-fix space.', 2000));
  return p.ok ? json({ ok: true, ...p.pr }) : p.response;
}

async function runs({ g, gh }) {
  const r = await gh('/actions/workflows/' + enc(g.workflow) + '/runs?per_page=10');
  if (!r.ok) return ghError(r, 'List workflow runs');
  return json((r.data.workflow_runs || []).map((x) => ({ id: x.id, title: x.display_title, status: x.status, conclusion: x.conclusion, branch: x.head_branch, sha: x.head_sha, createdAt: x.created_at, url: x.html_url })));
}

// Every deploy, promote, hotfix and rollback is one workflow_dispatch of .github/workflows/deploy.yml.
async function dispatch(g, gh, ref, inputs) {
  const requestId = 'r' + Array.from(crypto.getRandomValues(new Uint8Array(5)), (x) => x.toString(16).padStart(2, '0')).join('');
  const all = { operation: 'deploy', target: 'test', sha: '', percentage: '100', version_id: '', hotfix: 'false', reason: '', ...inputs, request_id: requestId };
  const r = await gh('/actions/workflows/' + enc(g.workflow) + '/dispatches', { method: 'POST', body: JSON.stringify({ ref, inputs: all }) });
  return r.ok ? { ok: true, dispatched: { requestId, ref, ...all } } : { ok: false, response: ghError(r, 'Start workflow') };
}
function common(body) {
  if (body.sha !== undefined && body.sha !== '' && (typeof body.sha !== 'string' || !SHA.test(body.sha))) return { error: fail(400, 'sha must be a 40-character commit sha', 'invalid_sha') };
  if (body.reason !== undefined && typeof body.reason !== 'string') return { error: fail(400, 'reason must be a string', 'invalid_reason') };
  return { sha: body.sha || '', reason: clean(body.reason || '', 100) };
}

async function deployTest({ g, gh, body }) {
  if (body.target !== undefined && body.target !== 'test') return fail(400, 'deploy only targets test; use promote or hotfix for production', 'invalid_target');
  const ref = body.ref || g.base;
  if (typeof ref !== 'string' || !validRef(ref, g.base)) return fail(400, 'ref must be the base branch, live-fix/* or hotfix/*', 'invalid_ref');
  const x = common(body); if (x.error) return x.error;
  const d = await dispatch(g, gh, ref, { target: 'test', sha: x.sha, reason: x.reason || 'test deploy of ' + ref });
  return d.ok ? json({ ok: true, ...d.dispatched }, 202) : d.response;
}

const percentOf = (v) => v === undefined ? 100 : Number.isInteger(v) && v >= 1 && v <= 100 ? v : null;

// Promote: optionally squash-merge the live-fix PR, then deploy the base branch to production.
async function promote({ g, gh, body }) {
  const percentage = percentOf(body.percentage);
  if (percentage === null) return fail(400, 'percentage must be an integer from 1 to 100', 'invalid_percentage');
  if (body.number !== undefined && (!Number.isInteger(body.number) || body.number < 1)) return fail(400, 'number must be a pull request number', 'invalid_number');
  const x = common(body); if (x.error) return x.error;
  let merged = null, sha = x.sha;
  if (body.number) {
    const pr = await gh('/pulls/' + body.number);
    if (!pr.ok) return ghError(pr, 'Read pull request');
    if (pr.data.base?.ref !== g.base || !BRANCH.test(pr.data.head?.ref || '')) return fail(400, 'Only live-fix/* or hotfix/* pull requests into the base branch can be promoted', 'invalid_pull_request');
    if (pr.data.merged) merged = { number: body.number, sha: pr.data.merge_commit_sha, alreadyMerged: true };
    else {
      if (pr.data.state !== 'open') return fail(409, 'Pull request is closed', 'pull_request_closed');
      const m = await gh('/pulls/' + body.number + '/merge', { method: 'PUT', body: JSON.stringify({ merge_method: 'squash', sha: pr.data.head.sha }) });
      if (!m.ok) return ghError(m, 'Merge pull request');
      merged = { number: body.number, sha: m.data.sha, alreadyMerged: false };
    }
    sha = merged.sha;
  }
  const d = await dispatch(g, gh, g.base, { target: 'production', sha, percentage: String(percentage), reason: x.reason || (merged ? 'promote #' + merged.number : 'promote ' + g.base) });
  return d.ok ? json({ ok: true, merged, ...d.dispatched }, 202) : d.response;
}

// Hotfix: deploy a hotfix/* branch straight to production (unit tests still run), and open a PR so
// the base branch picks the change up before the next promote.
async function hotfix({ g, gh, body }) {
  if (typeof body.branch !== 'string' || !body.branch.startsWith('hotfix/') || !BRANCH.test(body.branch)) return fail(400, 'branch must look like hotfix/<name>', 'invalid_branch');
  const x = common(body); if (x.error) return x.error;
  const d = await dispatch(g, gh, body.branch, { target: 'production', sha: x.sha, hotfix: 'true', reason: x.reason || 'hotfix ' + body.branch });
  if (!d.ok) return d.response;
  const p = await openPr(g, gh, body.branch, 'Hotfix: ' + body.branch, 'Deployed to production as a hotfix from the live-fix space. Merge so the base branch keeps it.');
  return json({ ok: true, ...d.dispatched, pr: p.ok ? p.pr : null, prError: p.ok ? undefined : 'Pull request not opened; open it manually' }, 202);
}

async function rollback({ g, gh, body }) {
  if (!Object.hasOwn(SCRIPTS, body.target)) return fail(400, 'target must be test or production', 'invalid_target');
  if (body.versionId !== undefined && body.versionId !== '' && (typeof body.versionId !== 'string' || !UUID.test(body.versionId))) return fail(400, 'versionId must be a Worker version UUID', 'invalid_version');
  const x = common(body); if (x.error) return x.error;
  const d = await dispatch(g, gh, g.base, { operation: 'rollback', target: body.target, version_id: body.versionId || '', reason: x.reason || 'rollback ' + body.target });
  return d.ok ? json({ ok: true, ...d.dispatched }, 202) : d.response;
}

function clean(value, max) { return String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max); }
function toBase64(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); }
function fromBase64(text) { const s = atob(String(text).replace(/\s+/g, '')); const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; }

// ---------- Durable Object side (ChannelRoom) ----------
// Reached only with the internal secret (ChannelRoom.authorized), so these routes trust the caller.
export async function handleRoomDeveloper(room, request, { path, channel, url }) {
  const sql = room.ctx.storage.sql, method = request.method;
  if (path === '/dev/diagnostics' && method === 'GET') {
    const state = room.readState(channel);
    const counts = Object.fromEntries(sql.exec('SELECT source, COUNT(*) AS n FROM error_log GROUP BY source').toArray().map((r) => [r.source, r.n]));
    const last = sql.exec('SELECT at, source, message FROM error_log ORDER BY id DESC LIMIT 1').toArray()[0] || null;
    return json({
      channel,
      revision: state.revision,
      chat: { connected: Boolean(state.chat?.connected), lastSeen: Number(state.chat?.lastSeen) || 0, status: String(state.chat?.status || 'disconnected') },
      chatStatus: chatStatus(state),
      paused: !state.chat?.connected || !state.config?.enabled,
      configVersion: state.configVersion,
      players: state.players.length,
      openDuels: state.duels.filter((d) => d.status === 'pending' || d.status === 'active').length,
      sockets: { live: room.ctx.getWebSockets('live').length },
      errors: Object.values(counts).reduce((a, b) => a + b, 0),
      errorsBySource: counts,
      lastError: last,
    });
  }
  if (path === '/dev/logs' && method === 'GET') {
    const q = url || new URL(request.url), source = q.searchParams.get('source'), limit = Math.min(100, Math.max(1, Number(q.searchParams.get('limit')) || 100));
    const rows = ['room', 'worker', 'command', 'warn'].includes(source)
      ? sql.exec('SELECT id, at, source, message, context FROM error_log WHERE source = ? ORDER BY id DESC LIMIT ?', source, limit).toArray()
      : sql.exec('SELECT id, at, source, message, context FROM error_log ORDER BY id DESC LIMIT ?', limit).toArray();
    return json(rows.map((r) => ({ ...r, context: safeParse(r.context) })));
  }
  if (path === '/dev/logs' && method === 'DELETE') {
    sql.exec('DELETE FROM error_log');
    return json({ ok: true });
  }
  if (path === '/dev/log' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    insertLog(sql, 'worker', body?.message, body?.context);
    return json({ ok: true });
  }
  if (path === '/dev/codex' && method === 'GET') return json(readCodex(sql));
  if (path === '/dev/codex' && method === 'POST') {
    const body = await request.json().catch(() => null);
    if (typeof body?.authorized !== 'boolean') return json({ error: 'authorized must be boolean' }, 400);
    const value = { authorized: body.authorized, note: String(body.note || '').slice(0, 200), updatedBy: String(body.by || '').slice(0, 25), updatedAt: Date.now() };
    sql.exec('INSERT INTO dev_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', 'codex', JSON.stringify(value));
    return json(value);
  }
  return json({ error: 'Not found' }, 404);
}

function readCodex(sql) {
  const row = sql.exec('SELECT value FROM dev_settings WHERE key = ?', 'codex').toArray()[0];
  const v = row ? safeParse(row.value) : null;
  return { authorized: v?.authorized === true, note: v?.note || '', updatedBy: v?.updatedBy || '', updatedAt: v?.updatedAt || 0 };
}

// Called from ChannelRoom's constructor.
export function ensureDeveloperSchema(sql) {
  sql.exec('CREATE TABLE IF NOT EXISTS error_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, source TEXT NOT NULL, message TEXT NOT NULL, context TEXT NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS dev_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
}

// Called by ChannelRoom when one of its handlers throws. Must never throw.
export function logRoomError(room, error, context = {}) {
  try { insertLog(room.ctx.storage.sql, 'room', error?.message || String(error), context); } catch {}
}

// One line per chat command (source 'command') or a broken invariant (source 'warn'), so a wrong reply
// can be traced without a crash. Also printed for `wrangler tail`. Must never throw.
export function logRoomEvent(room, source, message, context = {}) {
  try { console.log(JSON.stringify({ log: source, message, ...context })); } catch {}
  try { insertLog(room.ctx.storage.sql, source, message, context); } catch {}
}

// Called by the Worker's top-level catch (through ctx.waitUntil). Must never throw.
export async function logWorkerError(env, error, context = {}) {
  try {
    if (!env.INTERNAL_SECRET || !env.ROOMS) return;
    await env.ROOMS.get(env.ROOMS.idFromName('nesszerra')).fetch('https://room/dev/log', {
      method: 'POST',
      headers: { 'X-Mini-Internal': env.INTERNAL_SECRET, 'X-Mini-Channel': 'nesszerra', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: error?.message || String(error), context }),
    });
  } catch {}
}

function insertLog(sql, source, message, context) {
  let ctx = JSON.stringify(context ?? {}) || '{}';
  if (ctx.length > 2000) ctx = JSON.stringify({ truncated: ctx.slice(0, 1900) });
  sql.exec('INSERT INTO error_log (at, source, message, context) VALUES (?, ?, ?, ?)', Date.now(), source, String(message || 'unknown').slice(0, 500), ctx);
  sql.exec('DELETE FROM error_log WHERE id <= (SELECT MAX(id) FROM error_log) - ?', MAX_LOG_ROWS);
}

function safeParse(value) {
  try { return JSON.parse(value); } catch { return null; }
}
