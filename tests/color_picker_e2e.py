"""Real browser and PostgreSQL tests. Requires isolated QA server on port 3010."""
import os
import json
import pathlib
from playwright.sync_api import sync_playwright, expect

base = os.environ['E2E_BASE_URL']
assert base == 'http://127.0.0.1:3010', 'Use an isolated QA server'
artifacts = pathlib.Path('artifacts/color-picker')
artifacts.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 1440, 'height': 1100})
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(base)
    page.wait_for_load_state('networkidle')
    page.get_by_label('Username', exact=True).fill(os.environ['E2E_USERNAME'])
    page.get_by_label('Password', exact=True).fill(os.environ['E2E_PASSWORD'])
    page.get_by_role('button', name='Sign in', exact=True).click()
    page.get_by_role('heading', name='Workspace overview').wait_for()
    page.on('console', lambda message: errors.append(message.text) if message.type == 'error' else None)
    page.get_by_role('link', name='Embed builder', exact=True).click()
    page.wait_for_load_state('networkidle')
    def get(path):
        response = page.request.get(base + '/api/' + path)
        assert response.ok, (path, response.status)
        return response.json()
    templates = get('templates')
    fixture = next(t for t in templates if t['name'] == 'Color picker browser fixture')
    original = fixture['document']
    picker = page.get_by_role('button', name='Accent color', exact=True)
    def select_template(template):
        page.get_by_label('Panel template', exact=True).select_option(template['id'])
        expect(picker).to_contain_text(template['document']['color'].upper())
    select_template(fixture)
    assert page.locator('input[type="color"]').count() == 0
    def preview_color():
        return page.locator('.discord-message').evaluate('(e) => getComputedStyle(e).borderLeftColor')
    picker.click()
    popup = page.get_by_role('dialog', name='Accent color picker', exact=True)
    expect(popup).to_be_visible()
    expect(page.get_by_label('HEX color', exact=True)).to_have_value('#123456')
    # Picker motion and keyboard update the shared draft preview.
    area = popup.locator('.react-colorful__saturation').bounding_box()
    before = preview_color()
    page.mouse.move(area['x'] + 10, area['y'] + 10)
    page.mouse.down()
    page.mouse.move(area['x'] + area['width'] * .75, area['y'] + area['height'] * .25, steps=10)
    page.mouse.up()
    assert preview_color() != before
    hue = page.get_by_role('slider', name='Hue', exact=True)
    hue.focus()
    before = preview_color()
    hue.press('ArrowRight')
    assert preview_color() != before
    saturation = page.get_by_role('slider', name='Color', exact=True)
    saturation.focus()
    before = preview_color()
    saturation.press('ArrowLeft')
    assert preview_color() != before
    # Partial values stay visible and cannot replace the last valid selection.
    hex_input = page.get_by_label('HEX color', exact=True)
    hex_input.fill('#2ECC71')
    expect(picker).to_contain_text('#2ECC71')
    assert preview_color() == 'rgb(46, 204, 113)'
    for invalid in ['#', '#12', '#ZZZZZZ']:
        hex_input.fill(invalid)
        expect(hex_input).to_have_value(invalid)
        expect(popup.get_by_role('alert')).to_contain_text('last valid color stays selected')
        expect(popup.get_by_role('button', name='Apply', exact=True)).to_be_disabled()
        assert preview_color() == 'rgb(46, 204, 113)'
    hex_input.fill('#abc')
    expect(picker).to_contain_text('#AABBCC')
    assert preview_color() == 'rgb(170, 187, 204)'
    page.get_by_role('button', name='Discord Blurple #5865F2', exact=True).click()
    expect(hex_input).to_have_value('#5865F2')
    expect(page.get_by_role('button', name='Discord Blurple #5865F2', exact=True)).to_have_attribute('aria-pressed', 'true')
    # Format switches only display conversions, never change the color.
    page.get_by_role('button', name='RGB', exact=True).click()
    expect(page.get_by_label('RGB R', exact=True)).to_have_value('88')
    page.get_by_label('RGB R', exact=True).fill('255')
    page.get_by_label('RGB G', exact=True).fill('0')
    page.get_by_label('RGB B', exact=True).fill('0')
    expect(picker).to_contain_text('#FF0000')
    page.get_by_role('button', name='HSL', exact=True).click()
    expect(page.get_by_label('HSL H', exact=True)).to_have_value('0')
    expect(page.get_by_label('HSL S', exact=True)).to_have_value('100')
    expect(page.get_by_label('HSL L', exact=True)).to_have_value('50')
    page.get_by_label('HSL H', exact=True).fill('120')
    expect(picker).to_contain_text('#00FF00')
    page.get_by_label('HSL H', exact=True).fill('361')
    expect(popup.get_by_role('button', name='Apply', exact=True)).to_be_disabled()
    expect(picker).to_contain_text('#00FF00')
    page.get_by_role('button', name='HEX', exact=True).click()
    page.get_by_role('button', name='Reset', exact=True).click()
    expect(picker).to_contain_text('#7879F1')
    page.get_by_role('button', name='Emerald #2ECC71', exact=True).click()
    page.screenshot(path=str(artifacts / 'picker-dark-desktop.png'), full_page=True)
    page.get_by_role('button', name='Apply', exact=True).click()
    expect(popup).not_to_be_visible()
    expect(picker).to_be_focused()
    assert next(t for t in get('templates') if t['id'] == fixture['id'])['document'] == original, 'Apply must not claim to save'
    with page.expect_response(lambda r: '/api/templates/' + fixture['id'] in r.url and r.request.method == 'POST') as saved:
        page.get_by_role('button', name='Save draft', exact=True).click()
    assert saved.value.ok
    expect(page.get_by_role('button', name='Save draft', exact=True)).to_be_enabled()
    actual = next(t for t in get('templates') if t['id'] == fixture['id'])
    assert actual['document']['color'] == '#2ECC71'
    assert {**actual['document'], 'color': original['color']} == original
    page.reload()
    page.wait_for_load_state('networkidle')
    select_template(actual)
    assert preview_color() == 'rgb(46, 204, 113)'
    # Publication references the saved template, not another local color draft.
    page.get_by_label('Target Discord channel', exact=True).select_option(os.environ['E2E_PUBLISH_CHANNEL'])
    with page.expect_response(lambda r: '/api/templates/' + fixture['id'] + '/publish' in r.url and r.request.method == 'POST') as published:
        page.get_by_role('button', name='Publish / republish', exact=True).click()
    assert published.value.ok
    expect(page.get_by_role('button', name='Publish / republish', exact=True)).to_be_enabled()
    assert next(t for t in get('templates') if t['id'] == fixture['id'])['panels'][0]['templateId'] == fixture['id']
    picker.click()
    expect(page.get_by_role('button', name='Recent color #2ECC71', exact=True)).to_be_visible()
    page.keyboard.press('Escape')
    expect(popup).not_to_be_visible()
    expect(picker).to_be_focused()
    picker.press('Enter')
    expect(popup).to_be_visible()
    assert popup.evaluate('(e) => e.contains(document.activeElement)')
    page.keyboard.press('Tab')
    expect(page.get_by_role('slider', name='Color', exact=True)).to_be_focused()
    page.get_by_label('Title', exact=True).click()
    expect(popup).not_to_be_visible()
    # Existing templates preserve their original values.
    for template in [t for t in templates if t["id"] != fixture["id"]][:3]:
        select_template(template)
        picker.click()
        expect(page.get_by_label('HEX color', exact=True)).to_have_value(template['document']['color'].upper())
        page.keyboard.press('Escape')
    select_template(actual)
    # Browser persistence remains optional, bounded and deduplicated.
    stored = page.evaluate('JSON.parse(localStorage.getItem("ta-accent-colors"))')
    assert len(stored) <= 8 and len(set(stored)) == len(stored)
    page.evaluate('localStorage.setItem("ta-accent-colors", "broken-json")')
    page.reload()
    page.wait_for_load_state('networkidle')
    select_template(actual)
    picker.click()
    expect(popup).to_be_visible()
    page.keyboard.press('Escape')
    # Light theme uses the same controls.
    page.evaluate('document.documentElement.dataset.theme = "light"')
    picker.click()
    assert popup.evaluate('(e) => getComputedStyle(e).backgroundColor') == 'rgb(255, 255, 255)'
    page.screenshot(path=str(artifacts / 'picker-light-desktop.png'), full_page=True)
    page.keyboard.press('Escape')
    # Real touch input, narrow width and short viewport collision handling.
    mobile = browser.new_context(viewport={'width': 390, 'height': 844}, has_touch=True, is_mobile=True, storage_state=context.storage_state())
    touch_page = mobile.new_page()
    touch_page.on('pageerror', lambda error: errors.append(str(error)))
    touch_page.goto(base + '/?view=embeds')
    touch_page.wait_for_load_state('networkidle')
    touch_page.get_by_label('Panel template', exact=True).select_option(fixture['id'])
    touch_picker = touch_page.get_by_role('button', name='Accent color', exact=True)
    touch_picker.click()
    touch_popup = touch_page.get_by_role('dialog', name='Accent color picker', exact=True)
    expect(touch_popup).to_be_visible()
    bounds = touch_popup.bounding_box()
    assert bounds['x'] >= 0 and bounds['x'] + bounds['width'] <= 390
    assert bounds['y'] >= 0 and bounds['y'] + bounds['height'] <= 844
    touch_area = touch_popup.locator('.react-colorful__saturation').bounding_box()
    prior = touch_picker.inner_text()
    touch_page.touchscreen.tap(touch_area['x'] + touch_area['width'] * .3, touch_area['y'] + touch_area['height'] * .5)
    assert touch_picker.inner_text() != prior
    assert touch_page.locator('body').evaluate('(e) => e.scrollWidth <= innerWidth')
    touch_page.screenshot(path=str(artifacts / 'picker-mobile.png'), full_page=True)
    touch_page.keyboard.press('Escape')
    touch_page.set_viewport_size({'width': 390, 'height': 360})
    touch_picker.click()
    bounds = touch_popup.bounding_box()
    assert bounds['y'] >= 0 and bounds['y'] + bounds['height'] <= 360
    touch_popup.get_by_role('button', name='Apply', exact=True).click()
    expect(touch_popup).not_to_be_visible()
    mobile.close()
    assert not errors, errors
    me = get('me')
    assert page.request.post(base + '/api/logout', headers={'Origin': base, 'x-csrf-token': me['csrf']}, data={}).ok
    browser.close()
(artifacts / 'browser-result.json').write_text(json.dumps({'passed': True, 'production_mutations': 0, 'persisted_color': '#2ECC71', 'mouse_touch_keyboard': True}))
print('PASS: web picker, input validation, RGB/HSL, presets/recent/reset, live preview, saved PostgreSQL color, focus/dismissal and responsive touch layout.')
