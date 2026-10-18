"""Browser verification against an isolated QA database; never logs credentials."""
import os, json, pathlib
from playwright.sync_api import sync_playwright, expect
base = os.environ['E2E_BASE_URL']
assert base == 'http://127.0.0.1:3010'
out = pathlib.Path('artifacts/room-controls'); out.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width':1440,'height':1100})
    page = context.new_page(); errors=[]
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(base); page.wait_for_load_state('networkidle')
    page.get_by_label('Username', exact=True).fill(os.environ['E2E_USERNAME'])
    page.get_by_label('Password', exact=True).fill(os.environ['E2E_PASSWORD'])
    page.get_by_role('button', name='Sign in', exact=True).click()
    page.get_by_role('heading', name='Workspace overview').wait_for()
    page.get_by_role('link', name='Queue configuration', exact=True).click(); page.wait_for_load_state('networkidle')
    section=page.locator('section',has=page.get_by_role('heading',name='Waiting Room Alerts',exact=True))
    expect(section.get_by_label('Grace Period (seconds)',exact=True)).to_have_value(str(page.request.get(base+'/api/settings').json()['waitingRoomAlerts']['graceSeconds']))
    expect(section.get_by_label('Alert Cooldown (seconds)',exact=True)).to_have_value('300')
    section.get_by_label('Waiting Voice Channels',exact=True).locator('option').first.wait_for(state='attached',timeout=30000)
    choices=section.get_by_label('Waiting Voice Channels',exact=True).locator('option').count()
    assert choices>0, 'Actual bound voice channel choices must load'
    settings_before=page.request.get(base+'/api/settings').json()
    changed_grace=32 if settings_before['waitingRoomAlerts']['graceSeconds']==31 else 31
    section.get_by_label('Grace Period (seconds)',exact=True).fill(str(changed_grace))
    with page.expect_response(lambda r:'/api/settings' in r.url and r.request.method=='POST') as save_response:
        section.get_by_role('button',name='Save waiting room alerts',exact=True).click()
    assert save_response.value.ok, save_response.value.status
    saved=page.request.get(base+'/api/settings').json()
    assert saved['waitingRoomAlerts']['graceSeconds']==changed_grace
    assert saved['taRole']==settings_before['taRole']
    section.get_by_role('button',name='Check permissions',exact=True).click()
    expect(section.get_by_text('Operation queued:',exact=False)).to_be_visible()
    ops=page.request.get(base+'/api/operations').json()
    assert any(o['action']=='waiting_alert_check' for o in ops)
    page.screenshot(path=str(out/'waiting-alerts-desktop.png'),full_page=True)
    for width in [375,768]:
        page.set_viewport_size({'width':width,'height':1000}); page.wait_for_timeout(250)
        section.get_by_label('Grace Period (seconds)',exact=True).scroll_into_view_if_needed()
        page.screenshot(path=str(out/f'waiting-alerts-{width}.png'),full_page=True)
        for name in ['Save waiting room alerts','Validate config','Check permissions','Send test alert']:
            button=section.get_by_role('button',name=name,exact=True)
            button.scroll_into_view_if_needed()
            rect=button.bounding_box()
            assert rect['x']>=0 and rect['x']+rect['width']<=width+1, f'Clipped {name} at {width}'
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth+2'), f'Horizontal overflow at {width}'
    page.set_viewport_size({'width':1440,'height':1100})
    page.get_by_role('link',name='Embed builder',exact=True).click();page.wait_for_load_state('networkidle')
    templates=page.request.get(base+'/api/templates').json()
    room=next(t for t in templates if t['name']=='Custom controls browser fixture')
    page.get_by_label('Panel template',exact=True).select_option(room['id'])
    page.get_by_role('button',name='Restore default room controls',exact=True).click()
    assert page.get_by_label('Action',exact=True).count()==10
    assert page.get_by_label('Label',exact=True).first.input_value()=='เปิดรับคิว'
    with page.expect_response(lambda r:'/api/templates' in r.url and r.request.method=='POST') as saved_response:
        page.get_by_role('button',name='Save draft',exact=True).click()
    assert saved_response.value.ok
    after=next(t for t in page.request.get(base+'/api/templates').json() if t['id']==room['id'])
    assert after['document']['title']==room['document']['title']
    assert after['document']['description']==room['document']['description']
    assert len(after['document']['buttons'])==10
    assert room['version']<after['version']
    assert any(v['document']==room['document'] for v in after['versions'])
    alert=next(t for t in templates if t['feature']=='waiting_room_alert')
    page.get_by_label('Panel template',exact=True).select_option(alert['id'])
    expect(page.get_by_label('Title',exact=True)).to_have_value('🔔・แจ้งเตือนนักศึกษารอตรวจงาน')
    page.screenshot(path=str(out/'room-controls-builder.png'),full_page=True)
    assert not errors, errors
    csrf=page.request.get(base+'/api/me').json()['csrf']
    assert page.request.post(base+'/api/logout',headers={'Origin':base,'x-csrf-token':csrf}).ok
    context.close();browser.close()
    (out/'browser-result.json').write_text(json.dumps({'passed':True,'viewports':[375,768,1440],'actualChannelChoices':choices,'checks':['saved alert settings','diagnostic operation','room control restore','custom text and versions preserved','notification template','no browser errors','logout']}))
    print('Browser checks passed: alerts, controls, preserved template history, 3 viewports.')
