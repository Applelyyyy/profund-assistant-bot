"""Configure disclosure in an isolated database. No Discord panel is published by a bot."""
import os,json,pathlib
from playwright.sync_api import sync_playwright,expect
base=os.environ['E2E_BASE_URL'];assert base=='http://127.0.0.1:3010'
out=pathlib.Path('artifacts/full-details');out.mkdir(parents=True,exist_ok=True)
warning='Full Student IDs will be visible to everyone who can access this channel, including students. Only enable this mode when your institution permits this disclosure.'
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True);context=browser.new_context(viewport={'width':1440,'height':1100});page=context.new_page();errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    try:
        page.goto(base);page.wait_for_load_state('networkidle')
        page.get_by_label('Username',exact=True).fill(os.environ['E2E_USERNAME']);page.get_by_label('Password',exact=True).fill(os.environ['E2E_PASSWORD']);page.get_by_role('button',name='Sign in',exact=True).click()
        page.get_by_role('heading',name='Workspace overview').wait_for();page.get_by_role('link',name='Discord channels',exact=True).click();page.wait_for_load_state('networkidle')
        page.get_by_role('button',name='Configure room panel',exact=True).click()
        dialog=page.get_by_role('dialog');rooms=dialog.get_by_label('TA inspection voice room',exact=True);rooms.locator('option').nth(1).wait_for(state='attached',timeout=30000)
        voice=rooms.locator('option').nth(1).get_attribute('value');rooms.select_option(voice);dialog.get_by_label('Template',exact=True).select_option(label='TA_ROOM_QUEUE_PANEL')
        expect(dialog.get_by_label('Visibility',exact=True)).to_be_enabled();expect(dialog.get_by_label('Delivery mode',exact=True)).to_have_value('VOICE')
        dialog.get_by_label('Visibility',exact=True).select_option('FULL_INSPECTION_DETAILS');expect(dialog.get_by_text(warning,exact=True)).to_be_visible()
        ack=dialog.get_by_label('I acknowledge Student ID disclosure in this channel.',exact=True);expect(ack).not_to_be_checked()
        posted=[];page.on('request',lambda r:posted.append(r.url) if r.method=='POST' else None)
        dialog.get_by_role('button',name='Preview & publish',exact=True).click();page.wait_for_timeout(300);assert not posted
        ack.check()
        for width in [375,768,1440]:
            page.set_viewport_size({'width':width,'height':1100});expect(ack).to_be_visible();assert page.evaluate('document.documentElement.scrollWidth <= innerWidth+2')
        with page.expect_response(lambda r:'/api/room-panels/preview' in r.url and r.request.method=='POST') as response:
            dialog.get_by_role('button',name='Preview & publish',exact=True).click()
        assert response.value.ok,response.value.status
        preview=page.get_by_role('dialog');expect(preview.get_by_text('Inspection preview',exact=True)).to_be_visible();expect(preview.get_by_text(warning,exact=True)).to_be_visible()
        expect(preview.locator('.inspection-preview')).to_contain_text('ขณะนี้ไม่มีนักศึกษากำลังตรวจงาน')
        with page.expect_response(lambda r:r.url.endswith('/api/room-panels') and r.request.method=='POST') as saved:
            preview.get_by_role('button',name='Confirm save & sync',exact=True).click()
        assert saved.value.ok,saved.value.status;record=saved.value.json()
        assert record['visibility']=='FULL_INSPECTION_DETAILS' and record['studentIdDisclosureAcknowledged']
        page.reload();page.wait_for_load_state('networkidle');page.get_by_role('link',name='Discord channels',exact=True).click();page.wait_for_load_state('networkidle')
        row=page.locator('tr').filter(has=page.get_by_text('Full Inspection Details',exact=True));expect(row).to_have_count(1)
        row.get_by_role('button',name='Republish',exact=True).click();modal=page.get_by_role('dialog');expect(modal.get_by_text(warning,exact=True)).to_be_visible();expect(modal.get_by_role('button',name='Republish panel',exact=True)).to_be_disabled()
        modal.get_by_label('I acknowledge Student ID disclosure in this channel.',exact=True).check()
        with page.expect_response(lambda r:'/publish' in r.url and r.request.method=='POST') as published:
            modal.get_by_role('button',name='Republish panel',exact=True).click()
        assert published.value.ok
        actual=page.request.get(base+'/api/room-panels').json();assert next(r for r in actual if r['id']==record['id'])['publishedPanelId']==record['publishedPanelId']
        row.get_by_role('button',name='Edit',exact=True).click();modal=page.get_by_role('dialog');expect(modal.get_by_label('Visibility',exact=True)).to_have_value('FULL_INSPECTION_DETAILS');expect(modal.get_by_label('I acknowledge Student ID disclosure in this channel.',exact=True)).not_to_be_checked()
        page.screenshot(path=str(out/'full-mode.png'),full_page=True)
        modal.get_by_label('Visibility',exact=True).select_option('PUBLIC');expect(modal.get_by_text(warning,exact=True)).to_have_count(0)
        with page.expect_response(lambda r:'/api/room-panels/preview' in r.url and r.request.method=='POST') as public_preview:
            modal.get_by_role('button',name='Preview & publish',exact=True).click()
        assert public_preview.value.ok
        expect(page.get_by_role('dialog').get_by_text('Student IDs remain hidden or masked.',exact=True)).to_be_visible()
        page.get_by_role('dialog').get_by_role('button',name='Cancel',exact=True).click();page.get_by_role('dialog').get_by_role('button',name='Close dialog',exact=True).click()
        assert not errors,errors
        (out/'result.json').write_text(json.dumps({'passed':True,'fullDisclosureAcknowledged':True,'voiceDelivery':True,'preview':True,'saveReload':True,'republish':True,'publicSafePreview':True,'viewports':[375,768,1440],'noBrowserErrors':True,'roomId':record['id'],'publishedPanelId':record['publishedPanelId']}))
        print('Browser passed: consent required, voice-chat delivery, preview, save/reload, republish and responsive layouts.')
    finally:
        me=page.request.get(base+'/api/me')
        if me.ok:page.request.post(base+'/api/logout',headers={'Origin':base,'x-csrf-token':me.json()['csrf']})
        context.close();browser.close()
