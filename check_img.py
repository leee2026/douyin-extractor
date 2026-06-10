import json, os, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

path = 'C:/Users/12414/AppData/Local/Temp/xhs_share.html'
with open(path, 'r', encoding='utf-8') as f:
    html = f.read()

idx = html.find('__INITIAL_STATE__')
after = html[html.find('=', idx) + 1:]

depth = 0
in_str = False
esc = False
str_char = ''
open_brace = after.find('{')
end = -1

for i in range(open_brace, len(after)):
    ch = after[i]
    if esc: esc = False; continue
    if ch == '\\': esc = True; continue
    if in_str:
        if ch == str_char: in_str = False
        continue
    if ch in ('"', "'"): in_str = True; str_char = ch; continue
    if ch == '{': depth += 1
    elif ch == '}': depth -= 1
    if depth == 0: end = i; break

json_str = after[open_brace:end+1].replace('undefined', 'null')
data = json.loads(json_str)

# Get note data from correct path
nd = data.get('noteData', {})
note = nd.get('data', {}).get('noteData', {})
if not note:
    note = nd.get('normalNotePreloadData', {})

if note:
    print('=== Note fields ===')
    for k in sorted(note.keys()):
        v = note[k]
        if isinstance(v, dict):
            sub = list(v.keys())[:20]
            print(f'  {k}: dict({sub})')
        elif isinstance(v, list):
            print(f'  {k}: list(len={len(v)})')
        elif isinstance(v, str):
            print(f'  {k}: "{v[:100]}"')
        else:
            print(f'  {k}: {v}')
    print()

    # Show image list in detail
    imgs = note.get('imageList', note.get('image_list', note.get('imagesList', [])))
    if imgs:
        print(f'=== Image List ({len(imgs)} images) ===')
        for i, img in enumerate(imgs[:2]):
            print(f'\nImage {i+1}:')
            for k, v in sorted(img.items()):
                if isinstance(v, str):
                    print(f'  {k}: {v[:200]}')
                elif isinstance(v, (list, dict)):
                    print(f'  {k}: {json.dumps(v, ensure_ascii=False)[:300]}')
                else:
                    print(f'  {k}: {v}')
