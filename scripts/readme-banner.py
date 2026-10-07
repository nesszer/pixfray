"""Builds docs/banner.svg, the animated README banner: a knight and a ninja duel the way the overlay plays it.

Run from the repo folder: python scripts/readme-banner.py (needs Pillow). The SVG is self-contained (sprites are
embedded PNGs, text is drawn as pixel blocks) and animates with SMIL, which GitHub plays in a README <img>.
"""
import base64, io, json, pathlib
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
FPS, TICKS = 10, 72                     # one loop = 7.2 s
DUR = f'{TICKS / FPS}s'
W, H = 960, 340
FLOOR = 304

BG, SURFACE, RAISED, BORDER, BORDER_STRONG = '#17110c', '#201710', '#2a2014', '#3b2c1d', '#6b5234'
TEXT, TEXT_3, GOLD, GOLD_HI, POS, NEG, WARN = '#f2e8d5', '#b3a184', '#c9a45c', '#dcbb78', '#7fc98a', '#f08c7c', '#e3aa4a'

# 5x7 pixel font, only the characters the banner uses.
FONT = {
    'A': ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
    'C': ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
    'E': ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
    'F': ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
    'G': ['01111', '10000', '10000', '10011', '10001', '10001', '01111'],
    'H': ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
    'I': ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
    'J': ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
    'K': ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
    'L': ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
    'N': ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
    'O': ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
    'P': ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
    'R': ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
    'S': ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
    'T': ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
    'W': ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
    'X': ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
    'Y': ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
    '0': ['01110', '10011', '10101', '10101', '10101', '11001', '01110'],
    '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
    '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
    '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
    '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
    '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
    '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
    '!': ['00100', '00100', '00100', '00100', '00100', '00000', '00100'],
    '@': ['01110', '10001', '10111', '10101', '10111', '10000', '01110'],
    '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
    '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
    ' ': ['00000'] * 7,
}


def text_width(s, px):
    return (len(s) * 6 - 1) * px


def pixel_path(s, x, y, px):
    """One <path> d string drawing s in the pixel font with its top-left at x, y."""
    d = []
    for i, ch in enumerate(s):
        for r, row in enumerate(FONT[ch]):
            c = 0
            while c < 5:
                if row[c] == '1':
                    run = c
                    while run < 5 and row[run] == '1':
                        run += 1
                    d.append(f'M{x + (i * 6 + c) * px} {y + r * px}h{(run - c) * px}v{px}h-{(run - c) * px}z')
                    c = run
                else:
                    c += 1
    return ''.join(d)


def t(tick):
    return round(tick / TICKS, 4)


def keyed(attr, frames, discrete=False):
    """SMIL <animate> through (tick, value) keyframes. Discrete holds each value until the next key."""
    if frames[0][0] != 0:
        frames = [(0, frames[0][1])] + frames
    if frames[-1][0] != TICKS:
        frames = frames + [(TICKS, frames[-1][1])]
    values = ';'.join(str(v) for _, v in frames)
    times = ';'.join(str(t(k)) for k, _ in frames)
    mode = ' calcMode="discrete"' if discrete else ''
    return f'<animate attributeName="{attr}" values="{values}" keyTimes="{times}" dur="{DUR}" repeatCount="indefinite"{mode}/>'


def moved(frames, discrete=False):
    """SMIL translate through (tick, 'x y') keyframes."""
    if frames[0][0] != 0:
        frames = [(0, frames[0][1])] + frames
    if frames[-1][0] != TICKS:
        frames = frames + [(TICKS, frames[-1][1])]
    values = ';'.join(v for _, v in frames)
    times = ';'.join(str(t(k)) for k, _ in frames)
    mode = ' calcMode="discrete"' if discrete else ''
    return f'<animateTransform attributeName="transform" type="translate" values="{values}" keyTimes="{times}" dur="{DUR}" repeatCount="indefinite"{mode}/>'


def visible(on, off, fade=0):
    """Opacity 0 -> 1 at tick `on`, back to 0 at `off`."""
    if fade:
        return keyed('opacity', [(0, 0), (on, 0), (on + fade, 1), (off - fade, 1), (off, 0)])
    return keyed('opacity', [(0, 0), (on, 1), (off, 0)], discrete=True)


# ---------- sprites ----------
CHARS = {c['id']: c for c in json.loads((ROOT / 'public/assets/characters.json').read_text(encoding='utf-8'))}


def strip(char_id, timeline):
    """timeline: list of (animation, frame index) per tick. Returns (data uri, frame w, h, x offset per tick)."""
    char = CHARS[char_id]
    sheet = Image.open(ROOT / 'public' / char['url'].lstrip('/')).convert('RGBA')
    used = list(dict.fromkeys(timeline))
    fw, fh = char['animations']['idle'][0]['w'], char['animations']['idle'][0]['h']
    out = Image.new('RGBA', (fw * len(used), fh))
    for n, (anim, i) in enumerate(used):
        f = char['animations'][anim][i]
        out.paste(sheet.crop((f['x'], f['y'], f['x'] + f['w'], f['y'] + f['h'])), (n * fw, 0))
    out = out.quantize(colors=128, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
    buf = io.BytesIO()
    out.save(buf, 'PNG', optimize=True)
    uri = 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode()
    return uri, fw, fh, [-used.index(k) * fw for k in timeline]


def loop(anim, n, start, length):
    return [(anim, (start + k) % n) for k in range(length)]


# Choreography in ticks (10 per second). Hits land on the attack's 4th frame.
SWINGS = [('knight', 26, 'ninja', 34, False), ('ninja', 32, 'knight', 50, True),
          ('knight', 38, 'ninja', 34, False), ('knight', 44, 'ninja', 50, True)]
KO_TICK = 47

knight_tl = (loop('idle', 10, 0, 16) + loop('walk', 10, 0, 10) + loop('attack', 5, 0, 5) + loop('idle', 10, 0, 1)
             + loop('idle', 10, 1, 6) + loop('attack', 5, 0, 5) + loop('idle', 10, 7, 1) + loop('attack', 5, 0, 5)
             + loop('idle', 10, 2, 2))
knight_tl += [('cheer', (k // 3) % 2) for k in range(TICKS - len(knight_tl))]
ninja_tl = (loop('idle', 10, 3, 16) + loop('walk', 10, 0, 10) + loop('idle', 10, 0, 6) + loop('attack', 5, 0, 5)
            + loop('idle', 10, 4, 1) + loop('idle', 10, 5, 9))
ninja_tl += loop('ko', 4, 0, 4)
ninja_tl += [('ko', 3)] * (TICKS - len(ninja_tl))
assert len(knight_tl) == TICKS and len(ninja_tl) == TICKS, (len(knight_tl), len(ninja_tl))

K_START, K_MEET, N_START, N_MEET = 170, 404, 790, 556   # feet x


def fighter(char_id, timeline, start, meet, flip, hits_taken):
    uri, fw, fh, offsets = strip(char_id, timeline)
    xs = [(0, f'{start - fw / 2} {FLOOR - fh}'), (16, f'{start - fw / 2} {FLOOR - fh}'),
          (26, f'{meet - fw / 2} {FLOOR - fh}')]
    # knockback: shoved 10 px away from the attacker for 2 ticks on each hit
    away = 10 if flip else -10
    for tick in hits_taken:
        xs += [(tick, f'{meet - fw / 2} {FLOOR - fh}'), (tick + 1, f'{meet - fw / 2 + away} {FLOOR - fh}'),
               (tick + 3, f'{meet - fw / 2} {FLOOR - fh}')]
    xs.sort(key=lambda kv: kv[0])
    flip_attr = f' transform="translate({fw} 0) scale(-1 1)"' if flip else ''
    return (f'<g>{moved(xs)}<ellipse cx="{fw / 2}" cy="{fh}" rx="{fw * 0.32}" ry="5" fill="#000" opacity=".35"/>'
            f'<clipPath id="clip-{char_id}"><rect width="{fw}" height="{fh}"/></clipPath>'
            f'<g{flip_attr}><g clip-path="url(#clip-{char_id})">'
            f'<image href="{uri}" width="{fw * len(set(timeline))}" height="{fh}">'
            f'{moved([(k, f"{o} 0") for k, o in enumerate(offsets)], discrete=True)}'
            f'</image></g></g></g>')


# ---------- scene pieces ----------
def title():
    px, s = 10, 'PIXFRAY'
    x, y = (W - text_width(s, px)) / 2, 22
    d = pixel_path(s, x, y, px)
    out = [f'<clipPath id="title-clip"><path d="{d}"/></clipPath>'
           f'<clipPath id="title-top"><rect x="0" y="{y}" width="{W}" height="{px * 2}"/></clipPath>']
    for depth, color in ((8, '#2e2415'), (4, BORDER_STRONG)):          # blocky extrusion
        out.append(f'<path d="{d}" fill="{color}" transform="translate({depth} {depth})"/>')
    out.append(f'<path d="{d}" fill="{GOLD}"/>')
    out.append(f'<path d="{pixel_path(s, x, y, px)}" fill="{GOLD_HI}" clip-path="url(#title-top)"/>')
    # sheen: a slanted light band sweeps across the letters once per loop
    out.append(f'<g clip-path="url(#title-clip)"><g transform="skewX(-24)">'
               f'<rect y="{y}" width="34" height="{px * 7}" fill="#fff6dd" opacity=".75">'
               f'<animate attributeName="x" values="{x - 120};{x - 120};{x + text_width(s, px) + 160};{x + text_width(s, px) + 160}" keyTimes="0;0.55;0.8;1" dur="{DUR}" repeatCount="indefinite"/></rect>'
               f'<rect y="{y}" width="10" height="{px * 7}" fill="#fff6dd" opacity=".5">'
               f'<animate attributeName="x" values="{x - 80};{x - 80};{x + text_width(s, px) + 200};{x + text_width(s, px) + 200}" keyTimes="0;0.57;0.82;1" dur="{DUR}" repeatCount="indefinite"/></rect>'
               f'</g></g>')
    # a few twinkling pixels on the letters
    for i, (sx, sy, on) in enumerate(((x + 12 * px, y + 10, 8), (x + 30 * px, y + 4 * px, 30), (x + 39 * px, y + 10, 52))):
        out.append(f'<rect x="{sx}" y="{sy}" width="{px / 2}" height="{px / 2}" fill="#fffaf0">'
                   + keyed('opacity', [(0, 0), (on, 0), (on + 2, 1), (on + 5, 0)]) + '</rect>')
    return ''.join(out)


def hp_bar(name, x, align_right, hits):
    w, h, y = 300, 14, 128
    out = [f'<path d="{pixel_path(name, x + (w - text_width(name, 3) if align_right else 0), y - 30, 3)}" fill="{TEXT}"/>',
           f'<rect x="{x - 2}" y="{y - 2}" width="{w + 4}" height="{h + 4}" rx="4" fill="{RAISED}" stroke="{BORDER_STRONG}"/>']
    hp, lag, fill = [(0, w)], [(0, w)], [(0, w)]
    left = w
    for tick, dmg in hits:
        left = max(0, left - dmg * w / 100)
        hp.append((tick, left))
        lag += [(tick + 1, lag[-1][1]), (tick + 6, left)]
    def bar(frames, color, discrete):
        if align_right:   # drains toward the outer edge, so the bar keeps its right end
            xs = [(k, x + w - v) for k, v in frames]
            return (f'<rect y="{y}" height="{h}" rx="2" fill="{color}">{keyed("width", frames, discrete)}'
                    f'{keyed("x", xs, discrete)}</rect>')
        return f'<rect x="{x}" y="{y}" height="{h}" rx="2" fill="{color}">{keyed("width", frames, discrete)}</rect>'
    out.append(bar(lag, NEG, False))
    out.append(bar(hp, POS, True))
    return ''.join(out)


def bubble(s, cx, y, on, off):
    px = 3
    tw = text_width(s, px)
    bx = cx - tw / 2 - 10
    return (f'<g opacity="0">{visible(on, off)}'
            f'<rect x="{bx}" y="{y}" width="{tw + 20}" height="{7 * px + 16}" rx="4" fill="{SURFACE}" stroke="{BORDER_STRONG}"/>'
            f'<path d="M{cx - 5} {y + 7 * px + 16}h10l-5 6z" fill="{SURFACE}" stroke="{BORDER_STRONG}"/>'
            f'<rect x="{cx - 4}" y="{y + 7 * px + 15}" width="8" height="2" fill="{SURFACE}"/>'
            f'<path d="{pixel_path(s, cx - tw / 2, y + 8, px)}" fill="{TEXT}"/></g>')


def popup(s, cx, y, tick, color, px=3):
    tw = text_width(s, px)
    return (f'<g opacity="0">{keyed("opacity", [(0, 0), (tick, 0), (tick + 1, 1), (tick + 4, 1), (tick + 6, 0)])}'
            f'{moved([(0, "0 0"), (tick, "0 0"), (tick + 6, "0 -20")])}'
            f'<path d="{pixel_path(s, cx - tw / 2 + 2, y + 2, px)}" fill="#000" opacity=".5"/>'
            f'<path d="{pixel_path(s, cx - tw / 2, y, px)}" fill="{color}"/></g>')


def spark(cx, cy, tick, big):
    r = 26 if big else 18
    rays = ''.join(f'<rect x="-3" y="{-r}" width="6" height="{r * 0.55}" fill="{GOLD_HI}" transform="rotate({a})"/>'
                   for a in range(0, 360, 45))
    return (f'<g transform="translate({cx} {cy})"><g opacity="0">'
            f'{keyed("opacity", [(0, 0), (tick, 0), (tick + 1, 1), (tick + 3, 0)])}'
            f'<rect x="-7" y="-7" width="14" height="14" fill="#fffaf0" transform="rotate(45)"/>{rays}'
            f'<animateTransform attributeName="transform" type="scale" values="0.4;0.4;1.2;1.5" keyTimes="0;{t(tick)};{t(tick + 1)};{t(tick + 3)}" dur="{DUR}" repeatCount="indefinite"/>'
            f'</g></g>')


def floor():
    out = [f'<rect y="{FLOOR}" width="{W}" height="{H - FLOOR}" fill="{SURFACE}"/>',
           f'<rect y="{FLOOR}" width="{W}" height="2" fill="{BORDER_STRONG}"/>']
    for row, y in enumerate(range(FLOOR + 12, H, 12)):
        out.append(f'<rect y="{y}" width="{W}" height="1" fill="{BORDER}"/>')
        for x in range(-40 + (row % 2) * 60, W, 120):
            out.append(f'<rect x="{x}" y="{y - 11}" width="1" height="11" fill="{BORDER}"/>')
    return ''.join(out)


def crt():
    return (f'<pattern id="scan" width="4" height="3" patternUnits="userSpaceOnUse"><rect width="4" height="1" fill="#000" opacity=".28"/></pattern>'
            f'<rect width="{W}" height="{H}" fill="url(#scan)" pointer-events="none"/>'
            f'<rect width="{W}" height="18" fill="#fff6dd" opacity=".035"><animate attributeName="y" values="-20;{H}" dur="3.6s" repeatCount="indefinite"/></rect>'
            f'<rect width="{W}" height="{H}" fill="#fff6dd" opacity="0">'
            + keyed('opacity', [(0, 0), (SWINGS[1][1] + 3, 0), (SWINGS[1][1] + 4, 0.06), (SWINGS[1][1] + 6, 0),
                                (SWINGS[3][1] + 3, 0), (SWINGS[3][1] + 4, 0.08), (SWINGS[3][1] + 7, 0)]) + '</rect>')


def build():
    hits_on = {'knight': [], 'ninja': []}
    pops = []
    for attacker, tick, target, dmg, crit in SWINGS:
        land = tick + 3
        hits_on[target].append((land, dmg))
        cx = N_MEET if target == 'ninja' else K_MEET
        pops.append(spark(cx + (-14 if target == 'ninja' else 14), FLOOR - 62, land, crit))
        pops.append(popup(('CRIT -' if crit else '-') + str(dmg), cx, FLOOR - 140, land, WARN if crit else NEG))
    win = 'KNIGHT WINS +12 ELO'
    win_px = 4
    shake = []
    for _, tick, _, _, crit in SWINGS:
        if crit:
            land = tick + 3
            shake += [(land, '0 0'), (land + 1, '-5 2'), (land + 2, '4 -2'), (land + 3, '-2 1'), (land + 4, '0 0')]
    shake = moved(shake, discrete=True)

    body = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" '
        f'aria-labelledby="t d"><title id="t">PixFray</title>'
        f'<desc id="d">A knight types !challenge @ninja, the ninja answers !fight, and the two pixel fighters duel: '
        f'hits of 34 and crits of 50 drain their health bars until the ninja is knocked out and the knight wins 12 Elo.</desc>',
        f'<clipPath id="frame"><rect width="{W}" height="{H}" rx="6"/></clipPath><g clip-path="url(#frame)">',
        f'<rect width="{W}" height="{H}" fill="{BG}"/>',
        f'<g>{shake}',
        title(),
        hp_bar('KNIGHT', 60, False, hits_on['knight']),
        hp_bar('NINJA', W - 360, True, hits_on['ninja']),
        floor(),
        bubble('!CHALLENGE @NINJA', K_START, 150, 1, 15),
        bubble('!FIGHT', N_START, 150, 9, 17),
        fighter('knight', knight_tl, K_START, K_MEET, False, [h for h, _ in hits_on['knight']]),
        fighter('ninja', ninja_tl, N_START, N_MEET, True, [h for h, _ in hits_on['ninja']]),
        *pops,
        f'<g opacity="0">{visible(KO_TICK + 3, TICKS - 4, fade=2)}'
        f'<rect x="{(W - text_width(win, win_px)) / 2 - 18}" y="160" width="{text_width(win, win_px) + 36}" height="{7 * win_px + 24}" rx="6" fill="{SURFACE}" stroke="{GOLD}"/>'
        f'<path d="{pixel_path(win, (W - text_width(win, win_px)) / 2, 172, win_px)}" fill="{GOLD}"/></g>',
        '</g>',
        crt(),
        f'<rect width="{W}" height="{H}" fill="{BG}" opacity="0">'
        + keyed('opacity', [(0, 1), (2, 0), (TICKS - 3, 0), (TICKS, 1)]) + '</rect>',
        '</g></svg>',
    ]
    svg = '\n'.join(body) + '\n'
    out = ROOT / 'docs/banner.svg'
    out.write_text(svg, encoding='utf-8', newline='\n')
    print(out.relative_to(ROOT), f'{len(svg.encode()) / 1024:.0f} KB')


if __name__ == '__main__':
    build()
