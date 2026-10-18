"""Read-only operations UI smoke. Uses existing E2E_BASE_URL/USERNAME/PASSWORD.
Run against an initialized dashboard with an OWNER account; performs no cleanup.
"""
import json
import os
import pathlib
from playwright.sync_api import sync_playwright

base = os.environ.get('E2E_BASE_URL', 'http://127.0.0.1:3000')
artifacts = pathlib.Path('artifacts')
artifacts.mkdir(exist_ok=True)
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 1100})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(base)
    page.get_by_label('Username', exact=True).fill(os.environ['E2E_USERNAME'])
    page.get_by_label('Password', exact=True).fill(os.environ['E2E_PASSWORD'])
    page.get_by_role('button', name='Sign in', exact=True).click()
    page.get_by_role('heading', name='Workspace overview').wait_for()
    assert page.request.get(base + '/api/me').json()['role'] == 'OWNER'
    page.get_by_role('link', name='Roles & Access', exact=True).click()
    page.get_by_role('heading', name='Channel Visibility', exact=True).wait_for()
    assert page.get_by_role('button', name='Sync Channel Visibility', exact=True).is_enabled()
    page.get_by_role('link', name='Discord channels', exact=True).click()
    page.get_by_role('heading', name='TA Inspection Rooms', exact=True).wait_for()
    assert page.request.get(base + '/api/room-panels').ok
    templates = page.request.get(base + '/api/templates').json()
    assert any(t['feature'] == 'ta_room_queue_panel' for t in templates)
    page.get_by_role('link', name='System operations', exact=True).click()
    page.get_by_role('heading', name='Data Management', exact=True, level=2).wait_for()
    assert page.get_by_role('button', name='Preview Records', exact=True).is_enabled()
    assert page.request.get(base + '/api/data-management').ok
    page.screenshot(path=str(artifacts / 'operations-smoke-desktop.png'), full_page=True)
    page.set_viewport_size({'width': 390, 'height': 844})
    assert page.locator('body').evaluate('(element) => element.scrollWidth <= innerWidth')
    page.screenshot(path=str(artifacts / 'operations-smoke-mobile.png'), full_page=True)
    assert not errors, errors
    browser.close()
(artifacts / 'operations-smoke-result.json').write_text(json.dumps({'passed': True, 'mutations': 0}))
print('PASS: visibility, room panels and owner data-management controls; no data mutations.')
