"""Draws the three logo candidates shown to the user. Raster only - the chosen one becomes
an SVG in lib/views.js, which is what the site actually renders."""
import math
from PIL import Image, ImageDraw

S = 3                 # supersample
SIZE = 480
BG_TOP = (59, 130, 246)
BG_BOTTOM = (30, 64, 175)
WHITE = (248, 250, 252, 255)
SOFT = (219, 234, 254, 255)
ACCENT = (147, 197, 253, 255)
DEEP = (30, 64, 175, 255)
PINK = (244, 114, 182, 255)


def gradient(size):
    strip = Image.new('RGB', (1, size))
    for y in range(size):
        t = y / max(1, size - 1)
        strip.putpixel((0, y), tuple(int(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3)))
    return strip.resize((size, size))


def tile():
    img = gradient(SIZE).convert('RGBA')
    mask = Image.new('L', (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=96, fill=255)
    img.putalpha(mask)
    return img


def canvas():
    return Image.new('RGBA', (SIZE * S, SIZE * S), (0, 0, 0, 0))


def finish(mark, background):
    mark = mark.resize((SIZE, SIZE), Image.LANCZOS)
    out = Image.alpha_composite(background, mark)
    return out


def heart(d, cx, cy, w, fill):
    r = w / 4
    d.ellipse([cx - 2 * r, cy - r, cx, cy + r], fill=fill)
    d.ellipse([cx, cy - r, cx + 2 * r, cy + r], fill=fill)
    d.polygon([(cx - 2 * r, cy + r * 0.55), (cx + 2 * r, cy + r * 0.55), (cx, cy + 2.1 * r)], fill=fill)


def gift_box(d, cx, cy, w, h, ribbon=True, bow=True):
    body = [cx - w / 2, cy, cx + w / 2, cy + h]
    lid = [cx - w * 0.58, cy - h * 0.28, cx + w * 0.58, cy + h * 0.04]
    d.rounded_rectangle(body, radius=h * 0.12, fill=WHITE)
    d.rounded_rectangle(lid, radius=h * 0.12, fill=WHITE)
    d.rounded_rectangle([lid[0] + 4, lid[3] - h * 0.11, lid[2] - 4, lid[3]], radius=h * 0.06, fill=SOFT)
    if ribbon:
        d.rectangle([cx - w * 0.09, lid[1] + 2, cx + w * 0.09, body[3]], fill=ACCENT)
    if bow:
        top = lid[1] - h * 0.30
        d.ellipse([cx - w * 0.26, top, cx - w * 0.02, top + h * 0.34], fill=ACCENT)
        d.ellipse([cx + w * 0.02, top, cx + w * 0.26, top + h * 0.34], fill=ACCENT)
        d.ellipse([cx - w * 0.08, top + h * 0.20, cx + w * 0.08, top + h * 0.38], fill=DEEP)


# ---------------------------------------------------------------- A: the gift
a = canvas()
da = ImageDraw.Draw(a)
gift_box(da, SIZE * S / 2, SIZE * S * 0.44, SIZE * S * 0.42, SIZE * S * 0.34)
finish(a, tile()).save('artifacts/logo-a-gift.png')

# ------------------------------------------------- B: opened, heart coming out
b = canvas()
db = ImageDraw.Draw(b)
cx, cy = SIZE * S / 2, SIZE * S * 0.46
w, h = SIZE * S * 0.40, SIZE * S * 0.30
db.polygon([(cx - w / 2, cy), (cx + w / 2, cy), (cx + w * 0.40, cy + h * 1.15), (cx - w * 0.40, cy + h * 1.15)], fill=WHITE)
db.polygon([(cx - w * 0.42, cy), (cx + w * 0.42, cy), (cx + w * 0.34, cy + h * 0.22), (cx - w * 0.34, cy + h * 0.22)], fill=DEEP)
db.polygon([(cx - w / 2, cy), (cx - w * 0.92, cy - h * 0.46), (cx - w * 0.28, cy - h * 0.46), (cx - w * 0.10, cy)], fill=SOFT)
db.polygon([(cx + w / 2, cy), (cx + w * 0.92, cy - h * 0.46), (cx + w * 0.28, cy - h * 0.46), (cx + w * 0.10, cy)], fill=SOFT)
heart(db, cx, cy - h * 0.72, w * 0.40, PINK)
finish(b, tile()).save('artifacts/logo-b-open-heart.png')

# --------------------------------------------------- C: two arrows round a gift
c = canvas()
dc = ImageDraw.Draw(c)
cx, cy = SIZE * S / 2, SIZE * S / 2
r = SIZE * S * 0.36
for start, end in ((196, 344), (16, 164)):
    dc.arc([cx - r, cy - r, cx + r, cy + r], start=start, end=end, fill=ACCENT, width=int(SIZE * S * 0.05))
    t = math.radians(end)
    tip = (cx + r * math.cos(t), cy + r * math.sin(t))
    tangent = math.atan2(math.cos(t), -math.sin(t))
    length, half = SIZE * S * 0.075, SIZE * S * 0.045
    left = (tip[0] - length * math.cos(tangent) + half * math.sin(tangent),
            tip[1] - length * math.sin(tangent) - half * math.cos(tangent))
    right = (tip[0] - length * math.cos(tangent) - half * math.sin(tangent),
             tip[1] - length * math.sin(tangent) + half * math.cos(tangent))
    dc.polygon([tip, left, right], fill=ACCENT)
gift_box(dc, cx, cy - SIZE * S * 0.05, SIZE * S * 0.30, SIZE * S * 0.22)
finish(c, tile()).save('artifacts/logo-c-share-cycle.png')

print('wrote three candidates')
