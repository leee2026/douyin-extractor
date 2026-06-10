import json, os

path = 'C:/Users/12414/AppData/Local/Temp/xhs_page.html'
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
nd = data['noteData']

for k in ['data', 'normalNotePreloadData', 'errorNoteData']:
    v = nd.get(k)
    if v is None:
        continue
    print(f'\n=== {k} ===')
    if isinstance(v, dict):
        print(f'Keys ({len(v)}): {list(v.keys())[:20]}')
        if v:
            for sk in list(v.keys())[:8]:
                sv = v[sk]
                if isinstance(sv, dict):
                    print(f'  {sk} -> {list(sv.keys())[:20]}')
                    for ssk in list(sv.keys())[:5]:
                        ssv = sv[ssk]
                        if isinstance(ssv, dict):
                            print(f'    {ssk} -> {list(ssv.keys())[:10]}')
                        elif isinstance(ssv, list):
                            print(f'    {ssk} -> [len={len(ssv)}]')
                            if ssv:
                                f0 = ssv[0]
                                if isinstance(f0, dict):
                                    print(f'      [0] keys: {list(f0.keys())[:20]}')
                        elif isinstance(ssv, str):
                            print(f'    {ssk}: {ssv[:120]}')
                elif isinstance(sv, list):
                    print(f'  {sk} -> [len={len(sv)}]')
                    if sv:
                        f0 = sv[0]
                        if isinstance(f0, dict):
                            print(f'    [0] keys: {list(f0.keys())[:20]}')
                            for dk in list(f0.keys())[:10]:
                                dv = f0[dk]
                                if isinstance(dv, str) and len(dv) > 80:
                                    print(f'      {dk}: {dv[:120]}...')
                                elif isinstance(dv, dict):
                                    print(f'      {dk}: dict({list(dv.keys())[:10]})')
                                else:
                                    print(f'      {dk}: {dv}')
                elif isinstance(sv, str):
                    print(f'  {sk}: {sv[:200]}')
    elif isinstance(v, list):
        print(f'[len={len(v)}]')
        if v:
            f0 = v[0]
            if isinstance(f0, dict):
                print(f'  [0] keys: {list(f0.keys())[:20]}')
