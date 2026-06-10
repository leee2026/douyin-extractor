import json, re, os

# Try both paths
for p in ['/tmp/xhs_page.html', os.path.expandvars('${TEMP}/xhs_page.html')]:
    if os.path.exists(p):
        path = p
        break
else:
    print('File not found')
    exit(1)

with open(path, 'r', encoding='utf-8') as f:
    html = f.read()

idx = html.find('__INITIAL_STATE__')
eq = html.find('=', idx)
after = html[eq+1:]

# Brace counting
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

json_str = after[open_brace:end+1]
json_str = json_str.replace('undefined', 'null').replace('NaN', 'null')
data = json.loads(json_str)

def find_note(obj, depth=0):
    if depth > 6: return None
    if isinstance(obj, dict):
        if 'noteId' in obj and ('imageList' in obj or 'video' in obj):
            return obj
        if 'note' in obj:
            r = find_note(obj['note'], depth+1)
            if r: return r
        for k, v in obj.items():
            if isinstance(v, (dict, list)):
                r = find_note(v, depth+1)
                if r: return r
    elif isinstance(obj, list):
        for item in obj:
            r = find_note(item, depth+1)
            if r: return r
    return None

note = find_note(data)
if note:
    print('=== 笔记数据 ===')
    print('title:', note.get('title', '')[:80])
    print('type:', note.get('type', 'normal'))

    imgs = note.get('imageList', note.get('image_list', []))
    if imgs:
        print(f'\n=== 图片列表 ({len(imgs)} 张) ===')
        for i, img in enumerate(imgs[:2]):
            print(f'\n--- 图片 {i+1} ---')
            print('字段:', sorted(img.keys()))
            for k, v in sorted(img.items()):
                if isinstance(v, str) and len(v) > 120:
                    print(f'  {k}: {v[:200]}...')
                elif isinstance(v, (list, dict)):
                    s = json.dumps(v, ensure_ascii=False)
                    print(f'  {k}: {s[:400]}')
                else:
                    print(f'  {k}: {v}')
    else:
        print('无图片列表')
        print('可用字段:', sorted(note.keys()))
else:
    print('未找到笔记数据')
    print('顶层keys:', list(data.keys())[:20])
