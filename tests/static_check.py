from html.parser import HTMLParser
from pathlib import Path
import re,json,sys
root=Path(__file__).resolve().parents[1]
class Parser(HTMLParser):
 def __init__(self):super().__init__();self.ids=[];self.screen=[];self.scripts=[];self.nav=[]
 def handle_starttag(self,tag,attrs):
  d=dict(attrs)
  if 'id' in d:self.ids.append(d['id'])
  if d.get('data-screen'):self.screen.append(d['data-screen'])
  if tag=='script' and d.get('src'):self.scripts.append(d['src'])
  if d.get('data-view'):self.nav.append(d['data-view'])
p=Parser();p.feed((root/'index.html').read_text());assert len(p.ids)==len(set(p.ids)),'duplicate IDs';assert len(p.screen)>=12 and set(p.screen)==set(p.nav),'Missing navigation screens'
for x in p.scripts:assert (root/x).is_file(),x
src=(root/'src/main.js').read_text();referenced=set(re.findall(r"\$\('([^']+)'\)",src))|set(re.findall(r"el\('([^']+)'\)",src));assert referenced.issubset(p.ids),f'Missing UI IDs: {referenced-set(p.ids)}'
for name in ['core','storage','provider-api','vault','sandbox','zip','labs','image-transform','speech-settings','request-trace','expression-repl','expression-repl-worker','expression-repl-ui','workflow-plan','workflow-supervisor','local-evidence','knowledge-pages','binary-assets','provider-presets','ondevice-readiness','model-request-settings','connection-diagnostics','knowledge','snapshot-diff','review-edits','wasm-policy','wasm-runner','wasm-worker','wasm-ui','docx-text','knowledge-documents']:assert (root/'src'/f'{name}.js').exists()
zip_source=(root/'src/zip.js').read_text();assert 'crc32' in zip_source and 'maxBytes' in zip_source
sandbox=(root/'src/sandbox.js').read_text();assert "worker-src blob:" in sandbox and "connect-src 'none'" in sandbox
vault=(root/'src/vault.js').read_text();assert 'PBKDF2' in vault and 'AES-GCM' in vault and '260000' in vault
# CSS brace balance: a single missing '}' silently swallows the rest of the
# stylesheet in every browser (lab-07 incident, 2026-10-21 — the
# @media(max-width:760px) block lost its closing brace and nothing in this
# suite looked at CSS). Single pass over the original text, braces inside
# comments/strings ignored; reports the unclosed block's header, not just a
# count, so the failure points at the corruption.
assert (root/'sw.js').is_file();assert (root/'provider-guides.js').is_file()
_css=(root/'styles.css').read_text();_ln=[0]*len(_css);_l=1
for _k,_ch in enumerate(_css):
 _ln[_k]=_l
 if _ch=='\n':_l+=1
def _hdr(_idx):
 _j=_idx-1
 while _j>=0 and _css[_j] not in '{};\n':_j-=1
 return _css[_j+1:_idx].strip()[:80]
_st=[];_i=0;_n=len(_css);_mode=None;_q=None;_errs=[]
while _i<_n:
 _c=_css[_i]
 if _mode=='c':
  if _c=='*' and _i+1<_n and _css[_i+1]=='/':_mode=None;_i+=2;continue
  _i+=1;continue
 if _mode=='s':
  if _c=='\\':_i+=2;continue
  if _c==_q:_mode=None
  _i+=1;continue
 if _c=='/' and _i+1<_n and _css[_i+1]=='*':_mode='c';_i+=2;continue
 if _c in '"\'':_mode='s';_q=_c;_i+=1;continue
 if _c=='{':_st.append(_i)
 elif _c=='}':
  if _st:_st.pop()
  else:_errs.append(f"unmatched closing brace at line {_ln[_i]} near '{_hdr(_i)}'")
 _i+=1
for _s in _st:_errs.append(f"unclosed '{{' at line {_ln[_s]} — block header '{_hdr(_s)}'")
assert not _errs,'styles.css brace imbalance: '+'; '.join(_errs)
print('PASS CSS: styles.css braces balanced')
print(f'PASS HTML: {len(p.ids)} unique controls; {len(p.screen)} wired sections; module files, CSP guards, vault encryption and ZIP bounds found')
