"""Read-only deployed checks; does not modify settings or queue records."""
import os,json,pathlib
from playwright.sync_api import sync_playwright,expect
base=os.environ['E2E_BASE_URL']
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    context=browser.new_context(viewport={'width':1440,'height':1000})
    page=context.new_page();errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    try:
        page.goto(base);page.wait_for_load_state('networkidle')
        page.get_by_label('Username',exact=True).fill(os.environ['E2E_USERNAME'])
        page.get_by_label('Password',exact=True).fill(os.environ['E2E_PASSWORD'])
        page.get_by_role('button',name='Sign in',exact=True).click()
        page.get_by_role('heading',name='Workspace overview').wait_for()
        health=page.request.get(base+'/api/health').json()
        assert health['database'] and health['redis']
        assert all(any(s['service']==name and s['status']=='online' and s['online'] for s in health['services']) for name in ['bot','worker'])
        page.get_by_role('link',name='Queue configuration',exact=True).click();page.wait_for_load_state('networkidle')
        expect(page.get_by_role('heading',name='Waiting Room Alerts',exact=True)).to_be_visible()
        page.get_by_role('tab',name='Abandoned Queue',exact=True).click()
        expect(page.get_by_role('heading',name='Abandoned Queue Alerts',exact=True)).to_be_visible()
        page.get_by_role('tab',name='Operations',exact=True).click()
        expect(page.get_by_role('heading',name='Queue Operation Alerts',exact=True)).to_be_visible()
        expect(page.get_by_label('Send a private No Show notification to the student',exact=True)).to_be_checked()
        page.get_by_role('link',name='Roles & Access',exact=True).click();page.wait_for_load_state('networkidle')
        expect(page.get_by_label('Allow Teaching Assistants to View Student Channels',exact=True)).to_be_checked()
        page.get_by_role('link',name='Embed builder',exact=True).click();page.wait_for_load_state('networkidle')
        templates=page.request.get(base+'/api/templates').json()
        room=next(t for t in templates if t['feature']=='ta_room_queue_panel')
        page.get_by_label('Panel template',exact=True).select_option(room['id'])
        page.get_by_text('Dynamic placeholders',exact=True).click()
        for key in ['student_id','student_name','coursework','ticket','ta','status']:
            expect(page.get_by_text('{room.current.'+key+'}',exact=True)).to_be_visible()
        expect(page.get_by_text('Full Student IDs require TA-only access or an acknowledged Full Inspection Details policy',exact=False)).to_be_visible()
        assert not errors,errors
        pathlib.Path('artifacts/student-id/deployed-smoke.json').write_text(json.dumps({'passed':True,'database':True,'redis':True,'bot':True,'worker':True,'alertTabs':True,'noShowDMEnabled':True,'taStudentVisibilityEnabled':True,'roomStudentPlaceholders':6,'noBrowserErrors':True}))
        print('Deployed dashboard passed authenticated health, alert tabs, No Show settings, TA visibility and six room student placeholders. No configuration changed.')
    finally:
        me=page.request.get(base+'/api/me')
        if me.ok:
            assert page.request.post(base+'/api/logout',headers={'Origin':base,'x-csrf-token':me.json()['csrf']}).ok
        context.close();browser.close()
