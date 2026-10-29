"""Broad interactive end-to-end site QA. No real credentials in source or test output.
Run with --base-url on actual Chromium runner. Each case uses a fresh browser profile.
Synthetic provider responses are NOT proof of real provider connectivity.
"""
import argparse,base64,io,json,os,sys,traceback,zipfile,zlib,struct
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

PASS=[]
FAIL=[]
SKIP=[]
def verify(test, message):
    if not test: raise AssertionError(message)
def screen(p,name):
    p.locator('[data-view="'+name+'"]').first.click()
    verify(p.locator('[data-screen="'+name+'"]').is_visible(),'Screen did not open: '+name)
def approve(p,text=''):
    p.once('dialog',lambda d:d.accept(text))
def fake_groq(route):
    if route.request.method=='OPTIONS':
        route.fulfill(status=204,headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'POST, OPTIONS'})
    else:
        route.fulfill(status=200,headers={'Content-Type':'application/json','Access-Control-Allow-Origin':'*'},
            body=json.dumps({'model':'llama-3.1-8b-instant','choices':[{'message':{'role':'assistant','content':'SYNTHETIC ACCEPTANCE RESPONSE'}}],
            'usage':{'prompt_tokens':6,'completion_tokens':5,'total_tokens':11}}))
def mock_provider(p):
    p.route('https://api.groq.com/**',fake_groq)
def setup_vault(p):
    screen(p,'vault')
    verify(p.locator('#key-value').is_enabled(),'Cannot type key before vault initialization')
    p.locator('#vault-password').fill('test-only-vault-passphrase-2026')
    p.locator('#vault-submit').click()
    p.wait_for_function("document.querySelector('#vault-status').textContent === 'UNLOCKED'",timeout=15000)
    p.locator('#key-provider').select_option('groq')
    p.locator('#key-model').fill('llama-3.1-8b-instant')
    p.locator('#key-value').fill('TEST-FAKE-NOT-A-REAL-API-KEY')
    p.locator('#key-attest').check()
    p.locator('#save-key').click()
    p.wait_for_function("document.querySelector('#vault-items').textContent.includes('GroqCloud')",timeout=15000)
def check_navigation(p):
    for name in ['overview','workspace','chat','workflows','knowledge','datalab','media','providers','vault','usage','capabilities','settings']:
        screen(p,name)
        verify(p.locator('#current-view-label').inner_text().strip(),'Current-view label missing')
    screen(p,'overview')
    p.locator('#global-command').click()
    verify(p.locator('#command-dialog').is_visible(),'Command palette did not open')
    p.locator('#command-close').click()
    verify(not p.locator('#command-dialog').is_visible(),'Command palette did not close')
    p.keyboard.press('Control+k')
    verify(p.locator('#command-dialog').is_visible(),'Ctrl+K failed')
    p.keyboard.press('Escape')
    verify(not p.locator('#command-dialog').is_visible(),'Escape palette failed')
def check_workspace(p):
    screen(p,'workspace')
    verify(p.locator('#code-editor').is_editable(),'Code editor is not editable')
    p.locator('#code-editor').fill('console.log("QA_EXECUTE_812");')
    p.locator('#run-code').click()
    p.wait_for_function("document.querySelector('#console-output').textContent.includes('QA_EXECUTE_812')",timeout=10000)
    p.locator('#clear-console').click()
    verify(not p.locator('#console-output').inner_text().strip(),'Clear execution log failed')
    p.locator('#code-editor').fill('while(true){}')
    p.locator('#run-code').click()
    p.locator('#stop-code').click()
    verify(not p.locator('#stop-code').is_enabled(),'Stop runner remained enabled')
    approve(p,'QA Workspace Project')
    p.locator('#new-project').click()
    verify('QA Workspace Project' in p.locator('#stat-project').inner_text(),'New project failed')
    approve(p,'QA Workspace Renamed')
    p.locator('#rename-project').click()
    verify('QA Workspace Renamed' in p.locator('#stat-project').inner_text(),'Rename project failed')
    approve(p,'src/qa_file.js')
    p.locator('#add-file').click()
    verify(p.locator('#active-file').inner_text()=='src/qa_file.js','Create nested file failed')
    p.locator('#code-editor').fill('console.log("SAVED_QA_FILE");')
    approve(p,'src/qa_renamed.js')
    p.locator('#rename-file').click()
    verify(p.locator('#active-file').inner_text()=='src/qa_renamed.js','Rename file failed')
    approve(p,'QA snapshot')
    p.locator('#snapshot-project').click()
    p.locator('#code-editor').fill('console.log("AFTER_SNAPSHOT");')
    p.locator('#snapshot-select').select_option(index=1)
    approve(p)
    p.locator('#restore-snapshot').click()
    verify('SAVED_QA_FILE' in p.locator('#code-editor').input_value(),'Snapshot restore failed')
    with p.expect_download() as obj:p.locator('#export-json').click()
    project=json.loads(Path(obj.value.path()).read_text())
    verify('src/qa_renamed.js' in project['files'],'Project JSON missing active source')
    with p.expect_download() as obj:p.locator('#export-zip').click()
    data=Path(obj.value.path()).read_bytes()
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        verify('src/qa_renamed.js' in z.namelist(),'ZIP export missing nested source')
    approve(p)
    p.locator('#import-project').set_input_files({'name':'qa-import.json','mimeType':'application/json','buffer':json.dumps(project).encode()})
    p.wait_for_function("document.querySelector('#stat-project').textContent.includes('qa-import')",timeout=10000)
    p.locator('#add-local-files').set_input_files({'name':'qa-imported.txt','mimeType':'text/plain','buffer':b'local-file-content'})
    p.locator('#file-tree .file-entry[title="qa-imported.txt"]').click()
    verify(p.locator('#code-editor').input_value()=='local-file-content','Local text import failed')
    approve(p)
    p.locator('#delete-file').click()
    verify(p.locator('#file-tree .file-entry[title="qa-imported.txt"]').count()==0,'Delete file failed')
    approve(p)
    p.locator('#delete-project').click()
    verify('qa-import' not in p.locator('#stat-project').inner_text(),'Delete project failed')
def check_folder_management(p):
    screen(p,'workspace')
    approve(p,'src/lib/a.js')
    p.locator('#add-file').click()
    p.locator('#code-editor').fill('console.log("folder A");')
    approve(p,'src/lib/b.js')
    p.locator('#add-file').click()
    p.locator('#code-editor').fill('console.log("folder B");')
    verify(p.locator('#file-tree .folder-entry[title="src/lib"]').count()==1,'P13 nested folder header missing')
    verify(p.locator('#file-tree .file-entry[title="src/lib/b.js"]').count()==1,'P13 nested file missing')
    replies=iter(['src/lib','packages/tools',''])
    def dialog_handler(dialog):dialog.accept(next(replies,''))
    p.on('dialog',dialog_handler)
    p.locator('#move-folder').click()
    verify(p.locator('#file-tree .file-entry[title="packages/tools/a.js"]').count()==1,'P13 folder move lost file A')
    verify(p.locator('#file-tree .file-entry[title="packages/tools/b.js"]').count()==1,'P13 folder move lost file B')
    verify('packages/tools/b.js' in p.locator('#active-file').inner_text(),'P13 active file did not follow folder move')
    verify(p.locator('#file-tree .file-entry[title="src/lib/a.js"]').count()==0,'P13 old folder still contains moved file')
    with p.expect_download() as saved:p.locator('#export-json').click()
    project=json.loads(Path(saved.value.path()).read_text())
    verify(project['files']['packages/tools/b.js']=='console.log("folder B");','P13 move damaged file bytes')

def check_snapshot_management(p):
    screen(p,'workspace')
    current=p.locator('#active-file').inner_text()
    p.locator('#code-editor').fill('SNAPSHOT_BASELINE')
    approve(p,'QA initial checkpoint')
    p.locator('#snapshot-project').click()
    verify(p.locator('#snapshot-select').input_value()!='','P23 new snapshot not selected')
    p.locator('#code-editor').fill('SNAPSHOT_MODIFIED')
    p.locator('#snapshot-action').select_option('compare')
    p.locator('#snapshot-action-run').click()
    verify(current in p.locator('#snapshot-comparison').inner_text(),'P23 modified file not in comparison')
    verify('Modified since snapshot (1)' in p.locator('#snapshot-comparison').inner_text(),'P23 comparison counts incorrect')
    p.locator('#snapshot-action').select_option('pin')
    p.locator('#snapshot-action-run').click()
    verify('Unpin snapshot' in p.locator('#snapshot-action').inner_text(),'P23 pin state not retained')
    p.locator('#snapshot-action').select_option('rename')
    approve(p,'QA revised checkpoint')
    p.locator('#snapshot-action-run').click()
    verify('QA revised checkpoint' in p.locator('#snapshot-select').inner_text(),'P23 rename failed')
    p.locator('#snapshot-action').select_option('export')
    with p.expect_download() as saved:p.locator('#snapshot-action-run').click()
    payload=json.loads(Path(saved.value.path()).read_text())
    verify(payload['format']=='mm-platform-snapshot-v1','P23 export format invalid')
    verify(payload['files'][current]=='SNAPSHOT_BASELINE','P23 export did not preserve original file bytes')
    p.locator('#snapshot-action').select_option('delete')
    approve(p)
    p.locator('#snapshot-action-run').click()
    verify(p.locator('#snapshot-select option').count()==1,'P23 snapshot deletion failed')
    verify('SNAPSHOT_MODIFIED' in p.locator('#code-editor').input_value(),'P23 deletion altered active project')
    verify(p.locator('#snapshot-action-run').is_disabled(),'P23 management must require selection')

def check_html_preview(p):
    screen(p,'workspace')
    p.locator('#file-tree .file-entry[title="index.html"]').click()
    p.locator('#preview-page').click()
    expect(p.frame_locator('#preview-host iframe').get_by_text('Hello from the browser workbench!')).to_have_count(1,timeout=12000)
    p.locator('#show-console').click()
    verify(p.locator('#console-pane').is_visible(),'Console tab failed')
    p.locator('#show-preview').click()
    verify(p.locator('#preview-pane').is_visible(),'Preview tab failed')
def check_linked_preview(p):
    screen(p,'workspace')
    def add(name,source):
        approve(p,name)
        p.locator('#add-file').click()
        p.locator('#code-editor').fill(source)
    add('assets/helper.js','window.LINKED_PREVIEW_VALUE = "RESOLVED";')
    add('assets/finish.js','document.querySelector("#linked-result").textContent = window.LINKED_PREVIEW_VALUE;')
    add('styles/linked.css','#linked-result { color: rgb(7, 8, 9); }')
    add('unused.js','throw Error("UNREFERENCED_JS_SHOULD_NOT_RUN");')
    p.locator('#file-tree .file-entry[title="index.html"]').click()
    p.locator('#code-editor').fill('<link rel="stylesheet" href="styles/linked.css"><div id="linked-result">Waiting</div><script src="assets/helper.js"></script><script src="assets/finish.js"></script><script src="https://evil.example/never.js"></script>')
    p.locator('#preview-page').click()
    linked=p.frame_locator('#preview-host iframe')
    expect(linked.locator('#linked-result')).to_have_text('RESOLVED',timeout=12000)
    verify(linked.locator('script[data-local-src]').count()==2,'P04 preview did not use exactly the declared scripts')
    verify(linked.locator('style[data-local-href]').count()==1,'P04 stylesheet reference not inlined')
    color=linked.locator('#linked-result').evaluate('(node)=>getComputedStyle(node).color')
    verify(color=='rgb(7, 8, 9)','P04 CSS was not applied at declared reference')
    verify('external reference blocked' in p.locator('#toast').inner_text(),'P04 external script omission not explained')
def check_providers(p):
    screen(p,'providers')
    verify(p.locator('.provider-card').count()==8,'Not eight provider cards')
    p.locator('#provider-search').fill('Groq')
    verify(p.locator('.provider-card').count()==1,'Provider search incorrect')
    verify(p.locator('.provider-card a[href^="https://"]').count()>=2,'Real official provider URLs missing')
    p.locator('.provider-card details summary').click()
    verify(p.locator('.provider-card details').evaluate('(x)=>x.open'),'Provider instructions do not expand')
    p.locator('.provider-card button').click()
    verify(p.locator('#view-vault').is_visible(),'Provider key button does not open vault')
    verify(p.locator('#key-provider').input_value()=='groq','Selected provider not carried to vault')
def check_q26_provider_model_presets(p):
    screen(p,'providers')
    manifest={'format':'mm-studio-provider-presets-v1','presets':[
       {'label':'Synthetic reusable model','provider':'groq','model':'llama-3.3-70b-versatile'}]}
    approve(p)
    p.locator('#provider-preset-import').set_input_files({'name':'presets.json','mimeType':'application/json','buffer':json.dumps(manifest).encode()})
    p.wait_for_function("document.querySelector('#provider-preset-count').textContent.includes('1 saved')",timeout=13000)
    p.locator('#provider-preset-select').select_option('0')
    verify(p.locator('#provider-preset-apply').is_enabled(),'Q26 valid preset cannot be applied')
    p.locator('#provider-preset-apply').click()
    verify(p.locator('#view-vault').is_visible(),'Q26 preset did not open the vault form')
    verify(p.locator('#key-provider').input_value()=='groq','Q26 preset route mismatch')
    verify(p.locator('#key-model').input_value()=='llama-3.3-70b-versatile','Q26 preset model mismatch')
    verify('NOT CREATED' in p.locator('#vault-status').inner_text(),'Q26 preset must not create a vault or connect')
    screen(p,'providers')
    with p.expect_download() as exported:p.locator('#provider-preset-export').click()
    payload=Path(exported.value.path()).read_text()
    verify('mm-studio-provider-presets-v1' in payload,'Q26 export format not correct')
    verify('TEST-FAKE-NOT-A-REAL-API-KEY' not in payload,'Q26 preset export revealed an API key')

def check_vault(p):
    screen(p,'vault')
    for selector in ['#key-provider','#key-model','#key-value','#key-account','#key-attest','#save-key']:
        verify(p.locator(selector).is_enabled(),selector+' incorrectly locked')
    p.locator('#key-value').fill('PREFILL-IS-NOT-A-KEY')
    p.locator('#save-key').click()
    verify(p.locator('#key-value').input_value()=='PREFILL-IS-NOT-A-KEY','Key entry lost before vault setup')
    verify('unlock' in p.locator('#toast').inner_text().lower(),'Vault setup guidance missing')
    setup_vault(p)
    verify(p.locator('#key-value').input_value()=='','Key was not cleared after encryption')
    p.locator('#vault-lock').click()
    p.wait_for_function("document.querySelector('#vault-status').textContent==='LOCKED'")
    p.locator('#vault-password').fill('incorrect-strong-password')
    p.locator('#vault-submit').click()
    p.wait_for_function("document.querySelector('#toast').textContent.includes('incorrect')",timeout=10000)
    p.locator('#vault-password').fill('test-only-vault-passphrase-2026')
    p.locator('#vault-submit').click()
    p.wait_for_function("document.querySelector('#vault-status').textContent==='UNLOCKED'")
    verify(p.locator('#vault-items').inner_text().count('GroqCloud')>=1,'Encrypted credential not restored')
    approve(p)
    p.locator('#vault-items .vault-item button').first.click()
    p.wait_for_function("document.querySelector('#vault-items').textContent.includes('No keys stored')",timeout=10000)
    # Two consecutive confirmation dialogs: accept each, not two handlers for the first.
    p.on('dialog',lambda d:d.accept())
    p.locator('#vault-wipe').click()
    p.wait_for_function("document.querySelector('#vault-status').textContent==='NOT CREATED'",timeout=10000)
def check_chat(p):
    mock_provider(p)
    setup_vault(p)
    screen(p,'chat')
    p.locator('#chat-route').select_option('groq')
    token_caps=[]
    def inspect_cap(route):
        if route.request.method!='OPTIONS':
            try:token_caps.append(json.loads(route.request.post_data or '{}').get('max_tokens'))
            except (ValueError,TypeError):token_caps.append(None)
        fake_groq(route)
    p.route('https://api.groq.com/**',inspect_cap)
    p.locator('#chat-output-tokens').select_option('256')
    p.locator('#chat-input').fill('QA synthetic message')
    p.locator('#send-chat').click()
    p.wait_for_function("document.querySelector('#chat-messages').textContent.includes('SYNTHETIC ACCEPTANCE RESPONSE')",timeout=12000)
    verify(token_caps==[256],'Q20 request did not use selected 256-token cap')
    verify(p.locator('#chat-messages .bubble.user').count()==1,'User message not saved')
    verify(p.locator('#chat-messages .bubble.assistant').count()==1,'Synthetic response not shown')
    p.locator('#new-chat').click()
    verify('New conversation' in p.locator('#thread-list').inner_text(),'New thread failed')
    approve(p)
    p.locator('#clear-chat').click()
    verify(p.locator('#chat-messages .bubble').count()==0,'Clear conversation failed')
    screen(p,'usage')
    # One logical request counts once (2026-10-26 audit fix): the old >=2
    # threshold encoded the double count (requested + terminal event).
    verify(int(p.locator('#usage-total').inner_text())>=1,'Model request audit not counted')
    with p.expect_download() as obj:p.locator('#export-audit').click()
    audit=json.loads(Path(obj.value.path()).read_text())
    verify(any(e['status']=='success' for e in audit),'Audit export contains no successful request')
    success=[e for e in audit if e['op']=='inference' and e['status']=='success']
    started=[e for e in audit if e['op']=='inference' and e['status']=='requested']
    verify(success and started and success[0].get('requestId')==started[0].get('requestId'),'Q10 request IDs do not correlate')
    verify(success[0].get('model')=='llama-3.1-8b-instant','Q10 provider-reported model mismatch')
    verify(isinstance(success[0].get('latencyMs'),int),'Q10 no measured latency')
    verify(success[0].get('httpStatus')==200,'Q10 HTTP outcome missing')
    verify('TEST-FAKE-NOT-A-REAL-API-KEY' not in json.dumps(audit),'Q10 audit leaked test credential')
    approve(p)
    p.locator('#clear-audit').click()
    verify(p.locator('#usage-total').inner_text()=='0','Clear audit failed')
def check_chat_retry_no_duplicate(p):
    setup_vault(p)
    screen(p,'chat')
    p.locator('#chat-route').select_option('groq')
    def fail_groq(route):
        if route.request.method=='OPTIONS':
            route.fulfill(status=204,headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'POST, OPTIONS'})
        else:
            route.fulfill(status=500,headers={'Content-Type':'application/json','Access-Control-Allow-Origin':'*'},body=json.dumps({'error':{'message':'synthetic failure'}}))
    p.route('https://api.groq.com/**',fail_groq)
    p.locator('#chat-input').fill('QA retry-no-duplicate message')
    p.locator('#send-chat').click()
    p.wait_for_function("document.querySelectorAll('#chat-messages .bubble.error').length>=1",timeout=20000)
    verify(p.locator('#chat-input').input_value()=='','Failed prompt was restored into the input')
    verify(p.locator('#chat-messages .bubble.user').count()==1,'User message duplicated or missing after failure')
    p.once('dialog',lambda d:d.accept())
    p.locator('#chat-retry-draft').click()
    verify(p.locator('#chat-input').input_value()=='QA retry-no-duplicate message','Retry draft did not prepare the prompt')
    verify(p.locator('#chat-messages .bubble.user').count()==1,'Retry draft sent instead of preparing')
    p.locator('#new-chat').click()
    p.route('https://api.groq.com/**',lambda route: None)
    p.locator('#chat-input').fill('QA stopped message')
    p.locator('#send-chat').click()
    p.wait_for_timeout(800)
    p.locator('#stop-chat').click()
    p.wait_for_function("document.querySelectorAll('#chat-messages .bubble.error').length>=1",timeout=20000)
    verify(p.locator('#chat-input').input_value()=='','Stopped prompt was restored into the input')
    verify(p.locator('#chat-messages .bubble.user').count()==1,'Stopped request duplicated the user message')
def check_chat_management(p):
    mock_provider(p)
    setup_vault(p)
    screen(p,'chat')
    p.locator('#chat-route').select_option('groq')
    p.locator('#chat-input').fill('P14 SEARCH UNIQUE ORIGINAL')
    p.locator('#send-chat').click()
    p.wait_for_function("document.querySelector('#chat-messages').textContent.includes('SYNTHETIC ACCEPTANCE RESPONSE')",timeout=12000)
    approve(p,'P14 EDITED USER MESSAGE')
    p.locator('#chat-messages .bubble.user button').click()
    verify('P14 EDITED USER MESSAGE' in p.locator('#chat-messages').inner_text(),'P14 saved user edit failed')
    p.locator('#thread-search').fill('P14 EDITED USER MESSAGE')
    verify(p.locator('#thread-list button').count()==1,'P14 search inside messages failed')
    p.locator('#thread-search').fill('NO RESULTS NEEDLE 123')
    verify('No matching conversations' in p.locator('#thread-list').inner_text(),'P14 empty search state missing')
    p.locator('#thread-search').fill('')
    with p.expect_download() as exported:p.locator('#export-chat-thread').click()
    payload=json.loads(Path(exported.value.path()).read_text())
    verify(payload['format']=='mm-studio-thread-v1','P14 thread format missing')
    verify(payload['thread']['messages'][0]['content']=='P14 EDITED USER MESSAGE','P14 exported user edit not present')
    approve(p)
    p.locator('#delete-chat-thread').click()
    verify(p.locator('#thread-list button').count()==1,'P14 last-thread deletion did not leave valid empty thread')
    verify(p.locator('#chat-messages .bubble').count()==0,'P14 deleted thread still present')
    verify(not p.locator('#thread-search').input_value(),'P14 unexpected search modification')

def check_workflows(p):
    mock_provider(p)
    setup_vault(p)
    screen(p,'workflows')
    p.locator('#workflow-route').select_option('groq')
    p.locator('#workflow-template').select_option('explain')
    p.locator('#workflow-stages').fill('First pass\nSecond pass\nFinal pass')
    p.locator('#workflow-goal').fill('Describe test execution only')
    p.locator('#workflow-confirm').check()
    p.locator('#workflow-start').click()
    p.wait_for_function("document.querySelector('#workflow-history').textContent.includes('complete')",timeout=22000)
    verify(p.locator('#workflow-results').inner_text().count('SYNTHETIC ACCEPTANCE RESPONSE')==3,'Expected three actual HTTP adapter stages')
    p.locator('#workflow-stages').fill('Draft | route=groq | save=outline\nIgnore | route=groq | when=contains:NEVER_MATCH\nReview | route=groq | input=outline')
    p.locator('#workflow-goal').fill('Q17 workflow test with a skipped conditional')
    p.locator('#workflow-start').click()
    expect(p.locator('#workflow-history .history-entry')).to_have_count(2,timeout=24000)
    p.wait_for_function("document.querySelector('#workflow-start').disabled === false",timeout=24000)
    output=p.locator('#workflow-results').inner_text()
    verify(output.count('SYNTHETIC ACCEPTANCE RESPONSE')==2,'Q17 conditional flow sent extra provider call')
    verify('Skipped: condition' in output,'Q17 skip not shown')
    verify(p.locator('#workflow-resume').is_disabled(),'Complete run is incorrectly resumable')
    p.locator('#workflow-stages').fill('\n'.join('Stage '+str(x) for x in range(7)))
    verify('7 stages entered' in p.locator('#workflow-graph').inner_text(),'Excess stages silently discarded')
def check_knowledge(p):
    screen(p,'knowledge')
    p.locator('#knowledge-title').fill('QA evidence note')
    p.locator('#knowledge-content').fill('Source facts for acceptance only')
    p.locator('#knowledge-form button[type="submit"]').click()
    verify('1 notes' in p.locator('#note-count').inner_text(),'Knowledge save failed')
    p.locator('#knowledge-search').fill('Source facts')
    p.locator('#knowledge-evidence').click()
    expect(p.locator('#knowledge-evidence-output')).to_contain_text('[L1]')
    verify('Source facts' in p.locator('#knowledge-evidence-output').inner_text(),'Q19 cited passage must contain exact local text')
    p.locator('#knowledge-insert-evidence').click()
    verify('[L1]' in p.locator('#chat-input').input_value(),'Q19 local references not inserted')
    screen(p,'knowledge')
    p.locator('#knowledge-search').fill('QA evidence')
    p.locator('#knowledge-results button').first.click()
    verify('Source facts' in p.locator('#knowledge-preview').inner_text(),'Knowledge preview failed')
    p.locator('#knowledge-to-chat').click()
    verify('Source facts' in p.locator('#chat-input').input_value(),'Insert knowledge into chat failed')
    screen(p,'knowledge')
    with p.expect_download() as obj:p.locator('#knowledge-export').click()
    archived=Path(obj.value.path()).read_bytes()
    approve(p)
    p.locator('#knowledge-delete').click()
    verify('0 notes' in p.locator('#note-count').inner_text(),'Delete note failed')
    p.locator('#knowledge-import').set_input_files({'name':'notes.json','mimeType':'application/json','buffer':archived})
    p.wait_for_function("document.querySelector('#note-count').textContent.includes('1 notes')")
    p.locator('#knowledge-import').set_input_files({'name':'extra.txt','mimeType':'text/plain','buffer':b'imported extra reference'})
    p.wait_for_function("document.querySelector('#note-count').textContent.includes('2 notes')")
def check_paged_knowledge(p):
    screen(p,'knowledge')
    archive={'format':'mm-studio-notes-v1','notes':[
       {'id':'q24-note-'+str(i),'title':'Pagination QA '+str(i).zfill(2),
        'content':'Unique page candidate '+str(i),'created':'2026-10-14T00:00:00Z'}
       for i in range(43)]}
    p.locator('#knowledge-import').set_input_files({'name':'q24-notes.json','mimeType':'application/json','buffer':json.dumps(archive).encode()})
    p.wait_for_function("document.querySelector('#note-count').textContent.includes('43 notes')",timeout=20000)
    p.locator('#knowledge-search').fill('Pagination QA')
    expect(p.locator('#knowledge-results button')).to_have_count(20,timeout=10000)
    verify('Page 1 of 3' in p.locator('#knowledge-page-info').inner_text(),'Q24 first page count absent')
    verify(p.locator('#knowledge-page-prev').is_disabled(),'Q24 Previous enabled at first page')
    p.locator('#knowledge-page-next').click()
    verify('Page 2 of 3' in p.locator('#knowledge-page-info').inner_text(),'Q24 second page absent')
    expect(p.locator('#knowledge-results button')).to_have_count(20)
    p.locator('#knowledge-page-next').click()
    verify('Page 3 of 3' in p.locator('#knowledge-page-info').inner_text(),'Q24 third page absent')
    expect(p.locator('#knowledge-results button')).to_have_count(3)
    verify(p.locator('#knowledge-page-next').is_disabled(),'Q24 Next enabled beyond final page')
    p.locator('#knowledge-search').fill('Pagination QA 42')
    verify('Page 1 of 1' in p.locator('#knowledge-page-info').inner_text(),'Q24 search did not reset current page')
    expect(p.locator('#knowledge-results button')).to_have_count(1)

def check_q25_binary_project_assets(p):
    screen(p,'workspace')
    png=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==')
    p.locator('#binary-asset-import').set_input_files({'name':'icon.png','mimeType':'image/png','buffer':png})
    expect(p.locator('#binary-assets-list button')).to_have_count(1,timeout=12000)
    p.locator('#binary-assets-list button').click()
    expect(p.locator('#binary-asset-preview img')).to_be_attached(timeout=8000)
    verify(p.locator('#binary-asset-preview img').get_attribute('src').startswith('blob:'),'Q25 local preview must use revocable blob URL')
    with p.expect_download() as saved:p.locator('#export-json').click()
    obj=json.loads(Path(saved.value.path()).read_text())
    verify('binaryAssets' in obj,'Q25 project JSON must include binary assets')
    verify(base64.b64decode(obj['binaryAssets']['icon.png']['base64'])==png,'Q25 project JSON changed media bytes')
    with p.expect_download() as savedzip:p.locator('#export-zip').click()
    with zipfile.ZipFile(savedzip.value.path(),'r') as z:
        verify(z.read('icon.png')==png,'Q25 exported ZIP did not preserve raw media')
    approve(p)
    p.locator('#import-project').set_input_files({'name':'new-project.zip','mimeType':'application/zip','buffer':Path(savedzip.value.path()).read_bytes()})
    p.wait_for_function("document.querySelector('#binary-assets-list').textContent.includes('icon.png')",timeout=15000)
    p.locator('#binary-assets-list button').click()
    verify(p.locator('#binary-asset-delete').is_enabled(),'Q25 media removal disabled')
    approve(p)
    p.locator('#binary-asset-delete').click()
    expect(p.locator('#binary-assets-list button')).to_have_count(0,timeout=8000)
    # Text editor remains runnable and binary file is never put into executable source.
    p.locator('#file-tree .file-entry[title="main.js"]').click()
    verify(p.locator('#code-editor').is_editable(),'Q25 binary roundtrip broke text editor')

def check_data(p):
    screen(p,'datalab')
    p.locator('#data-input').fill('title,value\nOne,10\nMissing,\nTwo,20')
    p.locator('#data-analyze').click()
    verify('mean 15.00' in p.locator('#data-status').inner_text(),'Numeric blank-cell handling failed')
    verify(p.locator('#data-table tbody tr').count()==3,'Data table missing rows')
    p.locator('#data-axis').select_option('value')
    with p.expect_download() as obj:p.locator('#data-export').click()
    verify('One,10' in Path(obj.value.path()).read_text(),'Data export failed')
    p.locator('#data-import').set_input_files({'name':'dataset.json','mimeType':'application/json','buffer':b'[{"name":"r1","count":8},{"name":"r2","count":16}]'})
    p.wait_for_function("document.querySelector('#data-status').textContent.includes('mean 12.00')")
    p.locator('#data-wasm-test').click()
    p.wait_for_function("document.querySelector('#data-status').textContent.includes('WebAssembly execution: PASS')",timeout=8000)
    p.locator('#data-input').fill('a,b\n\"unterminated')
    p.locator('#data-analyze').click()
    verify('Analysis failed:' in p.locator('#data-status').inner_text(),'Invalid data not rejected')
    verify(p.locator('#data-table tbody tr').count()==0,'Old data remained after parse error')
def check_data_persistence_transforms(p):
    screen(p,'datalab')
    csv='name,score\\nAlpha,10\\nBeta,25\\nGamma,'
    p.locator('#data-input').fill(csv.replace('\\n',chr(10)))
    p.locator('#data-analyze').click()
    p.locator('#data-transform').select_option('filter-gt')
    p.locator('#data-transform-field').select_option('score')
    p.locator('#data-transform-value').fill('11')
    p.locator('#data-transform-apply').click()
    verify(p.locator('#data-table tbody tr').count()==1,'P19 filter did not keep exactly one row')
    verify('Beta' in p.locator('#data-table').inner_text(),'P19 wrong row after numeric filter')
    p.locator('#data-transform-undo').click()
    verify(p.locator('#data-table tbody tr').count()==3,'P19 undo did not recover all rows')
    p.locator('#data-transform').select_option('sort-desc')
    p.locator('#data-transform-field').select_option('score')
    p.locator('#data-transform-apply').click()
    verify('3 rows' in p.locator('#data-status').inner_text(),'P19 sorting lost rows')
    p.locator('#data-transform-undo').click()
    approve(p,'QA saved dataset')
    p.locator('#data-save').click()
    p.wait_for_function("() => document.querySelector('#data-saved').options.length === 2",timeout=12000)
    verify('QA saved dataset' in p.locator('#data-saved').inner_text(),'P18 saved dataset missing')
    screen(p,'settings')
    with p.expect_download() as saved:p.locator('#backup-all').click()
    backup=json.loads(Path(saved.value.path()).read_text())
    verify(len(backup.get('datasets',[]))==1,'P18 named dataset not in full backup')
    p.reload(wait_until='domcontentloaded')
    screen(p,'datalab')
    verify(p.locator('#data-saved option').count()==2,'P18 saved dataset lost on reload')
    p.locator('#data-saved').select_option(label='QA saved dataset')
    p.locator('#data-load').click()
    verify(p.locator('#data-table tbody tr').count()==3,'P18 persisted dataset reload incomplete')
    approve(p)
    p.locator('#data-delete').click()
    p.wait_for_function("() => document.querySelector('#data-saved').options.length === 1",timeout=12000)
    verify(p.locator('#data-saved option').count()==1,'P18 deleted saved dataset still listed')

def check_health_and_data_pages(p):
    screen(p,'overview')
    health=p.locator('#health-list')
    verify(health.locator('.health-line').count()==6,'D09 runtime health probes missing')
    verify('UNVERIFIED' in health.inner_text(),'D09 must not claim provider health without real inference')
    verify('Browser storage' in health.inner_text(),'D09 storage status missing')
    screen(p,'datalab')
    columns=['label']+['field'+str(i) for i in range(12)]
    rows=[','.join(['row'+str(i)]+[str(i+j) for j in range(12)]) for i in range(31)]
    p.locator('#data-input').fill(','.join(columns)+'\n'+'\n'.join(rows))
    p.locator('#data-analyze').click()
    verify(p.locator('#data-table thead th').count()==13,'P17 columns beyond 12 not accessible')
    verify(p.locator('#data-table tbody tr').count()==25,'P17 table first page size wrong')
    p.locator('#data-table-next').click()
    verify(p.locator('#data-table tbody tr').count()==6,'P17 last page missing')
    verify('26–31 of 31' in p.locator('#data-table-status').inner_text(),'P17 row range incorrect')
    p.locator('#data-table-prev').click()
    verify(p.locator('#data-table tbody tr').count()==25,'P17 table previous page not restored')
    p.locator('#data-chart-next').click()
    verify('16–30 of 31' in p.locator('#data-chart-status').inner_text(),'P17 chart second page incorrect')
    p.locator('#data-chart-next').click()
    verify('31–31 of 31' in p.locator('#data-chart-status').inner_text(),'P17 chart final page missing')
    p.locator('#data-chart-prev').click()
    verify('16–30 of 31' in p.locator('#data-chart-status').inner_text(),'P17 chart previous page failed')

def make_png(width=2,height=1):
    def chunk(name,data):return struct.pack('!I',len(data))+name+data+struct.pack('!I',zlib.crc32(name+data)&0xffffffff)
    scan=(b'\x00'+b'\xff\x20\x20\xff'*width)*height
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('!IIBBBBB',width,height,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(scan))+chunk(b'IEND',b'')
def check_cross_project_knowledge(p):
    screen(p,'workspace')
    approve(p,'CrossProjectSource')
    p.locator('#new-project').click()
    p.locator('#code-editor').fill('P16-CROSS-PROJECT-FIRST')
    approve(p,'CrossProjectOther')
    p.locator('#new-project').click()
    screen(p,'knowledge')
    p.locator('#knowledge-search').fill('P16-CROSS-PROJECT-FIRST')
    verify(p.locator('#knowledge-results button').count()==1,'P16 cross-project file not searchable')
    p.locator('#knowledge-results button').first.click()
    verify('P16-CROSS-PROJECT-FIRST' in p.locator('#knowledge-preview').inner_text(),'P16 cross-project preview wrong')
    screen(p,'workspace')
    p.locator('#project-select').select_option(label='CrossProjectSource')
    p.locator('#code-editor').fill('P16-CROSS-PROJECT-UPDATED')
    screen(p,'knowledge')
    verify('P16-CROSS-PROJECT-UPDATED' in p.locator('#knowledge-preview').inner_text(),'P16 cross-project preview stale')
    p.locator('#knowledge-to-chat').click()
    verify('P16-CROSS-PROJECT-UPDATED' in p.locator('#chat-input').input_value(),'P16 cross-project chat insertion stale')

def check_note_edit_and_duplicates(p):
    screen(p,'knowledge')
    for title in ['QA duplicate first','QA duplicate second']:
        p.locator('#knowledge-title').fill(title)
        p.locator('#knowledge-content').fill('Exactly the same reference content')
        p.locator('#knowledge-submit').click()
    verify('2 notes' in p.locator('#note-count').inner_text(),'P15 two notes not stored')
    p.locator('#knowledge-find-duplicates').click()
    verify('2 notes' in p.locator('#knowledge-duplicate-report').inner_text(),'P15 exact duplicate group missing')
    p.locator('#knowledge-search').fill('QA duplicate second')
    p.locator('#knowledge-results button').first.click()
    p.locator('#knowledge-edit').click()
    verify(p.locator('#knowledge-submit').inner_text()=='Save changes','P15 edit mode not indicated')
    p.locator('#knowledge-content').fill('This change should not be saved')
    p.locator('#knowledge-cancel-edit').click()
    verify('Exactly the same' in p.locator('#knowledge-preview').inner_text(),'P15 cancel altered saved note')
    p.locator('#knowledge-edit').click()
    p.locator('#knowledge-content').fill('Edited and verified note body')
    approve(p)
    p.locator('#knowledge-submit').click()
    verify('Edited and verified note body' in p.locator('#knowledge-preview').inner_text(),'P15 edit did not replace saved note')
    p.locator('#knowledge-find-duplicates').click()
    verify('No exact-content duplicates' in p.locator('#knowledge-duplicate-report').inner_text(),'P15 duplicate report not refreshed')
    with p.expect_download() as saved:p.locator('#knowledge-export').click()
    data=json.loads(Path(saved.value.path()).read_text())
    edited=[note for note in data['notes'] if note['title']=='QA duplicate second']
    verify(len(edited)==1 and edited[0].get('updated'),'P15 edited note timestamp not archived')
    p.wait_for_function("() => document.querySelector('#save-indicator').textContent.includes('Saved')",timeout=12000)
    p.reload(wait_until='domcontentloaded')
    screen(p,'knowledge')
    p.locator('#knowledge-search').fill('QA duplicate second')
    p.locator('#knowledge-results button').first.click()
    verify('Edited and verified note body' in p.locator('#knowledge-preview').inner_text(),'P15 updated note lost on reload')

def check_knowledge_freshness(p):
    screen(p,'workspace')
    filename=p.locator('#active-file').inner_text()
    p.locator('#code-editor').fill('initial knowledge source text')
    screen(p,'knowledge')
    p.locator('#knowledge-search').fill(filename)
    p.locator('#knowledge-results button').first.click()
    verify('initial knowledge source text' in p.locator('#knowledge-preview').inner_text(),'First knowledge preview did not show current source')
    screen(p,'workspace')
    p.locator('#code-editor').fill('updated knowledge source text')
    screen(p,'knowledge')
    verify('updated knowledge source text' in p.locator('#knowledge-preview').inner_text(),'D13 stale project-file preview')
    p.locator('#knowledge-to-chat').click()
    verify('updated knowledge source text' in p.locator('#chat-input').input_value(),'D13 inserted stale code into chat')

def check_media(p):
    screen(p,'media')
    p.locator('#media-image').set_input_files({'name':'qa.png','mimeType':'image/png','buffer':make_png()})
    p.wait_for_function("document.querySelector('#media-canvas').width === 2",timeout=10000)
    p.locator('#media-brightness').fill('150')
    p.locator('#media-contrast').fill('125')
    p.locator('#media-saturation').fill('60')
    p.locator('#media-reset').click()
    verify(p.locator('#media-brightness').input_value()=='100','Media reset brightness failed')
    verify(p.locator('#media-contrast').input_value()=='100','Media reset contrast failed')
    with p.expect_download() as obj:p.locator('#media-download').click()
    verify(Path(obj.value.path()).read_bytes().startswith(b'\x89PNG'),'Exported image is not PNG')
    p.locator('#speech-text').fill('Speech QA text')
    p.locator('#speech-rate').fill('1.2')
    p.locator('#speech-pitch').fill('0.8')
    verify('1.2' in p.locator('#speech-rate-label').inner_text(),'Q09 speech rate UI did not update')
    verify('0.8' in p.locator('#speech-pitch-label').inner_text(),'Q09 speech pitch UI did not update')
    p.locator('#speech-refresh-voices').click()
    verify('voice(s)' in p.locator('#speech-voices-status').inner_text(),'Q09 voice status is missing')
    p.locator('#speech-start').click()
    verify('Speaking' in p.locator('#speech-status').inner_text() or 'Finished' in p.locator('#speech-status').inner_text(),'Speech action did not update status')
    p.locator('#speech-stop').click()
    verify('stopped' in p.locator('#speech-status').inner_text().lower(),'Speech stop did not update status')
    verify(not p.locator('#media-original-resolution').is_checked(),'D17 high-resolution export should be opt-in')
    verify('Original:' in p.locator('#media-resolution-status').inner_text(),'D17 resolution disclosure missing')
    p.locator('#media-image').set_input_files({'name':'wide.png','mimeType':'image/png','buffer':make_png(2000,1)})
    p.wait_for_function("document.querySelector('#media-canvas').width === 1600",timeout=10000)
    with p.expect_download() as reduced:p.locator('#media-download').click()
    reduced_bytes=Path(reduced.value.path()).read_bytes()
    verify(struct.unpack('!II',reduced_bytes[16:24])==(1600,1),'D17 preview-size export did not use visible resolution')
    p.locator('#media-original-resolution').check()
    with p.expect_download() as original:p.locator('#media-download').click()
    original_bytes=Path(original.value.path()).read_bytes()
    verify(struct.unpack('!II',original_bytes[16:24])==(2000,1),'D17 original-resolution PNG export lost dimensions')

    p.evaluate("""() => {
      window.__dictationStopped=false;
      window.SpeechRecognition=class {
        start(){ window.__dictationStarted=true; }
        stop(){ window.__dictationStopped=true; if(this.onend)this.onend(); }
      };
    }""")
    p.locator('#speech-dictate').click()
    verify(p.evaluate('window.__dictationStarted === true'),'D15 dictation did not start')
    p.locator('#speech-stop').click()
    verify(p.evaluate('window.__dictationStopped === true'),'D15 recognition not stopped')
    verify('stopped' in p.locator('#speech-status').inner_text().lower(),'D15 stop status overwritten')
def check_settings(p):
    screen(p,'settings')
    p.locator('#accent-select').select_option('violet')
    verify(p.locator('body').get_attribute('data-accent')=='violet','Accent preference failed')
    p.locator('#compact-toggle').check()
    verify('compact' in p.locator('body').get_attribute('class'),'Compact setting failed')
    # IndexedDB writes are debounced; reload only after the UI confirms a durable save.
    p.wait_for_function("document.querySelector('#save-indicator').textContent === 'Saved on this device'",timeout=10000)
    with p.expect_download() as obj:p.locator('#backup-all').click()
    backup=json.loads(Path(obj.value.path()).read_text())
    verify('projects' in backup and 'threads' in backup and 'preferences' in backup,'Workspace backup incomplete')
    verify('vault' not in str(backup).lower(),'Sensitive vault accidentally included in workspace backup')
    p.locator('#restore-all').set_input_files({'name':'bad.json','mimeType':'application/json','buffer':b'{"broken":true}'})
    p.wait_for_function("document.querySelector('#toast').textContent.includes('Restore failed')",timeout=10000)
    p.reload()
    p.locator('#view-settings h1').wait_for(timeout=12000)
    screen(p,'settings')
    verify(p.locator('#accent-select').input_value()=='violet','Preferences not persisted to IndexedDB')
    # Two sequential destructive-action dialogs both need confirmation.
    p.on('dialog',lambda d:d.accept())
    p.locator('#reset-all').click()
    p.wait_for_function("document.querySelector('#toast').textContent.includes('reset and saved')",timeout=10000)
    verify(p.locator('#accent-select').input_value()!='violet','Reset did not clear preferences')
def check_capabilities(p):
    screen(p,'capabilities')
    verify(p.locator('.capability-row').count()>=15,'Capability inventory missing')
    verify('PARTIAL' in p.locator('#capability-list').inner_text(),'Missing honest partial capabilities')
    p.wait_for_function("() => document.querySelectorAll('#capability-live-list .capability-row').length >= 10",polling=100,timeout=12000)
    report=p.locator('#capability-live-list').inner_text()
    verify('Remote model providers' in report and 'NOT VERIFIED' in report,'P30 provider check must not invent connectivity')
    verify('WebAssembly minimal module' in report,'P30 WASM probe missing')
    verify('Microphone permission status' in report,'P30 permission status probe missing')
    p.locator('#capability-refresh').click()
    p.wait_for_function("() => document.querySelector('#capability-refresh').disabled === false",polling=100,timeout=12000)
    verify(p.locator('#capability-live-list .capability-row').count()>=10,'P30 refreshed feature probes missing')
def check_q27_local_webgpu_readiness(p):
    screen(p,'capabilities')
    verify('Not checked' in p.locator('#ondevice-probe-result').inner_text(),'Q27 must be user-triggered')
    p.locator('#ondevice-probe').click()
    p.wait_for_function("() => document.querySelector('#ondevice-probe-result').textContent.includes('No model was downloaded, loaded, or executed.') || document.querySelector('#ondevice-probe-result').textContent.includes('No model inference was attempted.')",timeout=16000)
    status=p.locator('#ondevice-probe-result').inner_text()
    verify(any(word in status for word in ['UNAVAILABLE','NO-ADAPTER','ADAPTER-ONLY','INSECURE','PROBE-FAILED','could not be checked']), 'Q27 readiness status not bounded')
    verify(p.locator('#ondevice-probe').is_enabled(),'Q27 probe remained disabled')

def check_mobile(p):
    p.set_viewport_size({'width':375,'height':800})
    p.locator('#mobile-menu').click()
    verify(p.locator('#sidebar').evaluate("(x)=>x.classList.contains('open')"),'Mobile sidebar failed')
    p.locator('#sidebar [data-view="vault"]').click()
    verify(p.locator('#view-vault').is_visible(),'Mobile navigation to vault failed')
    verify(not p.locator('#sidebar').evaluate("(x)=>x.classList.contains('open')"),'Mobile navigation did not dismiss sidebar')
    p.locator('#mobile-menu').click()
    p.locator('#sidebar-close').click()
    verify(not p.locator('#sidebar').evaluate("(x)=>x.classList.contains('open')"),'Mobile sidebar close failed')

def check_vault_portability(p):
    setup_vault(p)
    screen(p,'vault')
    with p.expect_download() as downloaded:p.locator('#vault-export-encrypted').click()
    backup=Path(downloaded.value.path()).read_text()
    verify('"format": "mm-studio-encrypted-vault-v1"' in backup,'Q21 encrypted backup format missing')
    verify('TEST-FAKE-NOT-A-REAL-API-KEY' not in backup,'Q21 backup leaked plaintext key')
    p.locator('#vault-rotation-old').fill('test-only-vault-passphrase-2026')
    p.locator('#vault-rotation-new').fill('new-vault-passphrase-QA-2026')
    approve(p)
    p.locator('#vault-rotate-submit').click()
    p.wait_for_function("document.querySelector('#toast').textContent.includes('Vault re-encrypted')",timeout=20000)
    p.locator('#vault-lock').click()
    p.locator('#vault-password').fill('test-only-vault-passphrase-2026')
    p.locator('#vault-submit').click()
    p.wait_for_function("document.querySelector('#toast').textContent.includes('incorrect')",timeout=16000)
    p.locator('#vault-password').fill('new-vault-passphrase-QA-2026')
    p.locator('#vault-submit').click()
    p.wait_for_function("document.querySelector('#vault-status').textContent === 'UNLOCKED'",timeout=16000)
    p.locator('#vault-import-passphrase').fill('test-only-vault-passphrase-2026')
    approve(p)
    p.locator('#vault-import-encrypted').set_input_files({'name':'encrypted-vault.json','mimeType':'application/json','buffer':backup.encode()})
    p.wait_for_function("document.querySelector('#vault-status').textContent === 'LOCKED'",timeout=16000)
    p.locator('#vault-password').fill('test-only-vault-passphrase-2026')
    p.locator('#vault-submit').click()
    p.wait_for_function("document.querySelector('#vault-status').textContent === 'UNLOCKED'",timeout=16000)
    verify('GroqCloud' in p.locator('#vault-items').inner_text(),'Q21 imported encrypted vault credentials unavailable after old passphrase')

def check_local_connection_diagnostics_and_manual_retry(p):
    screen(p,'providers')
    p.locator('#provider-check-local').click()
    verify('missing-key' in p.locator('#provider-diagnostics').inner_text(),'Q22 missing-key state not reported')
    setup_vault(p)
    screen(p,'providers')
    p.locator('#provider-check-local').click()
    report=p.locator('#provider-diagnostics').inner_text()
    verify('GroqCloud: configured-unverified' in report,'Q22 configured state missing')
    verify('TEST-FAKE-NOT-A-REAL-API-KEY' not in report,'Q22 diagnostic leaked synthetic API key')
    screen(p,'chat')
    p.locator('#chat-route').select_option('groq')
    requests=[]
    def fail_synthetically(route):
        if route.request.method=='POST':requests.append(route.request.url)
        route.fulfill(status=429,headers={'Content-Type':'application/json','Access-Control-Allow-Origin':'*'},
            body='{"error":{"message":"Synthetic provider rate limit"}}')
    p.route('https://api.groq.com/**',fail_synthetically)
    p.locator('#chat-input').fill('Q22 manual retry prompt only')
    p.locator('#send-chat').click()
    p.wait_for_function("document.querySelector('#chat-messages').textContent.includes('Synthetic provider rate limit')",timeout=15000)
    verify(len(requests)==1,'Q22 fixture must fail exactly one provider call')
    approve(p)
    p.locator('#chat-retry-draft').click()
    verify(p.locator('#chat-input').input_value()=='Q22 manual retry prompt only','Q22 original failed message was not restored')
    verify(len(requests)==1,'Q22 preparing retry must never send another request')

def check_chat_persist_before_dispatch(p):
    mock_provider(p)
    setup_vault(p)
    screen(p,'chat')
    p.locator('#chat-route').select_option('groq')
    # Order: the prompt must already be durable when the first provider
    # request is observed. With the old debounced-only save, the prompt
    # would still be in memory at this point (the 300 ms timer has not
    # fired), so this assertion fails on the old code and passes on the
    # persist-before-dispatch code.
    with p.expect_request('https://api.groq.com/**'):
        p.locator('#chat-input').fill('QA persist-before-dispatch order message')
        p.locator('#send-chat').click()
    saved=p.evaluate("""async () => {
      const db=await new Promise((res,rej)=>{const r=indexedDB.open('mm-studio-lab-b03');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});
      const st=await new Promise((res,rej)=>{const tx=db.transaction('kv','readonly');const q=tx.objectStore('kv').get('state.v1');q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error);});
      const t=st.threads.find(x=>x.id===st.activeThreadId);
      return t.messages.some(m=>m.role==='user'&&m.content.includes('QA persist-before-dispatch order message'));
    }""")
    verify(saved,'Prompt was not durable in storage when the provider request was observed')
    p.wait_for_function("document.querySelector('#chat-messages').textContent.includes('SYNTHETIC ACCEPTANCE RESPONSE')",timeout=12000)
    # Compare mode still sends on both routes under the same single save.
    screen(p,'vault')
    p.locator('#key-provider').select_option('openrouter')
    p.locator('#key-model').fill('openrouter/free')
    p.locator('#key-value').fill('TEST-FAKE-NOT-A-REAL-API-KEY-2')
    p.locator('#key-attest').check()
    p.locator('#save-key').click()
    p.wait_for_function("document.querySelector('#vault-items').textContent.toLowerCase().includes('openrouter')",timeout=15000)
    p.route('https://openrouter.ai/**',fake_groq)
    screen(p,'chat')
    p.locator('#new-chat').click()
    p.locator('#compare-mode').check()
    p.locator('#chat-route').select_option('groq')
    p.locator('#compare-route').select_option('openrouter')
    p.locator('#chat-input').fill('QA persist compare message')
    p.locator('#send-chat').click()
    p.wait_for_function("document.querySelectorAll('#chat-messages .bubble.assistant').length>=2",timeout=20000)
    verify(p.locator('#chat-messages .bubble.user').count()==1,'Compare send duplicated the user message')
    # Failure injection: with readwrite transactions broken, the send must
    # never dispatch, the prompt must return to the input, and no phantom
    # user message may remain in the thread. Fresh context for isolation.
    base=p.url.split('#')[0]
    ctx2=p.context.browser.new_context(viewport={'width':1360,'height':860})
    p2=ctx2.new_page()
    errors2=[]
    p2.on('pageerror',lambda e:errors2.append(str(e)))
    p2.add_init_script("""(()=>{const orig=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(names,mode,...rest){if(mode==='readwrite'&&window.__breakWrites)throw new Error('synthetic storage failure');return orig.call(this,names,mode,...rest);};})();""")
    p2.goto(base,timeout=25000)
    p2.locator('#view-overview h1').wait_for(timeout=16000)
    hits=[]
    def counting(route):
        if route.request.method!='OPTIONS':hits.append(1)
        fake_groq(route)
    p2.route('https://api.groq.com/**',counting)
    setup_vault(p2)
    screen(p2,'chat')
    p2.locator('#chat-route').select_option('groq')
    p2.locator('#chat-input').fill('QA persist baseline')
    p2.locator('#send-chat').click()
    p2.wait_for_function("document.querySelector('#chat-messages').textContent.includes('SYNTHETIC ACCEPTANCE RESPONSE')",timeout=12000)
    before=len(hits)
    p2.evaluate("window.__breakWrites=true")
    p2.locator('#chat-input').fill('QA persist-failure message')
    p2.locator('#send-chat').click()
    p2.wait_for_function("document.querySelector('#toast').textContent.includes('not sent')",timeout=10000)
    verify(p2.locator('#chat-input').input_value()=='QA persist-failure message','Failed save did not restore the prompt to the input')
    verify(p2.locator('#send-chat').is_enabled(),'Send was not left enabled after the failed save')
    verify(len(hits)==before,'Provider was called despite the failed save')
    verify(p2.locator('#chat-messages .bubble.user').count()==1,'Failed save left a phantom user message in the thread')
    verify(p2.locator('#save-indicator').inner_text().startswith('Save failed'),'Save indicator did not report the failure')
    verify(not errors2,'Page errors on the failure-injection page: '+str(errors2))
    ctx2.close()
def check_vault_commit_before_adopt(p):
    # Re-audit item 4: vault mutations must commit before they are adopted.
    # With readwrite transactions broken, create/put/drop/erase must leave
    # both the in-memory vault and durable storage exactly as they were:
    # no phantom entries, no resurrected deletions, no phantom vault.
    # Each phase breaks with its own message so a toast wait cannot pass
    # vacuously off an earlier phase's toast.
    base=p.url.split('#')[0]
    ctx=p.context.browser.new_context(viewport={'width':1360,'height':860})
    q=ctx.new_page()
    errors=[]
    q.on('pageerror',lambda e:errors.append(str(e)))
    q.add_init_script("""(()=>{const orig=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(names,mode,...rest){if(mode==='readwrite'&&window.__breakWrites)throw new Error(window.__breakMessage||'synthetic storage failure');return orig.call(this,names,mode,...rest);};})();""")
    q.goto(base,timeout=25000)
    q.locator('#view-overview h1').wait_for(timeout=16000)
    # Create failure: no phantom unlocked vault. Switching views re-renders
    # from memory, so a half-adopted create would show UNLOCKED here.
    q.evaluate("window.__breakWrites=true;window.__breakMessage='synthetic vault-create failure'")
    screen(q,'vault')
    q.locator('#vault-password').fill('test-only-vault-passphrase-2026')
    q.locator('#vault-submit').click()
    q.wait_for_function("document.querySelector('#toast').textContent.includes('synthetic vault-create failure')",timeout=10000)
    screen(q,'overview')
    screen(q,'vault')
    verify(q.locator('#vault-status').inner_text()=='NOT CREATED','Failed vault create left a phantom vault')
    # Real vault first, then break writes mid-session.
    q.evaluate("window.__breakWrites=false")
    setup_vault(q)
    # Put failure: no phantom entry in memory, none durable either.
    q.locator('#key-provider').select_option('openrouter')
    q.locator('#key-model').fill('openrouter/free')
    q.locator('#key-value').fill('TEST-FAKE-NOT-A-REAL-API-KEY-2')
    q.locator('#key-attest').check()
    q.evaluate("window.__breakWrites=true;window.__breakMessage='synthetic key-save failure'")
    q.locator('#save-key').click()
    q.wait_for_function("document.querySelector('#toast').textContent.includes('synthetic key-save failure')",timeout=10000)
    screen(q,'overview')
    screen(q,'vault')
    verify('openrouter' not in q.locator('#vault-items').inner_text().lower(),'Failed key save left a phantom entry')
    # Drop failure: the entry stays listed.
    q.on('dialog',lambda d:d.accept())
    q.evaluate("window.__breakMessage='synthetic key-remove failure'")
    q.locator('#vault-items .vault-item button').first.click()
    q.wait_for_function("document.querySelector('#toast').textContent.includes('synthetic key-remove failure')",timeout=10000)
    screen(q,'overview')
    screen(q,'vault')
    verify('GroqCloud' in q.locator('#vault-items').inner_text(),'Failed key removal dropped the entry from memory')
    # Erase failure: the vault stays unlocked with its keys.
    q.evaluate("window.__breakMessage='synthetic vault-wipe failure'")
    q.locator('#vault-wipe').click()
    q.wait_for_function("document.querySelector('#toast').textContent.includes('synthetic vault-wipe failure')",timeout=10000)
    screen(q,'overview')
    screen(q,'vault')
    verify(q.locator('#vault-status').inner_text()=='UNLOCKED','Failed vault wipe locked or erased the vault')
    verify('GroqCloud' in q.locator('#vault-items').inner_text(),'Failed vault wipe lost the keys')
    # Durable proof: writes back on, lock + unlock round-trips the ORIGINAL
    # vault only — groq present, no phantom openrouter key.
    q.evaluate("window.__breakWrites=false")
    q.locator('#vault-lock').click()
    q.wait_for_function("document.querySelector('#vault-status').textContent==='LOCKED'")
    q.locator('#vault-password').fill('test-only-vault-passphrase-2026')
    q.locator('#vault-submit').click()
    q.wait_for_function("document.querySelector('#vault-status').textContent==='UNLOCKED'",timeout=15000)
    items=q.locator('#vault-items').inner_text()
    verify('GroqCloud' in items,'Groq key did not survive the failed-drop round-trip')
    verify('openrouter' not in items.lower(),'Phantom openrouter key became durable after the failed save')
    verify(not errors,'Page errors on the vault failure-injection page: '+str(errors))
    ctx.close()
def check_chat_double_submit_guard(p):
    # Re-audit P0-1: two submits during the persist-before-dispatch save
    # must produce one user message and one provider request, and a failed
    # save with a second submit attempt must roll back exactly the failed
    # message. The save is stretched by delaying the transaction's
    # oncomplete handler, which delays saveNow's resolution without
    # breaking the commit itself. The rejection toast is the vacuity
    # guard: it only appears if the second submit actually landed while
    # the first save was still pending.
    base=p.url.split('#')[0]
    ctx=p.context.browser.new_context(viewport={'width':1360,'height':860})
    q=ctx.new_page()
    errors=[]
    q.on('pageerror',lambda e:errors.append(str(e)))
    q.add_init_script("""(()=>{const orig=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(...a){if(a[1]==='readwrite'&&window.__breakWrites)throw new Error(window.__breakMessage||'synthetic storage failure');const tx=orig.apply(this,a);if(a[1]==='readwrite'&&window.__delayWrites){let h=null;try{Object.defineProperty(tx,'oncomplete',{configurable:true,set(v){h=v;},get(){return h;}});}catch(e){}tx.addEventListener('complete',()=>{setTimeout(()=>{if(h)h.call(tx,new Event('complete'));},window.__delayMs||1500);});}return tx;};})();""")
    q.goto(base,timeout=25000)
    q.locator('#view-overview h1').wait_for(timeout=16000)
    hits=[]
    def counting(route):
        if route.request.method!='OPTIONS':hits.append(1)
        fake_groq(route)
    q.route('https://api.groq.com/**',counting)
    setup_vault(q)
    screen(q,'chat')
    q.locator('#chat-route').select_option('groq')
    # Double submit inside one stretched save: one message, one request.
    q.evaluate("window.__delayWrites=true;window.__delayMs=1500")
    q.locator('#chat-input').fill('QA double-submit guard message')
    q.locator('#send-chat').click()
    q.evaluate("document.querySelector('#chat-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))")
    q.wait_for_function("document.querySelector('#toast').textContent.includes('already in progress')",timeout=10000)
    q.wait_for_function("document.querySelector('#chat-messages').textContent.includes('SYNTHETIC ACCEPTANCE RESPONSE')",timeout=20000)
    verify(q.locator('#chat-messages .bubble.user').count()==1,'Double submit recorded two user messages')
    verify(len(hits)==1,'Double submit dispatched two provider requests')
    verify(q.locator('#send-chat').is_enabled(),'Send was not re-enabled after the guarded send')
    # Let the response's debounced save settle before breaking writes.
    q.evaluate("window.__delayWrites=false")
    q.wait_for_timeout(800)
    # Failed save plus a second submit attempt: the thread keeps exactly
    # its one prior user message, the prompt returns, nothing dispatches.
    q.evaluate("window.__breakWrites=true;window.__breakMessage='synthetic chat-save failure'")
    q.locator('#chat-input').fill('QA failed-save guard message')
    q.locator('#send-chat').click()
    q.evaluate("document.querySelector('#chat-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))")
    q.wait_for_function("document.querySelector('#toast').textContent.includes('not sent')",timeout=10000)
    verify(q.locator('#chat-messages .bubble.user').count()==1,'Failed save rollback removed the wrong message')
    verify(q.locator('#chat-input').input_value()=='QA failed-save guard message','Failed save did not restore the prompt')
    verify(q.locator('#send-chat').is_enabled(),'Send was not re-enabled after the failed save')
    verify(len(hits)==1,'Provider was called despite the failed save')
    verify(not errors,'Page errors on the chat concurrency page: '+str(errors))
    ctx.close()
CASES=[
 ('12-screen navigation and command palette',check_navigation),
 ('Workspace projects, files, runner, snapshots, JSON ZIP and import/export',check_workspace),
 ('Q25 bounded local image/audio and byte-exact JSON ZIP roundtrip',check_q25_binary_project_assets),
 ('P13 nested explorer and collision-safe folder relocation',check_folder_management),
 ('P23 snapshot compare, pin, rename, export and safe deletion',check_snapshot_management),
 ('Isolated HTML preview tabs',check_html_preview),
 ('P04 linked local CSS and classic scripts in original order',check_linked_preview),
 ('Eight provider directory records and setup navigation',check_providers),
 ('Q26 validated local provider presets without network calls',check_q26_provider_model_presets),
 ('Vault locked typing, encryption, persistence, wrong password, removal and wipe',check_vault),
 ('Q21 encrypted vault export/import and passphrase rotation',check_vault_portability),
 ('Vault mutations commit before adoption under storage failure',check_vault_commit_before_adopt),
 ('Mocked API adapter through chat, history, audit and export',check_chat),
 ('Failed and stopped chat requests do not restore the prompt or duplicate the message',check_chat_retry_no_duplicate),
 ('Chat prompt persists before provider dispatch, compare send, failed-save gate',check_chat_persist_before_dispatch),
 ('Chat double submit during save is guarded, failed save rolls back exactly',check_chat_double_submit_guard),
 ('Q22 network-free diagnostics and manual retry draft',check_local_connection_diagnostics_and_manual_retry),
 ('P14 local conversation search edit export delete',check_chat_management),
 ('Mocked three-stage workflow and stage cap',check_workflows),
 ('Knowledge note creation, retrieval, chat insertion and archive roundtrip',check_knowledge),
 ('Q24 paged local Knowledge search beyond prior 70-result truncation',check_paged_knowledge),
 ('P15 explicit note edit/cancel and exact duplicate report',check_note_edit_and_duplicates),
 ('D13 live knowledge after project-file edits',check_knowledge_freshness),
 ('P16 cross-project knowledge search and live context',check_cross_project_knowledge),
 ('Data CSV/JSON/WASM/chart/error and export',check_data),
 ('P18/P19 named datasets, transformations, undo and backup roundtrip',check_data_persistence_transforms),
 ('D09 dynamic health and P17 paginated data/chart coverage',check_health_and_data_pages),
 ('Canvas media adjustments, PNG and speech controls',check_media),
 ('Preferences, backup, restore rejection, persisted settings and reset',check_settings),
 ('Capability inventory truth labels',check_capabilities),
 ('Q27 local WebGPU adapter readiness without inference',check_q27_local_webgpu_readiness),
 ('Mobile navigation interactions',check_mobile),
]
def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--base-url',default='http://127.0.0.1:8000')
    args=parser.parse_args()
    with sync_playwright() as pw:
        browser=pw.chromium.launch(headless=True,args=['--no-sandbox'])
        for title,fn in CASES:
            context=browser.new_context(accept_downloads=True,viewport={'width':1360,'height':860})
            page=context.new_page()
            errors=[]
            page.on('pageerror',lambda e:errors.append(str(e)))
            try:
                page.goto(args.base_url,timeout=25000)
                page.locator('#view-overview h1').wait_for(timeout=16000)
                fn(page)
                verify(not errors,'JavaScript page errors: '+str(errors)[:400])
                PASS.append(title)
                print('PASS:',title,flush=True)
            except Exception as exc:
                FAIL.append(title)
                print('FAIL:',title,traceback.format_exc()[-1800:],flush=True)
            finally:
                context.close()
        browser.close()
    print('BROAD QA RESULT: %d passed / %d failed / %d cases'%(len(PASS),len(FAIL),len(CASES)),flush=True)
    if FAIL:print('FAILED CASES: '+'; '.join(FAIL),flush=True)
    print('LIVE_PROVIDER_AUTH: NOT EXECUTED without repository Actions secret; mocked adapter results must not be represented as live calls',flush=True)
    return 1 if FAIL else 0
if __name__=='__main__':sys.exit(main())
