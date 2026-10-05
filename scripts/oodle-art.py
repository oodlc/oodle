# Run: python3 scripts/oodle-art.py
# Generates assets/oodle.svg (hero) and assets/oodle-moods.svg (mood sheet).
import os
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets')
INK = '#16323A'
PAL = {
  'teal':   ('#3CC8B4', '#26A493', '#A6EEE3'),
  'amber':  ('#F6B847', '#D9962A', '#FBE0A6'),
  'violet': ('#A88BEB', '#8668D4', '#DCCFFA'),
  'coral':  ('#F27A6B', '#D25B4D', '#FBC4BB'),
}

def eye(cx, cy):
    return (f'<ellipse cx="{cx}" cy="{cy}" rx="11" ry="13" fill="{INK}"/>'
            f'<circle cx="{cx+4}" cy="{cy-5}" r="4.2" fill="#fff"/>'
            f'<circle cx="{cx-3}" cy="{cy+5}" r="1.8" fill="#fff"/>')

def arc_eye(cx, cy):
    return f'<path d="M{cx-10} {cy+4} Q{cx} {cy-10} {cx+10} {cy+4}" fill="none" stroke="{INK}" stroke-width="5" stroke-linecap="round"/>'

def x_eye(cx, cy):
    return (f'<path d="M{cx-8} {cy-8} L{cx+8} {cy+8} M{cx+8} {cy-8} L{cx-8} {cy+8}" '
            f'stroke="{INK}" stroke-width="5" stroke-linecap="round"/>')

def face(mood):
    L, R, Y = 98, 142, 118
    mouth = lambda d, fill='none': f'<path d="{d}" fill="{fill}" stroke="{INK}" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>'
    if mood == 'hello':
        return eye(L, Y) + eye(R, Y) + mouth('M109 140 Q120 151 131 140')
    if mood == 'happy':
        return arc_eye(L, Y) + arc_eye(R, Y) + mouth('M107 137 Q120 137 133 137 Q131 155 120 155 Q109 155 107 137 Z', '#7A2E3B') \
            + '<path d="M113 149 Q120 145 127 149 Q124 154 120 154 Q116 154 113 149 Z" fill="#FF8FA3"/>'
    if mood == 'worried':
        brows = (f'<path d="M86 106 Q96 98 106 97 M154 106 Q144 98 134 97" stroke="{INK}" stroke-width="4.5" stroke-linecap="round"/>')
        drop = '<path d="M172 92 Q178 104 172 110 Q166 104 172 92 Z" fill="#7FD3F5" stroke="' + INK + '" stroke-width="2.5"/>'
        return eye(L, Y + 2) + eye(R, Y + 2) + brows + mouth('M108 150 Q120 140 132 150') + drop
    if mood == 'curious':
        small = f'<circle cx="{R}" cy="{Y}" r="6.5" fill="{INK}"/><circle cx="{R+2}" cy="{Y-2}" r="2" fill="#fff"/>'
        brow = f'<path d="M132 100 Q142 94 152 100" fill="none" stroke="{INK}" stroke-width="4.5" stroke-linecap="round"/>'
        q = f'<text x="166" y="60" font-family="ui-rounded, system-ui, sans-serif" font-size="30" font-weight="800" fill="{PAL['violet'][0]}" stroke="{INK}" stroke-width="2" paint-order="stroke">?</text>'
        return eye(L, Y) + small + brow + mouth('M110 142 Q118 147 130 139') + q
    if mood == 'oops':
        return x_eye(L, Y) + x_eye(R, Y) + mouth('M106 146 Q113 140 120 146 Q127 152 134 146')
    raise ValueError(mood)

def oodle(mood='hello', pal='teal', wave=False, tx=0, ty=0, scale=1.0):
    body, shade, belly = PAL[pal]
    right_arm = ('<path d="M178 132 Q198 112 194 92" fill="none" stroke="{s}" stroke-width="14" stroke-linecap="round"/>'
                 if wave else '<path d="M180 140 Q194 148 192 162" fill="none" stroke="{s}" stroke-width="14" stroke-linecap="round"/>')
    parts = [
        f'<g transform="translate({tx} {ty}) scale({scale})">',
        '<ellipse cx="120" cy="214" rx="58" ry="7" fill="#000" opacity=".12"/>',
        # tail: the ~ from the terminal avatar
        f'<path d="M168 194 C186 198 194 184 206 186 S220 198 230 190" fill="none" stroke="{INK}" stroke-width="17" stroke-linecap="round"/>',
        f'<path d="M168 194 C186 198 194 184 206 186 S220 198 230 190" fill="none" stroke="{body}" stroke-width="10" stroke-linecap="round"/>',
        # noodle curl on top: the ∿
        f'<path d="M120 68 C118 50 98 48 101 34 C104 22 124 24 121 37" fill="none" stroke="{INK}" stroke-width="15" stroke-linecap="round"/>',
        f'<path d="M120 68 C118 50 98 48 101 34 C104 22 124 24 121 37" fill="none" stroke="{body}" stroke-width="8" stroke-linecap="round"/>',
        f'<ellipse cx="99" cy="202" rx="15" ry="10" fill="{shade}" stroke="{INK}" stroke-width="4"/>',
        f'<ellipse cx="141" cy="202" rx="15" ry="10" fill="{shade}" stroke="{INK}" stroke-width="4"/>',
        # arms sit behind the body so only the hands show
        f'<path d="M60 146 Q46 156 50 170" fill="none" stroke="{INK}" stroke-width="20" stroke-linecap="round"/>',
        f'<path d="M60 146 Q46 156 50 170" fill="none" stroke="{shade}" stroke-width="13" stroke-linecap="round"/>',
        right_arm.replace('{s}', INK).replace('stroke-width="14"', 'stroke-width="20"'),
        right_arm.replace('{s}', shade).replace('stroke-width="14"', 'stroke-width="13"'),
        f'<rect x="58" y="64" width="124" height="138" rx="60" fill="{body}" stroke="{INK}" stroke-width="4.5"/>',
        f'<ellipse cx="120" cy="166" rx="42" ry="28" fill="{belly}" opacity=".55"/>',
        f'<path d="M78 86 Q90 72 108 70" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" opacity=".45"/>',
        '<ellipse cx="80" cy="138" rx="10" ry="6" fill="#FF8FA3" opacity=".7"/>',
        '<ellipse cx="160" cy="138" rx="10" ry="6" fill="#FF8FA3" opacity=".7"/>',
        face(mood),
        '</g>',
    ]
    return ''.join(parts)

def svg(w, h, inner, title):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" aria-label="{title}">'
            f'<title>{title}</title>{inner}</svg>\n')

open(os.path.join(OUT, 'oodle.svg'), 'w').write(svg(240, 230, oodle('hello', 'teal', wave=True), 'Oodle, the OODLC mascot, waving'))

moods = [('hello', 'teal', 'hello'), ('happy', 'teal', 'every outcome holds'), ('curious', 'violet', 'something new'),
         ('worried', 'amber', 'blocking'), ('oops', 'coral', 'could not finish')]
cell = 200
inner = ''
for i, (m, p, label) in enumerate(moods):
    x = i * cell
    inner += oodle(m, p, wave=(m == 'hello'), tx=x + 10, ty=0, scale=0.75)
    inner += (f'<text x="{x + cell/2}" y="196" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" '
              f'font-size="14" fill="#7B8A90">{label}</text>')
open(os.path.join(OUT, 'oodle-moods.svg'), 'w').write(svg(cell * len(moods), 206, inner, 'Oodle moods: hello, happy, curious, worried, oops'))
print('ok')
