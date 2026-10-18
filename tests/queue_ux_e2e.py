"""Queue UX controls on an isolated QA database. Never run against production."""
import os
import pathlib
import json
from playwright.sync_api import sync_playwright, expect

base = os.environ['E2E_BASE_URL']
assert base == 'http://127.0.0.1:3010', 'Dedicated QA web port required'
artifacts = pathlib.Path('artifacts/queue-ux')
artifacts.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 1100})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('dialog', lambda dialog: dialog.accept())
    page.goto(base)
    page.wait_for_load_state('networkidle')
    page.get_by_label('Username', exact=True).fill(os.environ['E2E_USERNAME'])
    page.get_by_label('Password', exact=True).fill(os.environ['E2E_PASSWORD'])
    page.get_by_role('button', name='Sign in', exact=True).click()
    page.get_by_role('heading', name='Workspace overview').wait_for()
    page.wait_for_load_state('networkidle')
    def get(path):
        response = page.request.get(base + '/api/' + path)
        assert response.ok, (path, response.status)
        return response.json()
    def save(button, path):
        with page.expect_response(lambda r: '/api/' + path in r.url and r.request.method == 'POST') as response:
            button.click()
        assert response.value.ok, (path, response.value.status, response.value.text())
        page.wait_for_load_state('networkidle')
        expect(button).to_be_enabled()
    page.goto(base + '/?view=queue-config')
    page.wait_for_load_state('networkidle')
    notices = page.get_by_label('Routine call and arrival announcements (off by default)', exact=True)
    assert not notices.is_checked()
    notices.check()
    page.get_by_label('Public student IDs: HIDDEN, MASKED or FULL', exact=True).select_option('MASKED')
    save(page.get_by_role('button', name='Save changes', exact=True).nth(1), 'settings')
    assert get('settings')['routineAnnouncements'] is True
    assert get('settings')['publicStudentIds'] == 'MASKED'
    page.reload()
    page.wait_for_load_state('networkidle')
    assert notices.is_checked()
    notices.uncheck()
    page.get_by_label('Public student IDs: HIDDEN, MASKED or FULL', exact=True).select_option('HIDDEN')
    save(page.get_by_role('button', name='Save changes', exact=True).nth(1), 'settings')
    page.get_by_role('link', name='Roles & Access', exact=True).click()
    page.get_by_role('heading', name='Channel Visibility', exact=True).wait_for()
    assert page.locator('select[name="access-registration"]').is_disabled()
    assert page.locator('select[name="access-registration"]').input_value() == ''
    assert page.locator('select[name="access-registration"] option:checked').inner_text() == 'Unverified Only — Channel Visibility'
    page.get_by_role('link', name='Embed builder', exact=True).click()
    page.get_by_label('Panel template', exact=True).wait_for()
    templates = get('templates')
    default_room = next(t for t in templates if t['feature'] == 'ta_room_queue_panel' and t['name'] == 'TA_ROOM_QUEUE_PANEL')
    page.get_by_label('Panel template', exact=True).select_option(default_room['id'])
    page.get_by_label('Current inspection', exact=True).uncheck()
    assert 'กำลังตรวจงาน' not in page.locator('.discord-fields').inner_text()
    save(page.get_by_role('button', name='Save draft', exact=True), 'templates/' + default_room['id'])
    assert next(t for t in get('templates') if t['id'] == default_room['id'])['document']['roomLayout']['current'] is False
    page.get_by_label('Current inspection', exact=True).check()
    save(page.get_by_role('button', name='Save draft', exact=True), 'templates/' + default_room['id'])
    legacy = next(t for t in templates if t['name'] == 'QA preserved custom room')
    page.get_by_label('Panel template', exact=True).select_option(legacy['id'])
    expect(page.get_by_label('Panel template', exact=True)).to_have_value(legacy['id'])
    page.get_by_role('button', name='Add current inspection section', exact=True).click()
    save(page.get_by_role('button', name='Save draft', exact=True), 'templates/' + legacy['id'])
    saved = next(t for t in get('templates') if t['id'] == legacy['id'])
    assert saved['document']['title'] == 'Custom room title'
    assert saved['document']['description'] == 'Custom description preserved'
    assert any(f['value'] == '{room.current}' for f in saved['document']['fields'])
    assert saved['version'] > legacy['version']
    page.screenshot(path=str(artifacts / 'embed-editor-desktop.png'), full_page=True)
    page.set_viewport_size({'width': 390, 'height': 844})
    assert page.locator('body').evaluate('(e) => e.scrollWidth <= innerWidth'), 'Mobile overflow'
    page.screenshot(path=str(artifacts / 'embed-editor-mobile.png'), full_page=True)
    assert not errors, errors
    me = get('me')
    logout = page.request.post(base + '/api/logout', headers={'Origin': base, 'x-csrf-token': me['csrf']}, data={})
    assert logout.ok
    browser.close()
(artifacts / 'browser-result.json').write_text(json.dumps({'passed': True, 'production_mutations': 0}))
print('PASS: saved notification/privacy settings, room layout, opt-in custom migration, verification visibility UI and mobile layout.')
