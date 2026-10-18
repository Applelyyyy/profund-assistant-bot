"""Browser verification against an isolated QA database; never logs credentials."""
import os, json, pathlib
from playwright.sync_api import sync_playwright, expect
base = os.environ['E2E_BASE_URL']
assert base == 'http://127.0.0.1:3010'
out = pathlib.Path('artifacts/no-show'); out.mkdir(parents=True, exist_ok=True)
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
    page.get_by_role('tab',name='Abandoned Queue',exact=True).click()
    expect(page.get_by_role('heading',name='Abandoned Queue Alerts',exact=True)).to_be_visible()
    page.get_by_role('tab',name='Abandoned Queue',exact=True).press('ArrowRight')
    expect(page.get_by_role('heading',name='Queue Operation Alerts',exact=True)).to_be_visible()
    page.get_by_role('tab',name='Waiting Room',exact=True).click()
    section.get_by_label('Grace Period (seconds)',exact=True).fill('33')
    page.get_by_role('tab',name='Operations',exact=True).click()
    page.get_by_role('tab',name='Waiting Room',exact=True).click()
    expect(section.get_by_label('Grace Period (seconds)',exact=True)).to_have_value('33')
    section.get_by_role('button',name='Preview alert',exact=False).click()
    expect(section.get_by_text('🔔・แจ้งเตือนนักศึกษารอตรวจงาน',exact=True)).to_be_visible()
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
    expect(section.get_by_text('Request queued.',exact=False)).to_be_visible()
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
    notice=page.locator('section.panel',has=page.get_by_role('heading',name='No Show notifications',exact=True))
    toggle=notice.get_by_label('Send a private No Show notification to the student',exact=True)
    toggle.uncheck()
    notice.get_by_role('button',name='Save changes',exact=False).click()
    page.wait_for_timeout(500)
    assert page.request.get(base+'/api/settings').json()['noShowDMEnabled'] is False
    page.get_by_role('link',name='Roles & Access',exact=True).click();page.wait_for_load_state('networkidle')
    access=page.get_by_role('group',name='Student Channel Access',exact=True)
    expect(access.get_by_label('Allow Teaching Assistants to View Student Channels',exact=True)).to_be_checked()
    expect(access.get_by_label('Student channel exceptions',exact=True)).to_be_enabled()
    expect(access.get_by_label('TA waiting voice connections',exact=True)).to_be_enabled()
    assert access.get_by_label('TA waiting voice connections',exact=True).locator('option').count()>0
    page.get_by_role('button',name='Save Configuration',exact=True).click()
    dialog=page.get_by_role('dialog',name='Review Discord permission changes',exact=True)
    expect(dialog).to_be_visible(timeout=30000)
    expect(dialog.get_by_text('TA role without Student role',exact=True).first).to_be_visible()
    expect(dialog.get_by_role('button',name='Confirm save & sync',exact=True)).to_be_enabled()
    dialog.get_by_role('button',name='Cancel',exact=True).click()
    page.screenshot(path=str(out/'student-channel-access.png'),full_page=True)
    for width in [375,768]:
        page.set_viewport_size({'width':width,'height':1000})
        access.scroll_into_view_if_needed()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth+2'), f'Access overflow at {width}'
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
    expect(page.get_by_role('button',name='Save draft',exact=True)).to_be_enabled(timeout=30000)
    page.wait_for_load_state('networkidle')
    after=next(t for t in page.request.get(base+'/api/templates').json() if t['id']==room['id'])
    assert after['document']['title']==room['document']['title']
    assert after['document']['description']==room['document']['description']
    assert len(after['document']['buttons'])==10
    assert room['version']<after['version']
    assert any(v['document']==room['document'] for v in after['versions'])
    assert any(b['action']=='MARK_STUDENT_NO_SHOW' and b['label']=='นักศึกษาไม่ตอบกลับ' for b in after['document']['buttons'])
    dm=next(t for t in templates if t['feature']=='no_show_dm')
    page.get_by_label('Panel template',exact=True).select_option(dm['id'])
    expect(page.get_by_role('heading',name='No Show DM',exact=True)).to_be_visible()
    assert page.get_by_role('button',name='Publish',exact=True).count()==0
    expect(page.get_by_label('Title',exact=True)).to_have_value('🔔・แจ้งเตือนสถานะการตรวจงาน')
    page.get_by_role('button',name='Save draft',exact=True).click()
    expect(page.get_by_role('button',name='Save draft',exact=True)).to_be_enabled(timeout=30000)
    page.wait_for_load_state('networkidle')
    page.screenshot(path=str(out/'no-show-template.png'),full_page=True)
    alert=next(t for t in templates if t['feature']=='waiting_room_alert')
    page.get_by_label('Panel template',exact=True).select_option(alert['id'])
    expect(page.get_by_label('Title',exact=True)).to_have_value('🔔・แจ้งเตือนนักศึกษารอตรวจงาน')
    page.screenshot(path=str(out/'room-controls-builder.png'),full_page=True)
    assert not errors, errors
    csrf=page.request.get(base+'/api/me').json()['csrf']
    assert page.request.post(base+'/api/logout',headers={'Origin':base,'x-csrf-token':csrf}).ok
    context.close();browser.close()
    (out/'browser-result.json').write_text(json.dumps({'passed':True,'viewports':[375,768,1440],'actualChannelChoices':choices,'checks':['alert type separation and keyboard navigation','unsaved tab draft preserved','actual alert preview','saved alert settings','diagnostic operation','No Show notification toggle persisted','TA visibility permission preview with real channels','room control restore','custom text and versions preserved','No Show DM template save','no browser errors','logout']}))
    print('Browser checks passed: alerts, controls, preserved template history, 3 viewports.')
