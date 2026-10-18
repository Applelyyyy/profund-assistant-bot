"""Read-only deployed dashboard checks; logout revokes this test session."""
import os,json,pathlib
from playwright.sync_api import sync_playwright,expect
base=os.environ['E2E_BASE_URL']
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True); context=browser.new_context(viewport={'width':1440,'height':1000});page=context.new_page();errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    try:
        page.goto(base);page.wait_for_load_state('networkidle')
        page.get_by_label('Username',exact=True).fill(os.environ['E2E_USERNAME']);page.get_by_label('Password',exact=True).fill(os.environ['E2E_PASSWORD'])
        page.get_by_role('button',name='Sign in',exact=True).click();page.get_by_role('heading',name='Workspace overview').wait_for()
        health=page.request.get(base+'/api/health').json()
        assert health['database'] and health['redis']
        assert all(any(s['service']==name and s['status']=='online' and s['online'] for s in health['services']) for name in ['bot','worker'])
        page.get_by_role('link',name='Queue configuration',exact=True).click();page.wait_for_load_state('networkidle')
        expect(page.get_by_role('heading',name='Waiting Room Alerts',exact=True)).to_be_visible()
        page.get_by_label('Waiting Voice Channels',exact=True).locator('option').first.wait_for(state='attached',timeout=30000)
        page.get_by_role('link',name='Embed builder',exact=True).click();page.wait_for_load_state('networkidle')
        templates=page.request.get(base+'/api/templates').json()
        room=next(t for t in templates if t['feature']=='ta_room_queue_panel')
        page.get_by_label('Panel template',exact=True).select_option(room['id'])
        expect(page.get_by_role('button',name='Restore default room controls',exact=True)).to_be_visible()
        assert any(t['feature']=='waiting_room_alert' for t in templates)
        assert not errors,errors
        pathlib.Path('artifacts/room-controls/deployed-smoke.json').write_text(json.dumps({'passed':True,'database':True,'redis':True,'bot':True,'worker':True,'alertConfiguration':True,'roomControlRestore':True,'notificationTemplate':True,'noBrowserErrors':True}))
        print('Deployed dashboard smoke passed: authenticated health, alert configuration, room controls and template. No configuration changed.')
    finally:
        me=page.request.get(base+'/api/me')
        if me.ok: page.request.post(base+'/api/logout',headers={'Origin':base,'x-csrf-token':me.json()['csrf']})
        context.close();browser.close()
