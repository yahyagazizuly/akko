# Draws the app and tray icons (Akko's head) with Pillow. Run: python3 scripts/icons.py
from PIL import Image, ImageDraw
import os

OUT = os.path.join(os.path.dirname(__file__), "..", "assets")
INK, BG, CLAY = (21, 21, 19, 255), (250, 248, 242, 255), (194, 96, 63, 255)

def head(size, ink, fill, pad=0.08, eyes=None, ss=8):
    S = size * ss
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    p = S * pad
    w = S - 2 * p
    stroke = max(ss * 1.5, S * 0.085)
    # head box (50x34 in the drawing)
    hw, hh = w, w * 0.70
    x0, y0 = p, p + (w - hh) / 2  # just the head, centred
    d.rounded_rectangle([x0, y0, x0 + hw, y0 + hh], radius=hh * 0.38, fill=fill, outline=ink, width=int(stroke))
    ex, ey, erx, ery = hw * 0.17, hh * 0.47, hw * 0.085, hh * 0.15
    for cx in (S / 2 - ex, S / 2 + ex):
        cy = y0 + ey
        d.ellipse([cx - erx, cy - ery, cx + erx, cy + ery], fill=ink)
    # smile
    sy = y0 + hh * 0.72
    d.arc([S / 2 - hw * 0.13, sy - hh * 0.12, S / 2 + hw * 0.13, sy + hh * 0.06], 20, 160, fill=ink, width=int(stroke * 0.7))
    return im.resize((size, size), Image.LANCZOS)

def app_icon(size=1024):
    ss = 2
    S = size * ss
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    m = S * 0.09
    d.rounded_rectangle([m, m, S - m, S - m], radius=S * 0.2, fill=(239, 233, 220, 255))
    h = head(int(S * 0.64), INK, BG, pad=0.02, ss=2)
    im.alpha_composite(h, (int(S * 0.18), int(S * 0.18)))
    return im.resize((size, size), Image.LANCZOS)

os.makedirs(OUT, exist_ok=True)
# macOS menu bar: black template image, the system tints it
for scale, name in ((1, "trayTemplate.png"), (2, "trayTemplate@2x.png")):
    head(18 * scale, (0, 0, 0, 255), (0, 0, 0, 0)).save(os.path.join(OUT, name))
# Windows tray: in colour
head(32, INK, BG).save(os.path.join(OUT, "tray.png"))
head(16, INK, BG).save(os.path.join(OUT, "tray-16.png"))
app_icon().save(os.path.join(OUT, "icon.png"))
print("icons written to", os.path.abspath(OUT))
