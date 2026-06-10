import json, os

path = 'C:/Users/12414/AppData/Local/Temp/xhs_page.html'
if not os.path.exists(path):
    print("File not found:", path)
    exit(1)

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
print('Top-level keys:', list(data.keys()))

# Check noteData
if 'noteData' in data:
    nd = data['noteData']
    print('\n=== noteData ===')
    print('Keys:', list(nd.keys())[:15])

    # Look for note info
    for k in list(nd.keys())[:12]:
        v = nd[k]
        if isinstance(v, dict):
            sub = list(v.keys())[:10]
            print(f'  {k} (dict): {sub}')
        elif isinstance(v, list):
            print(f'  {k} (list, len={len(v)})')
            if v:
                first = v[0]
                if isinstance(first, dict):
                    print(f'    [0] keys: {list(first.keys())[:15]}')
        elif isinstance(v, str):
            print(f'  {k}: "{v[:100]}"')
        else:
            print(f'  {k}: {v}')

# Also check global
if 'global' in data:
    g = data['global']
    print('\n=== global ===')
    for k in list(g.keys())[:10]:
        v = g[k]
        if isinstance(v, dict):
            print(f'  {k} (dict): {list(v.keys())[:10]}')
        elif isinstance(v, list):
            print(f'  {k} (list, len={len(v)})')
        else:
            print(f'  {k}: {str(v)[:100]}')
