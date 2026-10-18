"""Draw Sumika's own default balloon into site/balloon/sumika/ (BA §9).

usage: python tools/make_default_balloon.py [OUT_DIR]          (default: ../site/balloon/sumika)

It is for the ghosts that bring no balloon of their own. It is made to look like SSP's default balloon "SSPデフォルト+"
(pale blue-to-lavender body with faint horizontal lines, thin navy outline, small rounded corners, small pointed tail),
but every pixel is computed here from shapes and colours: nothing is copied, traced or resampled from SSP's files,
whose readme asks that they not be taken out of SSP and redistributed. What is shared with SSP's balloon are plain
facts that ghosts' layouts depend on: the image names and sizes, the descript.txt geometry (text origin, wrap point,
arrows, markers, communicate box), the text and cursor colours, the height of each tail, and the corner radii
(16 px for the balloons, 9 px for the input boxes, so the silhouettes match SSP's; everything inside them is ours).

How it is drawn (no supersampling): each image is a signed distance field (rounded rectangle, unioned with a tail
polygon whose sides are slightly concave). The distance gives the 1 px outline, the anti-aliased inner edge of the
outline, a 1 px ring just inside it (pale on the lit sides, shaded on the others and on the tail's side), a soft
highlight 2-3 px in on the lit sides, and the outer edge, which is hard: transparency is by colour key (the top-left
pixel, KEY), as in SSP's own balloons, so a pixel is either keyed out or opaque. The light comes from the top and from
the side away from the tail, so the kero-side images (tail on the left) are lit from the top-right.
The input-box captions are drawn with Georgia (C:/Windows/Fonts/georgia.ttf), the "connect" marker with
Bahnschrift SemiBold Condensed (bahnschrift.ttf); both come with Windows 10 and later.

Needs Pillow and numpy. The output is deterministic for a given Pillow/numpy and font files. Re-run
tools/index_site.py after running it, or the site will not see the change.
"""
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'site', 'balloon', 'sumika')
FONTS = os.path.join(os.environ.get('WINDIR', r'C:\Windows'), 'Fonts')
CAPTION_FONT = ('georgia.ttf', 11)      # input-box captions
CAPTION_SPACING = 2.6                   # extra px between their letters
CAPTION_AT = (7, 1)                     # where the first letter is drawn
MARKER_FONT = ('bahnschrift.ttf', 13, 'SemiBold Condensed')     # online marker "connect"

KEY = (255, 0, 255)                     # transparent colour (top-left pixel); never used by the art

# palette
OUTLINE = (42, 66, 126)
FILL_TOP = (217, 229, 255)              # pale blue ...
FILL_BOTTOM = (242, 240, 255)           # ... to lavender
GRADIENT_SPAN = 170                     # px; taller balloons stay pale below that
RULE = 0.97                             # faint horizontal lines: red and green scaled by this ...
RULE_SOFT = 0.45                        # ... the row above by this share of it (a soft 2-row band) ...
RULE_FADE = 0.7                         # ... and both fade by this share towards the bottom of the gradient
RULE_PITCH, RULE_PHASE = 10, 7          # every 10th row, starting at row 7
HIGHLIGHT = (252, 252, 255)             # soft highlight 2-3 px inside the outline, lit sides
RING_LIT = (206, 220, 255)              # 1st px inside the outline, lit sides (thickens the outline a little)
SHADE = (172, 192, 244)                 # 1st px inside the outline, shaded sides and the tail's side
LIGHT = (-0.45, -0.89)                  # direction the light comes from (x right, y down), unit vector; x is
                                        # mirrored for images whose tail is on the left
CAPTION = (104, 110, 128)               # input-box captions
PART = (36, 58, 116)                    # arrows, \![*] marker, online marker
PART_BG = (226, 232, 255)               # what the parts are assumed to sit on (their anti-aliasing blends to it)

# balloon images: name -> (width, height, tail centre row); even = placed left of the character (tail on the right)
BALLOONS = {
    'balloons0': (335, 169, 66), 'balloons1': (335, 169, 66),
    'balloons2': (335, 384, 281), 'balloons3': (335, 384, 281),
    'balloonk0': (335, 96, 50), 'balloonk1': (335, 96, 50),
    'balloonk2': (335, 169, 123), 'balloonk3': (335, 169, 123),
}
BODY_INSET = 9          # body spans x 9..325; the tail reaches the image edge (x 334 or 0)
RADIUS = 16.0
TAIL_HALF = 6.0         # half the tail's height where it leaves the body
TAIL_BOW = 1.6          # how far its sides bow in towards the centre line
# input boxes (UKADOC manual_balloon: 0 Send, 1 Communicate, 2 Teach, 3 Input)
BOXES = {'balloonc0': 'Send', 'balloonc1': 'Communicate', 'balloonc2': 'Teach', 'balloonc3': 'Input'}
BOX_SIZE, BOX_RADIUS = (317, 42), 9.0
BOX_FIELD_TOP = 18      # communicatebox.y: the fill is flat from here down, as the runtime fills the field with it
BOX_RULE_ROW = 14       # one faint line between the caption and the field

DESCRIPT = [
    ('charset', 'UTF-8'),
    ('type', 'balloon'),
    ('name', 'Sumika'),
    ('craftman', 'Sumika'),
    ('craftmanw', 'Sumika'),
    ('', ''),
    # text area and wrap point as in SSPデフォルト+: origin (23,14), line limit 335 - 25 - 23 = 287 px
    ('validrect.left', '23'), ('validrect.top', '14'), ('validrect.right', '-23'), ('validrect.bottom', '-12'),
    ('wordwrappoint.x', '-25'),
    ('', ''),
    ('font.height', '12'),
    ('font.color.r', '84'), ('font.color.g', '32'), ('font.color.b', '27'),
    ('font.shadowcolor.r', '195'), ('font.shadowcolor.g', '195'), ('font.shadowcolor.b', '239'),
    ('', ''),
    ('anchor.font.color.r', '77'), ('anchor.font.color.g', '82'), ('anchor.font.color.b', '194'),
    ('anchor.pen.color.r', '0'), ('anchor.pen.color.g', '0'), ('anchor.pen.color.b', '255'),
    ('', ''),
    ('cursor.blendmethod', 'notmaskpen'),
    ('cursor.style', 'square'),
    ('cursor.brush.color.r', '150'), ('cursor.brush.color.g', '100'), ('cursor.brush.color.b', '100'),
    ('cursor.pen.color.r', '84'), ('cursor.pen.color.g', '32'), ('cursor.pen.color.b', '27'),
    ('cursor.font.color.r', '0'), ('cursor.font.color.g', '0'), ('cursor.font.color.b', '0'),
    ('', ''),
    ('number.font.height', '10'),
    ('number.font.color.r', '0'), ('number.font.color.g', '0'), ('number.font.color.b', '0'),
    ('number.xr', '-28'), ('number.y', '-20'),
    ('', ''),
    ('onlinemarker.x', '17'), ('onlinemarker.y', '-22'),
    ('sstpmarker.x', '17'), ('sstpmarker.y', '-18'),
    ('sstpmessage.x', '29'), ('sstpmessage.y', '-20'),
    ('sstpmessage.font.height', '10'),
    ('', ''),
    ('arrow0.x', '-20'), ('arrow0.y', '8'),
    ('arrow1.x', '-20'), ('arrow1.y', '-18'),
    ('', ''),
    ('communicatebox.x', '8'), ('communicatebox.y', '18'),
    ('communicatebox.width', '301'), ('communicatebox.height', '18'),
]

README = """Sumika default balloon
======================

The balloon Sumika uses for ghosts that bring no balloon of their own.

It is original art, drawn by a script (tools/make_default_balloon.py in the Sumika project) from shapes and
colours. It is made to look like SSP's default balloon, but contains none of its images: nothing was copied, traced
or resampled from them. Only plain layout facts are shared with it (image sizes, corner radii, text area, wrap
point, arrow and marker positions, text and cursor colours), so ghosts tuned for SSP's balloon lay out the same in
this one.

It is free to redistribute with Sumika.

Files: balloons0-3 (\\0), balloonk0-3 (\\1 and others), balloonc0-3 (Send, Communicate, Teach and Input boxes),
arrow0/arrow1 (scroll up/down), sstp.png (the \\![*] marker), online0-3 and online.png ("connect" animation).
Transparency: the colour of each image's top-left pixel.
"""


# ---------------------------------------------------------------------------------------------- distance fields

def grid(w, h):
    """pixel-centre coordinates (pixel i covers [i, i+1))"""
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float64)
    return xs + 0.5, ys + 0.5


def sd_round_rect(px, py, x0, y0, x1, y1, r):
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    qx = np.abs(px - cx) - ((x1 - x0) / 2 - r)
    qy = np.abs(py - cy) - ((y1 - y0) / 2 - r)
    return np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) + np.minimum(np.maximum(qx, qy), 0) - r


def sd_polygon(px, py, pts):
    d2 = np.full(px.shape, np.inf)
    inside = np.zeros(px.shape, dtype=bool)
    n = len(pts)
    for i in range(n):
        (ax, ay), (bx, by) = pts[i], pts[(i + 1) % n]
        ex, ey = bx - ax, by - ay
        wx, wy = px - ax, py - ay
        t = np.clip((wx * ex + wy * ey) / (ex * ex + ey * ey), 0, 1)
        d2 = np.minimum(d2, (wx - ex * t) ** 2 + (wy - ey * t) ** 2)
        if ay != by:
            crosses = (ay > py) != (by > py)
            inside ^= crosses & (px < ax + ex * (py - ay) / ey)
    d = np.sqrt(d2)
    return np.where(inside, -d, d)


def bezier(p0, c, p1, steps=12):
    return [((1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * c[0] + t * t * p1[0],
             (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * c[1] + t * t * p1[1])
            for t in (i / steps for i in range(steps + 1))]


def tail_polygon(w, cy, right):
    """Tail on the right edge (right=True) or the left edge; its tip is the image's outermost pixel column."""
    y = cy + 0.5
    edge = w - BODY_INSET if right else BODY_INSET          # outer edge of the body's outline
    tip = w + 0.1 if right else -0.1
    s = 1 if right else -1
    root = edge - s * 6                                     # start well inside the body: the union hides it
    top = bezier((edge - s * 0.5, y - TAIL_HALF), (edge + s * 4.5, y - TAIL_BOW), (tip, y))
    bottom = [(x, 2 * y - yy) for x, yy in reversed(top)]
    return [(root, y - TAIL_HALF)] + top + bottom[1:] + [(root, y + TAIL_HALF)]


def coverage(d):
    return np.clip(0.5 - d, 0, 1)


def mix(a, b, t):
    """a + (b - a) * t for colour arrays (..., 3); t broadcasts"""
    return a + (np.asarray(b, dtype=np.float64) - a) * t[..., None]


# ---------------------------------------------------------------------------------------------- painting

def body_fill(w, h, top, bottom, flat_from=None, rules=True):
    """Vertical gradient (eased), optional faint horizontal lines. Returns (h, w, 3) float."""
    y = np.arange(h, dtype=np.float64) + 0.5
    span = flat_from if flat_from else min(h, GRADIENT_SPAN)
    t = np.clip(y / span, 0, 1)
    t = 1 - (1 - t) ** 1.6                                   # eases out: pales quickly below the top
    col = np.asarray(top, np.float64) + (np.asarray(bottom, np.float64) - np.asarray(top, np.float64)) * t[:, None]
    if rules:
        rows = np.arange(h) % RULE_PITCH
        fade = 1 - RULE_FADE * t                            # the lines all but vanish towards the bottom
        for phase, share in ((RULE_PHASE, 1.0), ((RULE_PHASE - 1) % RULE_PITCH, RULE_SOFT)):
            ruled = rows == phase
            k = 1 - (1 - RULE) * share * fade[ruled]
            col[ruled, 0] *= k
            col[ruled, 1] *= k
    return np.broadcast_to(col[:, None, :], (h, w, 3)).copy()


def shade_shape(d, fill, tail=None):
    """Outline, inner ring, highlight and colour key from a distance field and the fill colours.
    tail: 'right', 'left' or None (no tail). Returns an RGB uint8 array."""
    cov = coverage(d)                       # inside the shape
    inner = coverage(d + 1.0)               # inside the 1 px outline
    ring = coverage(d + 2.0)                # inside the 1 px ring
    ring2 = coverage(d + 3.0)               # inside the highlight's bright pixel
    glow = coverage(d + 4.5)                # inside its softer 1.5 px fall-off
    gy, gx = np.gradient(d)
    n = np.hypot(gx, gy) + 1e-9
    lx = -LIGHT[0] if tail == 'left' else LIGHT[0]          # lit from the side away from the tail
    lit = (gx * lx + gy * LIGHT[1]) / n                      # +1 facing the light, -1 facing away
    light = np.clip(0.35 + 0.65 * lit, 0, 1)                 # sides still catch some light
    dark = np.clip((0.1 - lit) / 0.8, 0, 1)
    if tail:                                                 # the tail's whole side is in shade, tail included
        side = np.clip((gx if tail == 'right' else -gx) / n, 0, 1)
        dark = np.maximum(dark, side)
        light = light * (1 - side)
    first = inner - ring                                     # 1st px inside the outline
    bright = (ring - ring2) + (ring2 - glow) * 0.4           # 2nd px, fading over the next 1.5
    col = fill.copy()
    col = mix(col, RING_LIT, first * (1 - dark) * 0.55)
    col = mix(col, SHADE, first * dark * 0.95)
    col = mix(col, HIGHLIGHT, bright * light * 0.85)
    # outline over the fill: weight = the part of the pixel that is outline rather than inside it
    edge = np.where(cov > 0, (cov - inner) / np.maximum(cov, 1e-9), 0)
    col = mix(col, OUTLINE, edge)
    out = np.clip(np.rint(col), 0, 255).astype(np.uint8)
    out[cov < 0.5] = KEY
    return out


def balloon_image(w, h, tail_row, right):
    px, py = grid(w, h)
    d = sd_round_rect(px, py, BODY_INSET, 0, w - BODY_INSET, h, RADIUS)
    d = np.minimum(d, sd_polygon(px, py, tail_polygon(w, tail_row, right)))
    fill = body_fill(w, h, FILL_TOP, FILL_BOTTOM)
    return Image.fromarray(shade_shape(d, fill, 'right' if right else 'left'), 'RGB')


def font(spec):
    f = ImageFont.truetype(os.path.join(FONTS, spec[0]), spec[1])
    if len(spec) > 2:
        f.set_variation_by_name(spec[2])
    return f


def box_image(caption):
    w, h = BOX_SIZE
    px, py = grid(w, h)
    d = sd_round_rect(px, py, 0, 0, w, h, BOX_RADIUS)
    # a gentler gradient that stops at the field: the runtime paints the field with the colour at its centre
    fill = body_fill(w, h, (214, 226, 255), (224, 230, 255), flat_from=BOX_FIELD_TOP, rules=False)
    fill[BOX_RULE_ROW, :, :2] *= RULE                       # one faint line between the caption and the field
    img = Image.fromarray(shade_shape(d, fill), 'RGB')
    draw = ImageDraw.Draw(img)
    f = font(CAPTION_FONT)
    for i, ch in enumerate(caption):                        # letter-spaced, as small captions read better that way
        x = CAPTION_AT[0] + round(f.getlength(caption[:i]) + i * CAPTION_SPACING)
        draw.text((x, CAPTION_AT[1]), ch, font=f, fill=CAPTION)
    return img


def part_image(w, h, d, bg=PART_BG, colour=PART, gloss=None):
    """Small keyed part: anti-aliased against the balloon colour it sits on, keyed where (almost) uncovered."""
    cov = coverage(d)
    col = mix(np.broadcast_to(np.asarray(bg, np.float64), (h, w, 3)).copy(), colour, cov)
    if gloss is not None:
        col = mix(col, (150, 176, 238), gloss)
    out = np.clip(np.rint(col), 0, 255).astype(np.uint8)
    out[cov < 0.25] = KEY
    return Image.fromarray(out, 'RGB')


def arrow_image(up):
    px, py = grid(8, 8)
    pts = [(4.0, 1.0), (7.0, 6.5), (1.0, 6.5)] if up else [(1.0, 1.5), (7.0, 1.5), (4.0, 7.0)]
    return part_image(8, 8, sd_polygon(px, py, pts))


def marker_image():
    """\\![*] marker (sstp.png): a small navy diamond with a lighter facet."""
    px, py = grid(8, 8)
    d = sd_polygon(px, py, [(4.0, 0.7), (7.3, 4.0), (4.0, 7.3), (0.7, 4.0)])
    facet = sd_polygon(px, py, [(3.4, 2.0), (4.4, 3.0), (3.4, 4.0), (2.4, 3.0)])
    return part_image(8, 8, d, gloss=coverage(facet) * 0.5)


def online_image(dots):
    """'connect' and 0-3 growing dots (online0..3), 48×14."""
    w, h = 48, 14
    m = Image.new('L', (w, h), 0)
    draw = ImageDraw.Draw(m)
    f = font(MARKER_FONT)
    top, bottom = f.getbbox('connect')[1::2]
    y = (h - (bottom - top)) // 2 - top                     # centred vertically
    draw.text((1, y), 'connect', font=f, fill=255)
    x = 1 + round(f.getlength('connect')) + 2
    base = y + bottom - 2                                   # dots sit on the baseline
    for i in range(dots):
        draw.rectangle([x + i * 4, base, x + i * 4 + 1, base + 1], fill=255)
    cov = np.asarray(m, np.float64) / 255
    col = mix(np.broadcast_to(np.asarray(PART_BG, np.float64), (h, w, 3)).copy(), PART, cov)
    out = np.clip(np.rint(col), 0, 255).astype(np.uint8)
    out[cov < 0.16] = KEY
    return Image.fromarray(out, 'RGB')


# ---------------------------------------------------------------------------------------------- output

def check_keyed(name, img):
    a = np.asarray(img)
    if tuple(a[0, 0]) != KEY:
        raise SystemExit(f'{name}: top-left pixel is not the key colour')


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    out = os.path.abspath(argv[0] if argv else OUT)
    os.makedirs(out, exist_ok=True)
    images = {}
    for name, (w, h, tail) in BALLOONS.items():
        images[name] = balloon_image(w, h, tail, right=int(name[-1]) % 2 == 0)
    for name, caption in BOXES.items():
        images[name] = box_image(caption)
    images['arrow0'] = arrow_image(True)
    images['arrow1'] = arrow_image(False)
    images['sstp'] = marker_image()
    for i in range(4):
        images[f'online{i}'] = online_image(i)
    images['online'] = online_image(3)                      # the old single-frame name
    for name, img in images.items():
        check_keyed(name, img)
        img.save(os.path.join(out, name + '.png'), optimize=True)
    with open(os.path.join(out, 'descript.txt'), 'w', encoding='utf-8', newline='\r\n') as fh:
        for k, v in DESCRIPT:
            fh.write(f'{k},{v}\n' if k else '\n')
    with open(os.path.join(out, 'readme.txt'), 'w', encoding='utf-8', newline='\r\n') as fh:
        fh.write(README)
    print(f'wrote {len(images)} images, descript.txt and readme.txt -> {out}')


if __name__ == '__main__':
    main()
