"""Embed Builder verification against an isolated database; no live panel publication."""
import os,json,pathlib
from playwright.sync_api import sync_playwright,expect
base=os.environ['E2E_BASE_URL'];assert base=='http://127.0.0.1:3010'
out=pathlib.Path('artifacts/student-id');out.mkdir(parents=True,exist_ok=True)
keys=['student_id','student_name','coursework','ticket','ta','status']
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True);context=browser.new_context(viewport={'width':1440,'height':1000})
    page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    try:
        page.goto(base);page.wait_for_load_state('networkidle')
        page.get_by_label('Username',exact=True).fill(os.environ['E2E_USERNAME'])
        page.get_by_label('Password',exact=True).fill(os.environ['E2E_PASSWORD'])
        page.get_by_role('button',name='Sign in',exact=True).click()
        page.get_by_role('heading',name='Workspace overview').wait_for()
        page.get_by_role('link',name='Embed builder',exact=True).click();page.wait_for_load_state('networkidle')
        templates=page.request.get(base+'/api/templates').json()
        room=next(t for t in templates if t['feature']=='ta_room_queue_panel' and t['name']=='TA_ROOM_QUEUE_PANEL')
        page.get_by_label('Panel template',exact=True).select_option(room['id'])
        page.get_by_text('Dynamic placeholders',exact=True).click()
        for key in keys:expect(page.get_by_text('{room.current.'+key+'}',exact=True)).to_be_visible()
        expect(page.get_by_text('Full Student IDs require TA-only access or an acknowledged Full Inspection Details policy',exact=False)).to_be_visible()
        description=' | '.join('{room.current.'+key+'}' for key in keys)
        page.get_by_label('Description',exact=True).fill(description)
        for mode in ['EMBED','V2']:
            page.get_by_label('Rendering mode',exact=True).select_option(mode)
            with page.expect_response(lambda r:'/api/templates' in r.url and r.request.method=='POST') as response:
                page.get_by_role('button',name='Save draft',exact=True).click()
            assert response.value.ok,response.value.status
            expect(page.get_by_role('button',name='Save draft',exact=True)).to_be_enabled(timeout=30000)
            page.wait_for_load_state('networkidle')
            actual=next(t for t in page.request.get(base+'/api/templates').json() if t['id']==room['id'])
            assert actual['document']['description']==description
            assert actual['document']['mode']==mode
            assert actual['document']['fields']==room['document']['fields']
            assert actual['document']['buttons']==room['document']['buttons']
            expect(page.locator('.discord-message')).to_contain_text('ไม่พบรหัสนักศึกษา')
            assert '{room.current.student_id}' not in page.locator('.discord-message').inner_text()
            page.screenshot(path=str(out/('builder-'+mode.lower()+'.png')),full_page=True)
        page.reload();page.wait_for_load_state('networkidle')
        page.get_by_label('Panel template',exact=True).select_option(room['id'])
        expect(page.get_by_label('Description',exact=True)).to_have_value(description)
        expect(page.get_by_label('Rendering mode',exact=True)).to_have_value('V2')
        for width in [375,768]:
            page.set_viewport_size({'width':width,'height':1000})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth+2'),f'Overflow at {width}'
        assert not errors,errors
        (out/'browser-result.json').write_text(json.dumps({'passed':True,'placeholders':6,'modes':['EMBED','V2'],'persisted':True,'oldFieldsAndControlsPreserved':True,'viewports':[375,768,1440],'noBrowserErrors':True}))
        print('Browser passed: six room placeholders, preview, save/reload, EMBED/V2, preserved fields/controls and three viewports.')
    finally:
        me=page.request.get(base+'/api/me')
        if me.ok:assert page.request.post(base+'/api/logout',headers={'Origin':base,'x-csrf-token':me.json()['csrf']}).ok
        context.close();browser.close()
