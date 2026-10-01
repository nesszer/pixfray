// Live-fix space (/admin/dev/, Lane E). Owner-only page over /api/dev/* (server/developer.js). No framework.
const $ = (s) => document.querySelector(s);
const S = { session: null, diag: null, config: null, configVersion: 0, fileSha: '', fileRef: '' };

async function api(path, { method = 'GET', body } = {}) {
  const init = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
  if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  let r; try { r = await fetch(path, init); } catch { return { ok: false, status: 0, data: { error: 'Network error; check your connection' } }; }
  let data = null; try { data = await r.json(); } catch {}
  return { ok: r.ok, status: r.status, data };
}
const errorText = (r, fallback = 'Request failed') => r.data?.error || (r.status ? `${fallback} (HTTP ${r.status})` : fallback);
function h(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : String(c));
  return n;
}
function status(id, msg, kind = '') { const n = $(id); n.textContent = msg || ''; n.className = 'status' + (kind ? ' ' + kind : ''); }
const fmtTime = (v) => { if (!v) return '–'; const d = new Date(v); return isNaN(d) ? '–' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };
const fmtNum = (n) => Number(n).toLocaleString('en-US');
const short = (id) => (id ? String(id).slice(0, 8) : '–');
function rows(tbody, list, empty, cols) {
  const t = $(tbody); t.replaceChildren();
  if (!list.length) { t.append(h('tr', {}, h('td', { colspan: cols, class: 'muted' }, empty))); return; }
  for (const r of list) t.append(r);
}
async function busy(button, fn) { button.disabled = true; try { await fn(); } finally { button.disabled = false; } }

// ---------- access ----------
async function start() {
  const s = await api('/api/session');
  S.session = s.data;
  const who = $('#who'); who.replaceChildren();
  if (s.data?.user) who.append(h('span', {}, 'Signed in as ' + s.data.user.displayName), h('button', { class: 'btn btn-small', type: 'button', onclick: signOut }, 'Sign out'));
  else who.append(h('a', { class: 'btn btn-small', href: '/auth/login' }, 'Sign in with Twitch'));
  if (!s.ok) return gate(errorText(s, 'The server is unreachable'), []);
  if (!s.data.user) return gate('Sign in with the nesszerra Twitch account to open the live-fix space.', [h('a', { class: 'btn btn-primary', href: '/auth/login' }, 'Sign in with Twitch')]);
  if (!s.data.owner) return gate('The live-fix space is limited to the nesszerra account. Moderators can use Mod controls.', [h('a', { class: 'btn', href: '/admin/' }, 'Open mod controls')]);
  $('#gate').hidden = true; $('#app').hidden = false;
  if (!$('#branch').value) $('#branch').value = 'live-fix/' + new Date().toISOString().slice(0, 10);
  await Promise.all([loadDiagnostics(), loadConfig(), loadLogs()]);
  loadRuns(); loadVersions();
}
function gate(text, actions) { $('#gate-text').textContent = text; $('#gate-actions').replaceChildren(...actions); $('#gate').hidden = false; $('#app').hidden = true; }
async function signOut() { await api('/auth/logout', { method: 'POST', body: {} }); location.reload(); }

// ---------- diagnostics ----------
async function loadDiagnostics() {
  const r = await api('/api/dev/diagnostics');
  if (!r.ok) { $('#summary-title').textContent = 'Diagnostics unavailable'; $('#summary-text').textContent = errorText(r); return; }
  const d = S.diag = r.data, room = d.room || {}, use = d.usage || {}, chat = room.chatStatus || {}, chatOn = !!chat.connected;
  $('#s-chat').textContent = chatOn ? 'Connected' : 'Offline';
  $('#s-chat').className = 'value ' + (chatOn ? 'up' : 'down');
  $('#s-chat-note').textContent = chat.lastRevocationReason ? 'Revoked: ' + chat.lastRevocationReason : chat.lastNotificationAt ? 'Last message ' + fmtTime(chat.lastNotificationAt) : chatOn ? 'No chat message yet' : 'Connect chat in admin';
  if (use.configured && Number.isFinite(use.requests)) {
    $('#s-requests').textContent = fmtNum(use.requests);
    $('#s-requests-note').textContent = use.percent + '% used, resets ' + fmtTime(use.resetsAt);
    $('#s-requests-note').className = 'delta' + (use.percent >= 80 ? ' down' : '');
  } else { $('#s-requests').textContent = 'Unknown'; $('#s-requests-note').textContent = use.configured ? (use.error || 'Analytics unavailable') : 'Cloudflare API not configured'; }
  $('#s-errors').textContent = fmtNum(room.errors ?? 0);
  $('#s-errors-note').textContent = room.lastError ? 'Latest ' + fmtTime(room.lastError.at) : 'None stored';
  $('#s-errors-note').className = 'delta' + (room.errors ? ' down' : '');
  $('#s-sockets').textContent = fmtNum(room.sockets?.live ?? 0);
  $('#s-sockets-note').textContent = `${room.players ?? 0} players, ${room.openDuels ?? 0} open duels`;
  const ver = d.worker?.deployedVersion;
  $('#meta').textContent = `Worker ${d.worker?.version || ''}` + (ver ? ` · version ${short(ver.id)}${ver.tag ? ' (' + ver.tag + ')' : ''}` : ' · version id unavailable') + ` · checked ${fmtTime(Date.now())}`;
  const parts = [chatOn ? 'Twitch chat is connected' : 'Twitch chat is not connected, so combat is paused', room.errors ? `${room.errors} errors are logged` : 'no errors are logged'];
  if (use.configured && Number.isFinite(use.requests)) parts.push(`${fmtNum(use.requests)} of 100,000 daily requests are used (${use.percent}%)`);
  $('#summary-title').textContent = !chatOn ? 'Combat is paused: chat offline' : room.errors ? `Running, with ${room.errors} logged errors` : 'Running normally';
  $('#summary-text').textContent = parts.join('; ') + '.';
  renderIntegrations(d.integrations || {});
  renderCodex(d.codex || { authorized: false });
}

function renderIntegrations(i) {
  const g = i.github || {}, c = i.cloudflare || {};
  const badge = (ok) => h('span', { class: 'badge ' + (ok ? 'positive' : 'warning') }, ok ? 'Configured' : 'Not configured');
  rows('#integrations', [
    h('tr', {}, h('td', {}, 'GitHub' + (g.repo ? ' (' + g.repo + ')' : '')), h('td', {}, badge(g.configured)), h('td', {}, (g.missing || []).join(', ') || '–'), h('td', {}, 'Code editor, deploy, promote, hotfix, rollback')),
    h('tr', {}, h('td', {}, 'Cloudflare API (read-only)'), h('td', {}, badge(c.configured)), h('td', {}, (c.missing || []).join(', ') || '–'), h('td', {}, 'Request usage, Worker versions')),
    h('tr', {}, h('td', {}, 'Version metadata binding'), h('td', {}, badge(c.versionMetadata)), h('td', {}, c.versionMetadata ? '–' : 'CF_VERSION_METADATA'), h('td', {}, 'Showing the version that served this page')),
  ], '', 4);
  const missing = $('#github-missing');
  missing.hidden = !!g.configured;
  missing.textContent = g.configured ? '' : 'GitHub is not configured yet (' + (g.missing || []).join(', ') + '), so saving, deploying and rolling back are unavailable. See docs/LIVE_FIX.md.';
  for (const id of ['#deploy-test', '#promote', '#rollback', '#hotfix', '#save-file', '#open-pr', '#load-file', '#load-tree']) $(id).disabled = !g.configured;
}

// ---------- release ----------
function branch() { return $('#branch').value.trim(); }
function released(r, what) {
  if (!r.ok) return status('#release-status', errorText(r, what + ' failed'), 'error');
  const extra = r.data.merged ? ` Merged #${r.data.merged.number}.` : '';
  const pr = r.data.pr ? ` Pull request #${r.data.pr.number} is open for main.` : r.data.prError ? ' ' + r.data.prError + '.' : '';
  status('#release-status', `${what} started (run ${r.data.requestId}).${extra}${pr} Watch the run below.`, 'ok');
  setTimeout(loadRuns, 4000);
}
$('#deploy-test').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  released(await api('/api/dev/deploy', { method: 'POST', body: { ref: branch() } }), 'Test deploy of ' + branch());
}));
$('#promote').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  const number = $('#pr-number').value ? Number($('#pr-number').value) : undefined, percentage = Number($('#percentage').value || 100);
  const what = number ? `merge #${number} and deploy main` : 'deploy main as it is';
  if (!confirm(`Promote to chat.miolaf.xyz: ${what}, ${percentage}% of traffic?`)) return;
  released(await api('/api/dev/promote', { method: 'POST', body: { ...(number ? { number } : {}), percentage } }), 'Promote');
}));
$('#hotfix').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  if (!branch().startsWith('hotfix/')) return status('#release-status', 'Set the branch to hotfix/<name> in the code editor first.', 'error');
  if (!confirm(`Deploy ${branch()} straight to chat.miolaf.xyz without the test site?`)) return;
  released(await api('/api/dev/hotfix', { method: 'POST', body: { branch: branch() } }), 'Hotfix');
}));
$('#rollback').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  const target = $('#rb-target').value, versionId = $('#rb-version').value;
  if (!confirm(`Roll back ${target === 'production' ? 'chat.miolaf.xyz' : 'test.chat.miolaf.xyz'} to ${versionId ? short(versionId) : 'the previous deployment'}?`)) return;
  released(await api('/api/dev/rollback', { method: 'POST', body: { target, ...(versionId ? { versionId } : {}) } }), 'Rollback');
}));
$('#rb-target').addEventListener('change', fillVersions);

async function loadRuns() {
  const r = await api('/api/dev/runs');
  if (!r.ok) return rows('#runs', [], errorText(r, 'Runs unavailable'), 4);
  rows('#runs', r.data.map((x) => h('tr', {},
    h('td', {}, fmtTime(x.createdAt)), h('td', { class: 'wrap' }, h('a', { href: x.url, target: '_blank', rel: 'noopener' }, x.title || String(x.id))), h('td', {}, x.branch || '–'),
    h('td', {}, h('span', { class: 'badge ' + (x.conclusion === 'success' ? 'positive' : x.conclusion ? 'negative' : 'warning') }, x.conclusion || x.status)))), 'No deploy runs yet.', 4);
}
async function loadVersions() {
  const r = await api('/api/dev/versions');
  S.versions = r.ok ? r.data : null;
  if (!r.ok) { rows('#deployments', [], errorText(r, 'Versions unavailable'), 5); return fillVersions(); }
  const list = [];
  for (const [target, v] of Object.entries(r.data)) {
    const d = v.deployments[0];
    if (!d) { list.push(h('tr', {}, h('td', {}, target), h('td', { colspan: 4, class: 'muted' }, v.error || 'No deployments'))); continue; }
    for (const x of d.versions) list.push(h('tr', {}, h('td', {}, target), h('td', {}, h('code', {}, short(x.versionId))), h('td', { class: 'num' }, x.percentage), h('td', {}, fmtTime(d.createdOn)), h('td', { class: 'wrap' }, d.message || '–')));
  }
  rows('#deployments', list, 'No deployments.', 5);
  fillVersions();
}
function fillVersions() {
  const sel = $('#rb-version'), versions = S.versions?.[$('#rb-target').value]?.versions || [];
  sel.replaceChildren(h('option', { value: '' }, 'Previous deployment'), ...versions.map((v) => h('option', { value: v.id }, `#${v.number ?? '?'} ${short(v.id)} ${v.tag || ''} ${fmtTime(v.createdOn)}`.trim())));
}

// ---------- code editor ----------
$('#load-tree').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  const r = await api('/api/dev/code/tree?ref=' + encodeURIComponent(branch() || 'main'));
  const r2 = r.ok ? r : await api('/api/dev/code/tree');
  if (!r2.ok) return status('#code-status', errorText(r2, 'Could not list files'), 'error');
  $('#files').replaceChildren(...r2.data.files.map((f) => h('option', { value: f.path })));
  status('#code-status', `${r2.data.files.length} files on ${r2.data.ref}. Start typing a path in File.`, 'ok');
}));
$('#load-file').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  const path = $('#path').value.trim();
  if (!path) return status('#code-status', 'Enter a file path.', 'error');
  const r = await api('/api/dev/code/file?path=' + encodeURIComponent(path) + (branch() ? '&branch=' + encodeURIComponent(branch()) : ''));
  if (!r.ok) return status('#code-status', errorText(r, 'Could not load the file'), 'error');
  $('#editor').value = r.data.content; S.fileSha = r.data.sha; S.fileRef = r.data.ref; S.filePath = path;
  $('#file-info').textContent = `${path} from ${r.data.ref} (${fmtNum(r.data.size)} bytes)`;
  status('#code-status', r.data.ref === branch() ? 'Loaded from the branch.' : `The branch doesn't exist yet; loaded from ${r.data.ref}. Saving creates the branch.`, 'ok');
}));
$('#save-file').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  const path = $('#path').value.trim();
  if (!path || path !== S.filePath) return status('#code-status', 'Load the file first so the save is based on its current version.', 'error');
  const r = await api('/api/dev/code/save', { method: 'POST', body: { path, branch: branch(), content: $('#editor').value, sha: S.fileSha, message: $('#commit-msg').value.trim() || undefined } });
  if (!r.ok) return status('#code-status', errorText(r, 'Save failed'), 'error');
  S.fileSha = r.data.sha; S.fileRef = r.data.branch;
  $('#file-info').textContent = `${path} on ${r.data.branch}`;
  status('#code-status', `Saved to ${r.data.branch}${r.data.branchCreated ? ' (new branch)' : ''}, commit ${String(r.data.commit).slice(0, 7)}. Next: deploy the branch to test.`, 'ok');
}));
$('#open-pr').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  const r = await api('/api/dev/code/pr', { method: 'POST', body: { branch: branch(), title: $('#commit-msg').value.trim() || undefined } });
  if (!r.ok) return status('#code-status', errorText(r, 'Could not open the pull request'), 'error');
  $('#pr-number').value = r.data.number;
  const s = $('#code-status'); s.className = 'status ok';
  s.replaceChildren(`Pull request #${r.data.number} ${r.data.existing ? 'is already open' : 'opened'}: `, h('a', { href: r.data.url, target: '_blank', rel: 'noopener' }, r.data.url), '. Its number is filled in under Promote.');
}));

// ---------- live settings ----------
async function loadConfig() {
  const r = await api('/api/dev/settings');
  if (!r.ok) return status('#config-status', errorText(r, 'Could not load settings'), 'error');
  S.config = r.data.config; S.configVersion = r.data.configVersion;
  $('#config').value = JSON.stringify(r.data.config, null, 2);
  $('#config-version').textContent = 'version ' + r.data.configVersion;
  $('#history-title').textContent = 'Config history (' + (r.data.history || []).length + ' versions)';
  rows('#history', (r.data.history || []).map((x) => h('tr', {}, h('td', { class: 'num' }, 'v' + x.version), h('td', {}, fmtTime(x.at)), h('td', {}, x.actorName || x.actorId || '–'), h('td', { class: 'wrap' }, x.note || '–'),
    h('td', {}, x.version === r.data.configVersion ? h('span', { class: 'muted small' }, 'Current') : h('button', { class: 'btn btn-small', type: 'button', onclick: () => rollbackConfig(x.version) }, 'Restore v' + x.version)))), 'No history yet.', 5);
}
async function rollbackConfig(version) {
  if (!confirm(`Restore config v${version} as a new version?`)) return;
  const r = await api('/api/dev/settings', { method: 'POST', body: { action: 'rollbackConfig', payload: { version } } });
  status('#config-status', r.ok ? `Restored v${version}.` : errorText(r, 'Restore failed'), r.ok ? 'ok' : 'error');
  if (r.ok) loadConfig();
}
$('#reload-config').addEventListener('click', () => { status('#config-status', ''); loadConfig(); });
$('#save-config').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  let next; try { next = JSON.parse($('#config').value); } catch (err) { return status('#config-status', 'Config is not valid JSON: ' + err.message, 'error'); }
  if (!next || typeof next !== 'object' || Array.isArray(next)) return status('#config-status', 'Config must be a JSON object.', 'error');
  const patch = Object.fromEntries(Object.entries(next).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(S.config?.[k])));
  if (!Object.keys(patch).length) return status('#config-status', 'Nothing changed.', '');
  const r = await api('/api/dev/settings', { method: 'POST', body: { action: 'config', payload: { patch, baseVersion: S.configVersion, note: $('#config-note').value.trim() } } });
  if (r.status === 409) { status('#config-status', 'Someone else saved a newer version. Reloaded it; reapply your change.', 'error'); return loadConfig(); }
  if (!r.ok) return status('#config-status', errorText(r, 'Save failed'), 'error');
  status('#config-status', `Saved ${Object.keys(patch).join(', ')}.`, 'ok'); $('#config-note').value = '';
  loadConfig();
}));

// ---------- logs ----------
async function loadLogs() {
  const source = $('#log-source').value, r = await api('/api/dev/logs' + (source ? '?source=' + source : ''));
  if (!r.ok) return rows('#logs', [], errorText(r, 'Logs unavailable'), 4);
  rows('#logs', r.data.map((x) => h('tr', {}, h('td', {}, fmtTime(x.at)), h('td', {}, ({ room: 'Durable Object', worker: 'Worker', command: 'Chat command', warn: 'Warning' })[x.source] || x.source), h('td', { class: 'wrap' }, x.message),
    h('td', { class: 'wrap ctx' }, h('code', {}, x.context ? JSON.stringify(x.context) : '–')))), 'Nothing logged.', 4);
}
$('#log-source').addEventListener('change', loadLogs);
$('#clear-logs').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  if (!confirm('Clear every stored error row?')) return;
  const r = await api('/api/dev/logs', { method: 'DELETE' });
  if (r.ok) { loadLogs(); loadDiagnostics(); }
}));
$('#refresh').addEventListener('click', (e) => busy(e.currentTarget, async () => { await Promise.all([loadDiagnostics(), loadLogs()]); loadRuns(); loadVersions(); }));

// ---------- codex ----------
function renderCodex(c) {
  $('#codex-toggle').checked = !!c.authorized;
  $('#codex-state').textContent = c.authorized ? 'on' : 'off';
  if (c.note) $('#codex-note').value = c.note;
  status('#codex-status', c.updatedAt ? `${c.authorized ? 'Authorized' : 'Turned off'} by ${c.updatedBy || 'owner'} ${fmtTime(c.updatedAt)}.` : 'Off by default; never authorized.');
}
$('#codex-toggle').addEventListener('change', async (e) => {
  const box = e.currentTarget, authorized = box.checked; // currentTarget is null after the await
  box.disabled = true;
  const r = await api('/api/dev/codex', { method: 'POST', body: { authorized, note: $('#codex-note').value.trim() } });
  box.disabled = false;
  if (!r.ok) { box.checked = !authorized; return status('#codex-status', errorText(r, 'Could not save'), 'error'); }
  renderCodex(r.data);
});

start();
