"""Phone-viewport interaction gate (360x740) with step-level diagnostics.

Why this exists (2026-10-22 incidents):
- PR #56's drawing canvas was position:absolute over a position:static wrap,
  so it floated to the page center and at phone sizes covered the media
  "Select an image" button exactly; every desktop-sized check stayed green
  while the button was dead on the phone.
- Chat and Knowledge views overflowed sideways at 360/390/768 (fixed,
  non-wrapping rows and a nowrap import label inflating a grid track)
  while fitting perfectly at the desktop widths they were eyeballed at.

This gate drives the site the way the owner uses it: a 360x740 touch
viewport. For every view it asserts the page itself never scrolls sideways.
For Media tools it asserts the topmost element on the Select button is the
button, that clicking it opens the file chooser, that a real image loads
end to end, and that the draw layer lands exactly on the image preview.
A policy-blocked browser is reported as BLOCKED, never PASS.
"""
import argparse
import struct
import sys
import traceback
import zlib


def test_png(path):
    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)
    raw = b''.join(b'\x00' + bytes([200, 60, 60] * 64) for _ in range(64))
    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', 64, 64, 8, 2, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(raw))
           + chunk(b'IEND', b''))
    with open(path, 'wb') as fh:
        fh.write(png)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base-url', default='http://127.0.0.1:8000')
    args = parser.parse_args()
    try:
        from playwright.sync_api import sync_playwright, expect
    except ImportError:
        print('BLOCKED: playwright Python package is not installed.', flush=True)
        return 2
    stage = 'initialize Chromium'
    page = None

    def checkpoint(name):
        nonlocal stage
        stage = name
        print('CHECK: ' + name, flush=True)

    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True, args=['--no-sandbox'])
            context = browser.new_context(
                viewport={'width': 360, 'height': 740}, has_touch=True,
                user_agent='Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 '
                           '(KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36')
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            checkpoint('open application at 360x740')
            page.goto(args.base_url, wait_until='domcontentloaded', timeout=25000)
            page.wait_for_function(
                "['ready','failed','degraded'].includes(document.documentElement.dataset.mmBoot)",
                timeout=15000)
            boot = page.evaluate('document.documentElement.dataset.mmBoot')
            assert boot == 'ready', f'startup not ready: {boot}'

            views = page.evaluate(
                "[...document.querySelectorAll('button.nav-item[data-view]')].map(b => b.dataset.view)")
            assert 'media' in views, f'media view missing from nav: {views}'

            def open_view(view):
                menu = page.locator('#mobile-menu')
                if menu.is_visible():
                    menu.click()
                    page.wait_for_timeout(350)
                page.locator(f'button.nav-item[data-view="{view}"]').first.click()
                page.wait_for_selector(f'#view-{view}:not([hidden])', timeout=10000)
                page.wait_for_timeout(200)

            checkpoint('every view fits the phone viewport (no sideways page scroll)')
            overflowing = []
            for view in views:
                open_view(view)
                overflow = page.evaluate(
                    "Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)"
                    " - window.innerWidth")
                if overflow > 1:
                    overflowing.append(f'{view} +{overflow}px')
            assert not overflowing, \
                'views overflowing sideways at 360px wide: ' + ', '.join(overflowing)

            checkpoint('media: Select button is the topmost element at its own center')
            open_view('media')
            hit = page.evaluate("""() => {
              const label = document.querySelector('#view-media .file-input-label');
              const r = label.getBoundingClientRect();
              const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
              return el ? (el.id || String(el.className)) : 'null';
            }""")
            assert 'file-input-label' in hit or hit == 'media-image', \
                f'another element covers Select an image: {hit}'

            checkpoint('media: clicking Select opens the file chooser')
            with page.expect_file_chooser(timeout=5000):
                page.locator('#view-media .file-input-label').click()

            checkpoint('media: a real image loads end to end')
            test_png('/tmp/phone-gate-test.png')
            page.set_input_files('#media-image', '/tmp/phone-gate-test.png')
            page.wait_for_timeout(900)
            state = page.evaluate("""() => {
              const c = document.getElementById('media-canvas');
              return { w: c.width, h: c.height,
                       status: document.getElementById('media-resolution-status')?.textContent || '' };
            }""")
            assert state['w'] == 64 and state['h'] == 64, f'canvas not sized from image: {state}'
            assert 'Preview:' in state['status'], f'resolution status not populated: {state}'

            checkpoint('media: draw layer lands exactly on the image preview')
            rects = page.evaluate("""() => {
              const a = document.getElementById('media-canvas').getBoundingClientRect();
              const b = document.getElementById('media-draw-canvas').getBoundingClientRect();
              return { a: [a.x, a.y, a.width, a.height], b: [b.x, b.y, b.width, b.height] };
            }""")
            assert all(abs(x - y) <= 2 for x, y in zip(rects['a'], rects['b'])), \
                f'draw layer displaced from image: {rects}'

            assert not errors, f'page errors at phone viewport: {errors}'
            browser.close()
            print('PASS: phone-viewport gate — all views fit 360px, media select/draw verified by touch-size interaction', flush=True)
            return 0
    except Exception:
        print(f'FAIL at stage: {stage}', flush=True)
        traceback.print_exc()
        return 1


if __name__ == '__main__':
    sys.exit(main())
