// Custom character uploader (Lane D). Browser only; no build step needed (served as-is from public/).
//
// Mount API, used by the /admin page (src/admin.js):
//   const { mountUpload } = await import('/upload.js');
//   const handle = await mountUpload(root, { channel, usage, limits, items, refresh });
//     root     Element to render into (its children are replaced).
//     channel  Channel login, e.g. "nesszerra".
//     usage    Optional {count, limit, bytes} from GET /api/admin/:channel (customUsage).
//     limits   Optional limits object; the stricter of these and the built-in LIMITS is enforced.
//     items    Optional custom catalog entries (GET /api/assets/:channel items) for the delete list.
//     refresh  Optional async () => void, called after a save or delete so the page can reload its data.
//   handle = { destroy() }  stops the preview loop and empties root.
// Without `items`/`usage` the module loads them itself from GET /api/assets/:channel (moderator session needed).
//
// Two ways to add a character:
//   One PNG       one image; scaled down to fit 128 x 128 if needed. The overlay animates it with movement and
//                 effects (flash, shake, fade) for attacks and knockouts.
//   PNG frames    PNG files per animation (idle, walk, attack, knockout). Files in a slot play in name order.
// Frames are aligned (bottom-centre) and packed into one atlas in the browser, previewed, then posted as
// POST /api/assets/:channel {label, mode, fps, atlas:<base64 PNG>, frames, animations}. The server checks every
// limit again: PNG only, 24 frames, 128 x 128 per frame, 1.5 MB per atlas, 24 characters per channel.
import { LIMITS, ANIMATION_SLOTS, pngInfo, checkFrames, planAtlas, fitSingle, drawAtlas, uploadBody, formatBytes } from './atlas.js';

const SLOT_LABELS = { idle: 'Idle', walk: 'Walk', attack: 'Attack', ko: 'Knockout' };
const SLOT_HINTS = { idle: 'Standing still.', walk: 'Played while moving. Falls back to idle.', attack: 'Played on strike and heavy. Without it the overlay flashes and shakes.', ko: 'Played when knocked out. Without it the overlay fades the character.' };

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
const naturalSort = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
const createCanvas = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });
const toBlob = (canvas) => new Promise((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error('Could not encode the atlas as PNG'))), 'image/png'));
const toBase64 = (blob) => new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, '')); r.onerror = () => fail(r.error); r.readAsDataURL(blob); });

async function api(path, { method = 'GET', body } = {}) {
  try {
    const res = await fetch(path, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    let data = null;
    try { data = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, data };
  } catch (error) { return { ok: false, status: 0, data: { error: 'Network error: ' + (error?.message || error) } }; }
}
const errorText = (r) => (r.data && (r.data.error || r.data.reason)) || 'HTTP ' + r.status;

function ensureStyles() {
  if (document.querySelector('link[data-upload-css]')) return;
  document.head.append(h('link', { rel: 'stylesheet', href: new URL('./upload.css', import.meta.url).href, 'data-upload-css': true }));
}

// Reads PNG files into {name, w, h, image}. Rejects anything whose bytes are not a PNG, whatever its extension.
async function readPngFiles(files) {
  const out = [], problems = [];
  for (const file of [...files].sort(naturalSort)) {
    const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
    const info = pngInfo(head);
    if (!info || (file.type && file.type !== 'image/png')) { problems.push(file.name + ' is not a PNG file.'); continue; }
    try { out.push({ name: file.name, w: info.width, h: info.height, image: await createImageBitmap(file) }); }
    catch { problems.push(file.name + " couldn't be decoded as an image."); }
  }
  return { frames: out, problems };
}

export async function mountUpload(root, ctx = {}) {
  ensureStyles();
  const channel = ctx.channel || 'nesszerra';
  const limits = { ...LIMITS };
  for (const k of ['maxFrames', 'frameSize', 'maxAtlasBytes', 'maxCharacters']) if (Number.isFinite(ctx.limits?.[k])) limits[k] = Math.min(limits[k], ctx.limits[k]);
  let usage = ctx.usage || null, items = Array.isArray(ctx.items) ? ctx.items : null;
  const state = { mode: 'frames', single: null, slots: { idle: [], walk: [], attack: [], ko: [] }, readProblems: [], plan: null, atlas: null, blob: null, previewSlot: 'walk', busy: false };
  let raf = 0, destroyed = false;

  // ---- layout ----
  const nameInput = h('input', { id: 'up-name', type: 'text', maxlength: limits.maxLabel, required: true, autocomplete: 'off', placeholder: 'For example: Night Knight' });
  const fpsInput = h('input', { id: 'up-fps', type: 'number', min: 1, max: 30, step: 1, value: 8, inputmode: 'numeric' });
  const modeSingle = h('input', { type: 'radio', name: 'up-mode', value: 'single', id: 'up-mode-single' });
  const modeFrames = h('input', { type: 'radio', name: 'up-mode', value: 'frames', id: 'up-mode-frames', checked: true });
  const singleInput = h('input', { id: 'up-single', type: 'file', accept: 'image/png' });
  const slotInputs = Object.fromEntries(ANIMATION_SLOTS.map((s) => [s, h('input', { id: 'up-slot-' + s, type: 'file', accept: 'image/png', multiple: true })]));
  const slotCounts = Object.fromEntries(ANIMATION_SLOTS.map((s) => [s, h('span', { class: 'upload-count small muted' }, 'No files')]));
  const singleBox = h('div', { class: 'upload-field', hidden: true },
    h('label', { for: 'up-single' }, 'PNG image'), singleInput,
    h('p', { class: 'hint small muted' }, 'Larger images are scaled down to fit ' + limits.frameSize + ' x ' + limits.frameSize + ' px. The overlay moves the character and uses effects for attacks and knockouts.'));
  const framesBox = h('div', { class: 'upload-slots' }, ANIMATION_SLOTS.map((s) => h('div', { class: 'upload-field' },
    h('label', { for: 'up-slot-' + s }, SLOT_LABELS[s] + ' frames'), slotInputs[s], slotCounts[s], h('p', { class: 'hint small muted' }, SLOT_HINTS[s]))));
  const problemsBox = h('div', { class: 'upload-problems', role: 'alert' });
  const previewCanvas = h('canvas', { class: 'upload-preview', width: 192, height: 192, role: 'img', 'aria-label': 'Animated preview of the character' });
  const previewButtons = h('div', { class: 'toolbar upload-anim', role: 'group', 'aria-label': 'Preview animation' });
  const sheetBox = h('div', { class: 'upload-sheet' });
  const atlasInfo = h('p', { class: 'small muted', id: 'up-atlas-info' }, 'Choose PNG files to see a preview.');
  const saveButton = h('button', { class: 'btn', type: 'button', disabled: true }, 'Save character');
  const status = h('p', { class: 'status', role: 'status' });
  const usageLine = h('p', { class: 'small muted upload-usage' });
  const deleteSelect = h('select', { id: 'up-delete' });
  const deleteButton = h('button', { class: 'btn btn-danger btn-small', type: 'button' }, 'Delete character');
  const deleteStatus = h('p', { class: 'status', role: 'status' });
  const deleteBox = h('div', { class: 'upload-delete' }, h('label', { for: 'up-delete' }, 'Remove a custom character'), h('div', { class: 'toolbar' }, deleteSelect, deleteButton), deleteStatus);

  root.replaceChildren(h('div', { class: 'upload' },
    h('h3', {}, 'Add a custom character'), usageLine,
    h('div', { class: 'upload-grid' },
      h('form', { class: 'controls form-stack upload-form', onsubmit: (e) => e.preventDefault() },
        h('div', { class: 'upload-field' }, h('label', { for: 'up-name' }, 'Character name'), nameInput),
        h('fieldset', { class: 'upload-mode' }, h('legend', {}, 'Artwork'),
          h('label', { for: 'up-mode-frames' }, modeFrames, ' PNG frames per animation'),
          h('label', { for: 'up-mode-single' }, modeSingle, ' One PNG')),
        singleBox, framesBox,
        h('div', { class: 'upload-field upload-fps' }, h('label', { for: 'up-fps' }, 'Frames per second'), fpsInput),
        h('p', { class: 'hint small muted' }, 'Limits: PNG only, ' + limits.maxFrames + ' frames in total, ' + limits.frameSize + ' x ' + limits.frameSize + ' px per frame, ' + formatBytes(limits.maxAtlasBytes) + ' per atlas, ' + limits.maxCharacters + ' characters per channel.')),
      h('div', { class: 'upload-side' },
        h('div', { class: 'upload-stage' }, previewCanvas), previewButtons, atlasInfo, sheetBox, problemsBox,
        h('div', { class: 'toolbar' }, saveButton), status)),
    deleteBox));

  // ---- state -> view ----
  function renderUsage() {
    if (!usage) { usageLine.textContent = 'Checking free slots…'; return; }
    usageLine.textContent = usage.count + ' of ' + (usage.limit || limits.maxCharacters) + ' custom character slots used, ' + formatBytes(usage.bytes || 0) + ' stored.';
  }
  function renderDelete() {
    const list = items || [];
    deleteSelect.replaceChildren(...(list.length ? list.map((x) => h('option', { value: x.id }, (x.label || x.id) + ' (' + formatBytes(x.bytes || 0) + ')')) : [h('option', { value: '' }, 'No custom characters')]));
    deleteSelect.disabled = deleteButton.disabled = !list.length;
  }
  function groups() {
    if (state.mode === 'single') return state.single ? { idle: [state.single] } : {};
    return state.slots;
  }
  function problems() {
    const out = [...state.readProblems];
    const g = groups();
    if (state.mode === 'single' && !state.single) out.push('Choose a PNG image.');
    if (state.mode === 'frames') out.push(...checkFrames(g, limits));
    if (state.blob && state.blob.size > limits.maxAtlasBytes) out.push('The packed atlas is ' + formatBytes(state.blob.size) + '; the limit is ' + formatBytes(limits.maxAtlasBytes) + '. Use fewer or smaller frames.');
    if (usage && usage.count >= (usage.limit || limits.maxCharacters)) out.push('All ' + limits.maxCharacters + ' custom character slots are used. Delete one first.');
    const fps = Number(fpsInput.value);
    if (!Number.isInteger(fps) || fps < 1 || fps > 30) out.push('Frames per second must be a whole number from 1 to 30.');
    return [...new Set(out)];
  }
  function renderProblems() {
    const list = problems();
    // Nothing chosen yet: the empty-form messages wait until the first file, and Save stays off meanwhile
    const g = groups(), started = state.readProblems.length > 0 || ANIMATION_SLOTS.some((s) => (g[s] || []).length);
    const shown = started ? list : list.filter((p) => p !== 'Add at least one PNG frame.' && p !== 'Choose a PNG image.');
    problemsBox.replaceChildren(...(shown.length ? [h('ul', { class: 'small' }, shown.map((p) => h('li', {}, p)))] : []));
    problemsBox.className = 'upload-problems' + (shown.length ? ' callout negative' : '');
    saveButton.disabled = state.busy || !!list.length || !state.blob || !nameInput.value.trim();
  }
  function renderPreviewButtons() {
    const anims = state.plan?.animations || {};
    const slots = state.mode === 'single' ? ['idle', 'walk', 'attack', 'ko'] : ANIMATION_SLOTS;
    if (!slots.includes(state.previewSlot)) state.previewSlot = 'walk';
    previewButtons.replaceChildren(...slots.map((s) => h('button', { type: 'button', class: 'btn btn-small', 'aria-pressed': String(state.previewSlot === s),
      onclick: () => { state.previewSlot = s; renderPreviewButtons(); } }, SLOT_LABELS[s] + (anims[s] || state.mode === 'single' ? '' : ' (effect)'))));
  }

  // Repack whenever inputs change.
  async function repack() {
    state.plan = state.atlas = state.blob = null;
    sheetBox.replaceChildren();
    const g = groups();
    const hasFrames = ANIMATION_SLOTS.some((s) => (g[s] || []).length);
    if (!hasFrames || (state.mode === 'frames' && checkFrames(g, limits).length)) {
      atlasInfo.textContent = hasFrames ? 'Fix the problems below to see the packed atlas.' : 'Choose PNG files to see a preview.';
      renderPreviewButtons(); renderProblems(); return;
    }
    const plan = planAtlas(g);
    const images = Object.fromEntries(Object.entries(g).map(([s, list]) => [s, list.map((f) => f.image)]));
    const atlas = drawAtlas(plan, images, createCanvas);
    const blob = await toBlob(atlas);
    Object.assign(state, { plan, atlas, blob });
    const count = plan.placements.length;
    atlasInfo.textContent = 'Atlas ' + plan.width + ' x ' + plan.height + ' px, ' + count + ' frame' + (count === 1 ? '' : 's') + ' of ' + plan.cell.w + ' x ' + plan.cell.h + ' px, ' + formatBytes(blob.size) + '.';
    atlas.className = 'upload-atlas';
    atlas.setAttribute('role', 'img');
    atlas.setAttribute('aria-label', 'Packed atlas, ' + count + ' frames');
    sheetBox.replaceChildren(atlas);
    renderPreviewButtons(); renderProblems();
  }

  // Preview loop. Missing animations show the effect the overlay uses instead.
  function tick(now) {
    if (destroyed) return;
    if (!root.isConnected) { destroy(); return; }
    raf = requestAnimationFrame(tick);
    const c = previewCanvas.getContext('2d'), W = previewCanvas.width, H = previewCanvas.height;
    c.clearRect(0, 0, W, H);
    c.fillStyle = 'rgba(127,127,127,0.25)'; c.fillRect(0, H - 12, W, 1);
    const plan = state.plan;
    if (!plan || !state.atlas) return;
    const fps = Math.min(30, Math.max(1, Number(fpsInput.value) || 8));
    const slot = state.previewSlot, own = plan.animations[slot];
    const list = own || (slot === 'walk' ? plan.frames : plan.animations.idle || plan.frames);
    const frame = list[Math.floor((now / 1000) * fps) % list.length];
    const scale = Math.min((H - 24) / frame.h, (W - 24) / frame.w, 3);
    const dw = Math.round(frame.w * scale), dh = Math.round(frame.h * scale);
    let x = (W - dw) / 2, y = H - 12 - dh, alpha = 1, flash = 0;
    const t = (now % 1200) / 1200;
    if (!own && slot === 'walk') { x += Math.sin(t * Math.PI * 2) * 24; y -= Math.abs(Math.sin(t * Math.PI * 4)) * 6; }
    if (!own && slot === 'idle' && state.mode === 'single') y -= Math.abs(Math.sin(t * Math.PI * 2)) * 3;
    if (!own && slot === 'attack') { x += t < 0.3 ? Math.sin(t * 60) * 6 : 0; flash = t < 0.3 ? 1 - t / 0.3 : 0; }
    if (!own && slot === 'ko') alpha = Math.max(0.15, 1 - t);
    c.imageSmoothingEnabled = false;
    c.globalAlpha = alpha;
    c.drawImage(state.atlas, frame.x, frame.y, frame.w, frame.h, Math.round(x), Math.round(y), dw, dh);
    if (flash) { c.globalCompositeOperation = 'source-atop'; c.globalAlpha = flash * 0.8; c.fillStyle = '#ffffff'; c.fillRect(0, 0, W, H); c.globalCompositeOperation = 'source-over'; }
    c.globalAlpha = 1;
  }

  // ---- events ----
  function setMode(mode) {
    state.mode = mode;
    singleBox.hidden = mode !== 'single'; framesBox.hidden = mode !== 'frames';
    state.readProblems = [];
    repack();
  }
  modeSingle.addEventListener('change', () => modeSingle.checked && setMode('single'));
  modeFrames.addEventListener('change', () => modeFrames.checked && setMode('frames'));
  singleInput.addEventListener('change', async () => {
    const { frames, problems: bad } = await readPngFiles(singleInput.files || []);
    state.readProblems = bad;
    state.single = null;
    if (frames[0]) {
      const f = frames[0], fit = fitSingle(f.w, f.h, limits.frameSize);
      let image = f.image;
      if (fit.scale < 1) { const c = createCanvas(fit.w, fit.h); const g = c.getContext('2d'); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.drawImage(f.image, 0, 0, fit.w, fit.h); image = c; }
      state.single = { name: f.name, w: fit.w, h: fit.h, image };
      if (fit.scale < 1) setStatus(status, f.name + ' was scaled from ' + f.w + ' x ' + f.h + ' to ' + fit.w + ' x ' + fit.h + ' px.', '');
    }
    repack();
  });
  for (const s of ANIMATION_SLOTS) slotInputs[s].addEventListener('change', async () => {
    const { frames, problems: bad } = await readPngFiles(slotInputs[s].files || []);
    state.slots[s] = frames;
    state.readProblems = state.readProblems.filter((p) => !p.startsWith('[' + s + '] ')).concat(bad.map((p) => '[' + s + '] ' + p));
    slotCounts[s].textContent = frames.length ? frames.length + ' file' + (frames.length === 1 ? '' : 's') + ': ' + frames.map((f) => f.name).join(', ') : 'No files';
    repack();
  });
  nameInput.addEventListener('input', renderProblems);
  fpsInput.addEventListener('input', renderProblems);

  saveButton.addEventListener('click', async () => {
    if (saveButton.disabled || !state.blob) return;
    state.busy = true; renderProblems();
    setStatus(status, 'Saving…', '');
    try {
      const body = uploadBody(state.plan, { label: nameInput.value, fps: Number(fpsInput.value), mode: state.mode, atlas: await toBase64(state.blob) });
      const r = await api('/api/assets/' + encodeURIComponent(channel), { method: 'POST', body });
      if (!r.ok) { setStatus(status, 'Not saved: ' + errorText(r), 'error'); return; }
      usage = r.data.usage || usage;
      items = [...(items || []), r.data.item];
      setStatus(status, 'Saved "' + r.data.item.label + '". Viewers can pick it on the dashboard now.', 'ok');
      renderUsage(); renderDelete();
      await ctx.refresh?.();
    } catch (error) {
      setStatus(status, 'Not saved: ' + (error?.message || error), 'error');
    } finally { state.busy = false; renderProblems(); }
  });

  deleteButton.addEventListener('click', async () => {
    const id = deleteSelect.value, item = (items || []).find((x) => x.id === id);
    if (!id || !confirm('Delete "' + (item?.label || id) + '"? Viewers using it fall back to a default character.')) return;
    deleteButton.disabled = true;
    const r = await api('/api/assets/' + encodeURIComponent(channel) + '/' + encodeURIComponent(id), { method: 'DELETE' });
    deleteButton.disabled = false;
    if (!r.ok) { setStatus(deleteStatus, 'Not deleted: ' + errorText(r), 'error'); return; }
    usage = r.data.usage || usage;
    items = (items || []).filter((x) => x.id !== id);
    setStatus(deleteStatus, 'Deleted "' + (item?.label || id) + '".', 'ok');
    renderUsage(); renderDelete(); renderProblems();
    await ctx.refresh?.();
  });

  function destroy() { destroyed = true; cancelAnimationFrame(raf); }

  renderUsage(); renderDelete(); renderPreviewButtons(); renderProblems();
  raf = requestAnimationFrame(tick);
  if (!items || !usage) {
    const r = await api('/api/assets/' + encodeURIComponent(channel));
    if (r.ok) { items = r.data.items || []; usage = r.data.usage || usage; renderUsage(); renderDelete(); renderProblems(); }
    else usageLine.textContent = "Couldn't load custom characters: " + errorText(r);
  }
  return { destroy: () => { destroy(); root.replaceChildren(); } };
}

function setStatus(node, message, kind) { node.textContent = message || ''; node.className = 'status' + (kind ? ' ' + kind : ''); }

// Standalone use: <div data-upload-root data-channel="nesszerra"></div><script type="module" src="/upload.js"></script>
if (typeof document !== 'undefined') {
  for (const el of document.querySelectorAll('[data-upload-root]')) mountUpload(el, { channel: el.dataset.channel || 'nesszerra' });
}
