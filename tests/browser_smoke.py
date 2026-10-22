"""Chromium smoke acceptance with step-level diagnostics and stable waits.

Runs on localhost or the deployed GitHub Pages URL. A policy-blocked browser
is reported as BLOCKED, never PASS. Does not require real provider credentials.
"""
import argparse
import sys
import traceback

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--base-url',default='http://127.0.0.1:8000')
    args=parser.parse_args()
    try:
        from playwright.sync_api import sync_playwright, expect
    except ImportError:
        print('BLOCKED: playwright Python package is not installed.',flush=True)
        return 2
    stage='initialize Chromium'
    page=None
    def checkpoint(name):
        nonlocal stage
        stage=name
        print('CHECK: '+name,flush=True)
    try:
        with sync_playwright() as pw:
            browser=pw.chromium.launch(headless=True,args=['--no-sandbox'])
            page=browser.new_page(viewport={'width':1360,'height':860})
            errors=[]
            page.on('pageerror',lambda error:errors.append(str(error)))
            checkpoint('open application')
            page.goto(args.base_url,wait_until='domcontentloaded',timeout=25000)
            expect(page.locator('#view-overview h1')).to_be_visible(timeout=15000)
            checkpoint('verify full startup completed without caught exceptions')
            page.wait_for_function("['ready','failed','degraded'].includes(document.documentElement.dataset.mmBoot)",timeout=15000)
            boot_status=page.evaluate('document.documentElement.dataset.mmBoot')
            assert boot_status=='ready',f'Application startup not ready: {boot_status}; toast={page.locator("#toast").inner_text()}'
            assert 'Initialization error' not in page.locator('#toast').inner_text()

            checkpoint('verify home page hero')
            expect(page.get_by_text('Build with a whole',exact=False)).to_have_count(1,timeout=10000)
            checkpoint('open code studio')
            page.get_by_role('button',name='Open code studio').click()
            expect(page.locator('#view-workspace')).to_be_visible(timeout=10000)
            checkpoint('run JavaScript worker')
            page.locator('#run-code').click()
            expect(page.locator('#console-output').get_by_text('Execution complete.',exact=False)).to_be_visible(timeout=10000)
            expect(page.locator('#console-output')).to_contain_text('2 + 2 = 4',timeout=10000)
            checkpoint('workshop diagnostics and editable local execution budget')
            expect(page.locator('#code-time-limit')).to_have_value('6000')
            page.locator('#code-time-limit').select_option('60000')
            expect(page.locator('#code-time-limit')).to_have_value('60000')
            page.locator('button.nav-item[data-view="capabilities"]').click()
            expect(page.locator('#workshop-metrics-summary')).to_contain_text('code-run: 1')
            expect(page.locator('#workshop-metrics-events')).to_contain_text('code-run')
            with page.expect_download(timeout=10000) as transfer:
                page.locator('#workshop-metrics-download').click()
            from json import loads
            report=loads(transfer.value.path().read_text())
            assert report['scope']=='in-memory-only'
            assert any(row['op']=='code-run' and row['ok']>=1 for row in report['byOperation'])
            assert 'Hello from Multi-Model Studio' not in str(report)
            page.locator('button.nav-item[data-view="workspace"]').click()
            checkpoint('preview HTML in isolated frame')
            page.locator('#preview-page').click()
            expect(page.frame_locator('#preview-host iframe').get_by_text('Hello from the browser workbench!')).to_have_count(1,timeout=12000)
            checkpoint('stop long-running worker')
            page.locator('#code-editor').fill('while(true){}')
            page.locator('#run-code').click()
            page.locator('#stop-code').click()
            expect(page.locator('#stop-code')).to_be_disabled(timeout=10000)
            checkpoint('mobile sidebar toggles')
            page.set_viewport_size({'width':375,'height':790})
            page.locator('#mobile-menu').click()
            print('NAV OPEN SNAPSHOT:',page.evaluate("() => ({ sidebar: document.querySelector('#sidebar').className, menuExpanded: document.querySelector('#mobile-menu').getAttribute('aria-expanded'), backdropHidden: document.querySelector('#nav-backdrop').hidden, activeView: document.querySelector('#current-view-label').textContent })"),flush=True)
            page.wait_for_function("document.querySelector('#sidebar').classList.contains('open')",timeout=10000)
            page.locator('#sidebar-close').click()
            page.wait_for_function("!document.querySelector('#sidebar').classList.contains('open')",polling=100,timeout=10000)
            checkpoint('P23 snapshot line-level comparison')
            page.set_viewport_size({'width':1280,'height':800})
            page.locator('#code-editor').fill('SNAPSHOT_BEFORE')
            page.once('dialog',lambda dialog:dialog.accept('P23 browser acceptance'))
            page.locator('#snapshot-project').click()
            expect(page.locator('#snapshot-select')).not_to_have_value('',timeout=10000)
            page.locator('#code-editor').fill('SNAPSHOT_AFTER')
            page.locator('#snapshot-action').select_option('compare')
            page.locator('#snapshot-action-run').click()
            expect(page.locator('#snapshot-comparison')).to_contain_text('-SNAPSHOT_BEFORE',timeout=10000)
            expect(page.locator('#snapshot-comparison')).to_contain_text('+SNAPSHOT_AFTER',timeout=10000)
            expect(page.locator('#code-editor')).to_have_value('SNAPSHOT_AFTER')
            checkpoint('JavaScript errors')
            if errors:
                raise AssertionError('Uncaught browser page errors: '+repr(errors))
            browser.close()
            print('PASS: browser navigation, isolated JavaScript, preview, stop and mobile menus',flush=True)
            return 0
    except Exception as error:
        blocked='ERR_BLOCKED_BY_ADMINISTRATOR' in str(error)
        print(('BLOCKED' if blocked else 'FAIL')+' at '+stage+': '+type(error).__name__+': '+repr(str(error)[:1600]),flush=True)
        traceback.print_exc()
        return 2 if blocked else 1

if __name__=='__main__':
    sys.exit(main())
