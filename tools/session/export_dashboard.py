"""Export the tracker as dashboard JSON: [{id, applied, company, role, status, via}]."""
import json, os, re, sys
root = os.environ.get('CAREER_OPS_ROOT') or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
out = []
for line in open(os.path.join(root, 'data', 'applications.md'), encoding='utf-8'):
    if not re.match(r'\|\s*\d', line):
        continue
    c = [x.strip() for x in line.strip().strip('|').split('|')]
    note = c[8] if len(c) > 8 else ''
    m = re.search(r'via (\w+)', note)
    out.append({'id': int(c[0]), 'applied': c[1], 'company': c[2], 'role': c[3], 'status': c[5], 'via': m.group(1) if m else ''})
json.dump(out, open(sys.argv[1], 'w'), ensure_ascii=False)
from collections import Counter
print(len(out), dict(Counter(r['status'] for r in out)))
