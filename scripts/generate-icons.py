import os
import base64
import io
from PIL import Image, ImageDraw, ImageFilter

src_char_path = r'C:\Users\Atho\.gemini\antigravity\brain\eaa5b648-da18-4dcb-9b43-22f370ac7bb7\.user_uploaded\media_1790074571917.png'
char_img = Image.open(src_char_path).convert('RGBA')

# 1. Function to create gradient background + character composite PNG
def make_icon_img(c_top, c_bot, c_glow=None):
    bg = Image.new('RGBA', (1024, 1024), (0, 0, 0, 255))
    draw = ImageDraw.Draw(bg)
    for y in range(1024):
        t = y / 1023.0
        r = int(c_top[0] + (c_bot[0] - c_top[0]) * t)
        g = int(c_top[1] + (c_bot[1] - c_top[1]) * t)
        b = int(c_top[2] + (c_bot[2] - c_top[2]) * t)
        draw.line([(0, y), (1023, y)], fill=(r, g, b, 255))
    if c_glow:
        glow = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
        g_draw = ImageDraw.Draw(glow)
        g_draw.ellipse([(120, 320), (620, 820)], fill=c_glow)
        glow = glow.filter(ImageFilter.GaussianBlur(130))
        bg = Image.alpha_composite(bg, glow)
    return Image.alpha_composite(bg, char_img)

# Save master icon.png & icon.jpg
master_img = make_icon_img((70, 61, 126), (34, 28, 69), (140, 120, 220, 50))
master_img.save('public/icon.png')
master_img.convert('RGB').save('public/icon.jpg', quality=95)
print('Saved public/icon.png and public/icon.jpg')

# 2. Optimized base64 of the character for SVGs
buf = io.BytesIO()
char_img.save(buf, format='PNG', optimize=True)
char_b64 = base64.b64encode(buf.getvalue()).decode('ascii')

themes = {
    'icon.svg':        ('#463d7e', '#221c45', '#9d8df1'),
    'icon-indigo.svg': ('#463d7e', '#221c45', '#9d8df1'),
    'icon-ocean.svg':  ('#1e4a62', '#0f2633', '#38bdf8'),
    'icon-forest.svg': ('#2e563e', '#162e20', '#4ade80'),
    'icon-sunset.svg': ('#6e3c22', '#351c10', '#fb923c'),
    'icon-rose.svg':   ('#6a2834', '#35141a', '#f43f5e'),
}

for fname, (c_top, c_bot, glow) in themes.items():
    svg_content = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <clipPath id="cstl-icon-clip">
      <rect width="1024" height="1024" rx="190" ry="190" />
    </clipPath>
    <linearGradient id="bgGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="{c_top}" />
      <stop offset="100%" stop-color="{c_bot}" />
    </linearGradient>
    <radialGradient id="glowGrad" cx="35%" cy="55%" r="45%">
      <stop offset="0%" stop-color="{glow}" stop-opacity="0.35" />
      <stop offset="100%" stop-color="{glow}" stop-opacity="0" />
    </radialGradient>
  </defs>
  <g clip-path="url(#cstl-icon-clip)">
    <rect width="1024" height="1024" fill="url(#bgGrad)" />
    <rect width="1024" height="1024" fill="url(#glowGrad)" />
    <image href="data:image/png;base64,{char_b64}" width="1024" height="1024" />
  </g>
</svg>'''
    with open(os.path.join('public', fname), 'w', encoding='utf-8') as f:
        f.write(svg_content)
    print('Generated public/' + fname)

# 3. Update Android ic_launcher_background.xml
bg_xml_path = r'src-tauri\gen\android\app\src\main\res\values\ic_launcher_background.xml'
if os.path.exists(bg_xml_path):
    with open(bg_xml_path, 'w', encoding='utf-8') as f:
        f.write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n  <color name="ic_launcher_background">#221c45</color>\n</resources>\n')
    print('Updated ic_launcher_background.xml with #221c45')
