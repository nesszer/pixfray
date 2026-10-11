// Scroll scrubs a camera move baked from the intro scene: the frames are stills, so these pages run no WebGL.
// The canvas cross-fades the two frames either side of the scroll position and eases toward it, so a wheel notch
// glides instead of jumping. It draws only while the position is still moving.
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

export function scrub(
  canvas: HTMLCanvasElement,
  {
    frames,
    progress,
    keys = null,
    onFrame = null,
  }: {
    frames: string[];
    progress: () => number;
    keys?: number[] | null;
    onFrame?: ((p: number) => void) | null;
  },
) {
  const imgs: (HTMLImageElement | null)[] = frames.map(() => null),
    ctx = canvas.getContext("2d") as CanvasRenderingContext2D; // a canvas only drawn in 2D always has one
  let cur = progress(),
    want = cur,
    raf = 0,
    last = 0,
    ready = false;
  const load = (i: number) =>
    new Promise<void>((done) => {
      const im = new Image();
      im.decoding = "async";
      im.src = frames[i]!; // in range: i is a frame index
      im.decode().then(() => {
        imgs[i] = im;
        done();
      }, done);
    });
  // with reduced motion the picture changes per step (keys), without the in-between frames
  const snap = (p: number) =>
    // keys[0]!: a keys list is never empty
    !reduced || !keys ? p : keys.reduce((a, k) => (Math.abs(k - p) < Math.abs(a - p) ? k : a), keys[0]!);
  function size() {
    const d = Math.min(devicePixelRatio || 1, 2),
      w = Math.round(canvas.clientWidth * d),
      hgt = Math.round(canvas.clientHeight * d);
    if (w && hgt && (canvas.width !== w || canvas.height !== hgt)) {
      canvas.width = w;
      canvas.height = hgt;
      draw();
    }
  }
  function nearest(i: number, step: number) {
    for (let k = i; k >= 0 && k < imgs.length; k += step) if (imgs[k]) return imgs[k];
    return null;
  }
  function cover(im: HTMLImageElement, alpha: number) {
    const W = canvas.width,
      H = canvas.height,
      s = Math.max(W / im.naturalWidth, H / im.naturalHeight);
    const w = im.naturalWidth * s,
      hgt = im.naturalHeight * s;
    ctx.globalAlpha = alpha;
    ctx.drawImage(im, (W - w) / 2, (H - hgt) / 2, w, hgt);
  }
  function draw() {
    const f = Math.max(0, Math.min(1, cur)) * (frames.length - 1),
      i = Math.floor(f),
      a = f - i;
    const A = nearest(i, -1) || nearest(i, 1),
      B = a > 0.001 ? nearest(i + 1, 1) : null;
    if (!A) return;
    cover(A, 1);
    if (B && B !== A) cover(B, a);
    if (!ready) {
      ready = true;
      canvas.classList.add("is-ready");
    }
    onFrame?.(cur);
  }
  function tick(t: number) {
    const dt = Math.min(0.05, last ? (t - last) / 1000 : 0.016);
    last = t;
    cur = reduced ? want : cur + (want - cur) * (1 - Math.exp(-dt * 7));
    if (Math.abs(want - cur) < 0.0005) cur = want;
    draw();
    raf = cur === want ? 0 : requestAnimationFrame(tick);
    if (!raf) last = 0;
  }
  function update() {
    want = snap(progress());
    if (!raf) raf = requestAnimationFrame(tick);
  }
  addEventListener("scroll", update, { passive: true });
  addEventListener("resize", update);
  new ResizeObserver(size).observe(canvas);
  // the frame for the current position first, then the rest from there outward
  const first = Math.round(Math.max(0, Math.min(1, snap(cur))) * (frames.length - 1));
  cur = want = snap(cur);
  load(first)
    .then(() => {
      size();
      draw();
    })
    .then(async () => {
      const order = frames
        .map((_, i) => i)
        .filter((i) => i !== first)
        .sort((a, b) => Math.abs(a - first) - Math.abs(b - first));
      for (const i of order) {
        await load(i);
        if (Math.abs(i - cur * (frames.length - 1)) < 1.5) draw();
      }
    });
  size();
}

// a fixed backdrop behind the whole page: the camera pulls back from the floating islets as the page scrolls
export function skyBackdrop() {
  const canvas = document.createElement("canvas");
  canvas.className = "scene-sky";
  canvas.setAttribute("aria-hidden", "true");
  document.body.prepend(canvas);
  const m = matchMedia("(max-width: 760px)").matches ? "-m" : "";
  const frames = Array.from({ length: 9 }, (_, i) => "/assets/scene/seq/sky-" + i + m + ".webp");
  const range = () => Math.max(1, Math.min(1600, document.documentElement.scrollHeight - innerHeight));
  scrub(canvas, { frames, progress: () => (reduced ? 0 : scrollY / range()) });
  document.documentElement.classList.add("has-scene-sky");
}
