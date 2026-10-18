"""Read-only smoke on the deployed dashboard. Does not save a template."""
import os
import pathlib
from playwright.sync_api import sync_playwright, expect
base = os.environ['E2E_BASE_URL']
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 1100})
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(base)
    page.wait_for_load_state('networkidle')
    page.get_by_label('Username', exact=True).fill(os.environ['E2E_USERNAME'])
    page.get_by_label('Password', exact=True).fill(os.environ['E2E_PASSWORD'])
    page.get_by_role('button', name='Sign in', exact=True).click()
    page.get_by_role('heading', name='Workspace overview').wait_for()
    page.get_by_role('link', name='Embed builder', exact=True).click()
    page.wait_for_load_state('networkidle')
    response = page.request.get(base + '/api/templates')
    assert response.ok
    templates = response.json()
    picker = page.get_by_role('button', name='Accent color', exact=True)
    before = picker.inner_text()
    assert page.locator('input[type="color"]').count() == 0
    picker.click()
    dialog = page.get_by_role('dialog', name='Accent color picker', exact=True)
    expect(dialog).to_be_visible()
    page.get_by_role('button', name='Emerald #2ECC71', exact=True).click()
    expect(picker).to_contain_text('#2ECC71')
    assert page.locator('.discord-message').evaluate('(e) => getComputedStyle(e).borderLeftColor') == 'rgb(46, 204, 113)'
    page.keyboard.press('Escape')
    expect(dialog).not_to_be_visible()
    picker.click()
    page.screenshot(path='artifacts/color-picker/production-picker.png', full_page=True)
    dialog.screenshot(path='artifacts/color-picker/color-picker.png')
    page.keyboard.press('Escape')
    assert page.request.get(base + '/api/templates').json() == templates
    secure = page.evaluate('({secure: isSecureContext, uuid: typeof globalThis.crypto?.randomUUID})')
    if base.startswith('http://') and 'localhost' not in base and '127.0.0.1' not in base:
        assert secure == {'secure': False, 'uuid': 'undefined'}
    pathlib.Path('artifacts/color-picker').mkdir(parents=True, exist_ok=True)
    page.screenshot(path='artifacts/color-picker/production-preview.png', full_page=True)
    me = page.request.get(base + '/api/me').json()
    assert page.request.post(base + '/api/logout', headers={'Origin': base, 'x-csrf-token': me['csrf']}, data={}).ok
    assert not errors, errors
    browser.close()
print('PASS: deployed in-app picker and live preview work on LAN HTTP. Production templates unchanged; test session revoked.')
