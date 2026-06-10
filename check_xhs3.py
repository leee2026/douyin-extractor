import json, os

path = 'C:/Users/12414/AppData/Local/Temp/xhs_share.html'
with open(path, 'r', encoding='utf-8') as f:
    html = f.read()

print(f"HTML size: {len(html)} bytes")

# Check for __INITIAL_STATE__
idx = html.find('__INITIAL_STATE__')
if idx < 0:
    print("No __INITIAL_STATE__ found")
    # Look for other patterns
    for kw in ['noteId', 'imageList', '__NEXT_DATA__', '__NUXT__', 'note_id', 'window.__']:
        i = html.find(kw)
        if i >= 0:
            ctx = html[max(0,i-50):i+150]
            print(f"\nFound '{kw}' at pos {i}:")
            print(ctx[:200])
    exit(0)

after = html[html.find('=', idx) + 1:]

depth = 0
in_str = False
esc = False
str_char = ''
open_brace = after.find('{')
end = -1

for i in range(open_brace, len(after)):
    ch = after[i]
    if esc:
        esc = False
        continue
    if ch == '\\':
        esc = True
        continue
    if in_str:
        if ch == str_char:
            in_str = False
        continue
    if ch in ('"', "'"):
        in_str = True
        str_char = ch
        continue
    if ch == '{':
        depth += 1
    elif ch == '}':
        depth -= 1
        if depth == 0:
            end = i
            break

json_str = after[open_brace:end+1].replace('undefined', 'null')
data = json.loads(json_str)
print(f'Top-level keys: {list(data.keys())}')

# Check noteData
nd = data.get('noteData', {})
if nd:
    print(f'\n=== noteData keys ===')
    for k, v in nd.items():
        if isinstance(v, dict):
            sub = list(v.keys())[:15]
            print(f'  {k}: dict({sub})')
        elif isinstance(v, list):
            print(f'  {k}: list(len={len(v)})')
            if v and len(v) > 0:
                f0 = v[0]
                if isinstance(f0, dict):
                    print(f'    [0] keys: {list(f0.keys())[:20]}')
                    # Check if this is note data
                    if 'noteId' in f0 or 'imageList' in f0 or 'video' in f0 or 'title' in f0:
                        print(f'    >>> THIS LOOKS LIKE NOTE DATA!')
                        for dk in sorted(f0.keys()):
                            dv = f0[dk]
                            if isinstance(dv, str) and len(dv) < 200:
                                print(f'      {dk}: {dv}')
                            elif isinstance(dv, list):
                                print(f'      {dk}: list({len(dv)})')
                                if dv:
                                    f00 = dv[0]
                                    if isinstance(f00, dict):
                                        print(f'        [0]: dict({list(f00.keys())[:15]})')
                            elif isinstance(dv, dict):
                                print(f'      {dk}: dict({list(dv.keys())[:15]})')
        elif isinstance(v, str):
            print(f'  {k}: "{v[:100]}"')
        else:
            print(f'  {k}: {v}')

# Also search all of data for noteId recursively
def find_note_id(obj, path='', depth=0):
    if depth > 5: return
    if isinstance(obj, dict):
        if 'noteId' in obj and 'imageList' in obj:
            print(f'\n=== FOUND NOTE at {path} ===')
            print(f'  title: {obj.get("title", obj.get("displayTitle", ""))[:80]}')
            print(f'  type: {obj.get("type", "normal")}')
            imgs = obj.get('imageList', [])
            if imgs:
                print(f'  images: {len(imgs)}')
                for ik in sorted(imgs[0].keys()):
                    print(f'    img.{ik}: {str(imgs[0][ik])[:150]}')
            return
        for k, v in obj.items():
            find_note_id(v, f'{path}.{k}', depth+1)
    elif isinstance(obj, list):
        for i, item in enumerate(obj):
            find_note_id(item, f'{path}[{i}]', depth+1)

find_note_id(data, 'root')
print("\nDone.")
