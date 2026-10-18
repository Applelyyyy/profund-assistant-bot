"""Isolated browser check: mock Discord directory/preview, never publish or save configuration."""
import json, os, pathlib, subprocess
from playwright.sync_api import sync_playwright, expect

base = os.environ['E2E_BASE_URL']
assert base == 'http://127.0.0.1:3011'
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 1440, 'height': 1000})
    page = context.new_page()
    reads, errors = [], []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('request', lambda r: reads.append(r.url.split('/api/')[-1]) if r.method == 'GET' and '/api/' in r.url else None)
    page.route('**/api/directory', lambda r: r.fulfill(json={'channels': [{'id': '100000000000000011', 'name': 'Synthetic TA room', 'type': 2}], 'roles': []}))
    page.route('**/api/room-panels/preview', lambda r: r.fulfill(json={'warnings': [], 'changes': [], 'fingerprint': 'synthetic-preview', 'inspectionPreview': {'visibility': 'PUBLIC', 'fullStudentIds': False, 'content': 'ขณะนี้ไม่มีนักศึกษากำลังตรวจงาน'}}))
    try:
        page.goto(base)
        page.wait_for_load_state('networkidle')
        page.get_by_label('Username', exact=True).fill(os.environ['E2E_USERNAME'])
        page.get_by_label('Password', exact=True).fill(os.environ['E2E_PASSWORD'])
        page.get_by_role('button', name='Sign in', exact=True).click()
        page.get_by_role('heading', name='Workspace overview').wait_for()
        page.get_by_role('link', name='Discord channels', exact=True).click()
        page.wait_for_load_state('networkidle')
        page.wait_for_timeout(1500)
        counts = []
        for _ in range(5):
            section = page.locator('section').filter(has=page.get_by_role('heading', name='TA Inspection Rooms', exact=True))
            section.get_by_role('button', name='Edit', exact=True).click()
            modal = page.get_by_role('dialog')
            expect(modal.get_by_label('Visibility', exact=True)).to_have_value('PUBLIC')
            begin = len(reads)
            modal.get_by_role('button', name='Preview & publish', exact=True).click()
            expect(page.get_by_role('heading', name='Inspection preview', exact=True)).to_be_visible()
            page.wait_for_timeout(700)
            counts.append([r for r in reads[begin:] if r in ['overview', 'settings', 'bindings']])
            page.get_by_role('dialog').get_by_role('button', name='Cancel', exact=True).click()
            page.get_by_role('dialog').get_by_role('button', name='Close dialog', exact=True).click()
        burst_reads = []
        if os.environ.get('CONCURRENT_EVENTS_ENV'):
            page.get_by_role('link', name='Overview', exact=True).click()
            page.wait_for_load_state('networkidle')
            page.wait_for_timeout(2500)
            begin = len(reads)
            subprocess.run(['node', '--env-file=' + os.environ['CONCURRENT_EVENTS_ENV'], '--import', 'tsx', 'tests/fixtures/concurrent-events.ts'], check=True, capture_output=True)
            page.wait_for_timeout(5000)
            burst_reads = reads[begin:]
            assert 'overview' in burst_reads, burst_reads
        assert not errors, errors
        if os.environ.get('EXPECT_OPTIMIZED') == 'true':
            assert all(not requests for requests in counts), counts
            assert 'analytics' not in burst_reads, burst_reads
        pathlib.Path(os.environ['CONCURRENT_BROWSER_OUTPUT']).write_text(json.dumps({'previewSamples': 5, 'unrelatedReadsPerPreview': counts, 'claimBurstReads': burst_reads, 'noBrowserErrors': True, 'discordMocked': True, 'configurationSaved': False}, indent=2))
        print('Browser preview checks passed; unrelated read counts recorded. No configuration saved.')
    finally:
        me = page.request.get(base + '/api/me')
        if me.ok:
            assert page.request.post(base + '/api/logout', headers={'Origin': base, 'x-csrf-token': me.json()['csrf']}).ok
        context.close()
        browser.close()
