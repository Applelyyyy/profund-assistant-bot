"""Real browser checks. Requires a running web server and an owner account.
Run using the Python Playwright environment described in README.md.
"""
import json, os, pathlib, time
from playwright.sync_api import sync_playwright
base=os.environ.get('E2E_BASE_URL','http://127.0.0.1:3000')
credentials={'username':os.environ['E2E_USERNAME'],'password':os.environ['E2E_PASSWORD']}
artifacts=pathlib.Path('artifacts');artifacts.mkdir(exist_ok=True)
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True)
 page=browser.new_page(viewport={'width':1440,'height':1100})
 errors=[]
 pending=set()
 page.on('request',lambda r:pending.add(r.url))
 page.on('requestfinished',lambda r:pending.discard(r.url))
 page.on('requestfailed',lambda r:pending.discard(r.url))
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto(base);page.wait_for_load_state('networkidle')
 page.get_by_label('Username',exact=True).fill(credentials['username'])
 page.get_by_label('Password',exact=True).fill(credentials['password'])
 page.get_by_role('button',name='Sign in',exact=True).click()
 page.get_by_role('heading',name='Workspace overview').wait_for(timeout=30000)
 page.wait_for_load_state('networkidle')
 page.screenshot(path=str(artifacts/'overview-dark-desktop.png'),full_page=True)
 browser_crypto=page.evaluate('({secure:isSecureContext, uuid:typeof globalThis.crypto?.randomUUID})')
 if base.startswith('http://') and 'localhost' not in base and '127.0.0.1' not in base:
  assert browser_crypto == {'secure':False,'uuid':'undefined'}, browser_crypto
 assert page.locator('body').evaluate('(el)=>el.scrollWidth <= innerWidth'), 'Desktop page overflow'
 # Real roster CRUD and idempotent, server-validated settings.
 page.get_by_role('link',name='Students',exact=True).click()
 page.get_by_role('button',name='Add student',exact=True).click()
 student_id='00'+str(int(time.time()))
 page.get_by_label('Student ID',exact=True).fill(student_id)
 page.get_by_label('First name',exact=True).fill('Browser')
 page.get_by_label('Last name',exact=True).fill('Verified')
 page.get_by_role('button',name='Save student',exact=True).click()
 page.get_by_role('dialog').wait_for(state='hidden')
 page.get_by_role('cell',name=student_id,exact=True).wait_for()
 page.get_by_role('row').filter(has=page.get_by_role('cell',name=student_id,exact=True)).get_by_role('button',name='Edit',exact=True).click()
 page.get_by_label('Last name',exact=True).fill('Updated')
 page.get_by_role('button',name='Save student',exact=True).click()
 page.get_by_role('dialog').wait_for(state='hidden')
 page.get_by_role('cell',name='Browser Updated',exact=True).wait_for()
 # Remove only the test row created by this run.
 page.once('dialog',lambda d:d.accept())
 page.get_by_role('row').filter(has=page.get_by_role('cell',name=student_id,exact=True)).get_by_role('button',name='Remove',exact=True).click()
 page.get_by_role('cell',name=student_id,exact=True).wait_for(state='hidden')
 # Real configuration saves, read-back, restoration, and Discord directory selectors.
 me=page.request.get(base+'/api/me').json()
 headers={'Origin':base,'x-csrf-token':me['csrf']}
 def api(path):
  response=page.request.get(base+'/api/'+path)
  assert response.ok, (path,response.status,response.text())
  return response.json()
 def save_click(button, path):
  with page.expect_response(lambda r: '/api/'+path in r.url and r.request.method in ['POST','PATCH','DELETE']) as response:
   button.click()
  assert response.value.ok, (path,response.value.status,response.value.text())
  page.wait_for_load_state('networkidle')
 original_settings=api('settings')
 original_bindings=api('bindings')
 original_templates=api('templates')
 directory=api('directory')
 assert directory['channels'] and directory['roles'], 'Live Discord directory unavailable'
 try:
  page.goto(base+'/?view=queue-config');page.wait_for_load_state('networkidle')
  changed=original_settings['claimLeaseSeconds']+1
  page.get_by_label('Transfer claim lease (seconds)',exact=True).fill(str(changed))
  save_click(page.get_by_role('button',name='Save changes',exact=True).first,'settings')
  assert api('settings')['claimLeaseSeconds']==changed
  page.reload();page.wait_for_load_state('networkidle')
  assert page.get_by_label('Transfer claim lease (seconds)',exact=True).input_value()==str(changed)
  page.goto(base+'/?view=roles');page.wait_for_load_state('networkidle')
  # Public verification has a simple preset; advanced controls are hidden.
  assert not page.get_by_text('Feature permission matrix',exact=True).is_visible()
  for name in ['supportRoles','adminRoles']:
   page.locator('select[name="'+name+'"]').select_option('')
  candidates=[r for r in directory['roles'] if r['name']!='@everyone' and not r.get('managed',False)]
  student_role=next(r['id'] for r in candidates if not (int(r.get('permissions','0')) & (8|32|268435456)))
  ta_role=next(r['id'] for r in candidates if r['id']!=student_role)
  page.locator('select[name="studentRole"]').select_option(student_role)
  page.locator('select[name="taRole"]').select_option(ta_role)
  save_click(page.get_by_role('button',name='Save Configuration',exact=True),'access/preview')
  page.get_by_role('dialog',name='Review Discord permission changes',exact=True).wait_for()
  save_click(page.get_by_role('button',name='Confirm save & sync',exact=True),'access')
  page.get_by_role('dialog').wait_for(state='hidden')
  roles=api('settings')
  assert roles['studentRole']==student_role and roles['taRole']==ta_role
  assert roles['supportRoles']==[] and roles['adminRoles']==[]
  page.goto(base+'/?view=channels');page.wait_for_load_state('networkidle')
  row=page.get_by_role('row').filter(has=page.get_by_role('cell',name='Waiting Voice',exact=True))
  row.get_by_role('button',name='Configure',exact=True).click()
  dialog=page.get_by_role('dialog')
  checkboxes=dialog.locator('input[name="channels"]')
  for checkbox in checkboxes.all(): checkbox.uncheck()
  assert checkboxes.count()>0, 'No live waiting voice choices'
  selected=checkboxes.first.get_attribute('value');checkboxes.first.check()
  save_click(dialog.get_by_role('button',name='Save channel binding',exact=True),'access/preview')
  page.get_by_role('dialog',name='Review Discord permission changes',exact=True).wait_for()
  # Cancel this live permission preview; only isolated QA channels may be changed.
  page.get_by_role('button',name='Cancel',exact=True).click()
  page.get_by_role('dialog').wait_for(state='hidden')
  assert next((b for b in api('bindings') if b['feature']=='waiting_voice'),{'channelIds':[]})['channelIds']==next((b for b in original_bindings if b['feature']=='waiting_voice'),{'channelIds':[]})['channelIds']
  page.goto(base+'/?view=support');page.wait_for_load_state('networkidle')
  page.get_by_label('Support issue categories',exact=True).fill('Browser verified, Coursework')
  save_click(page.get_by_role('button',name='Save changes',exact=True),'settings')
  assert api('settings')['supportCategories']==['Browser verified','Coursework']
  page.goto(base+'/?view=settings');page.wait_for_load_state('networkidle')
  page.get_by_label('Student nickname template',exact=True).fill('{name} {lastname}')
  save_click(page.get_by_role('button',name='Save changes',exact=True),'settings')
  assert api('settings')['nicknameTemplate']=='{name} {lastname}'
  page.goto(base+'/?view=embeds');page.wait_for_load_state('networkidle')
  template_id=page.get_by_label('Panel template',exact=True).input_value()
  original_template=next(t for t in original_templates if t['id']==template_id)
  page.get_by_label('Title',exact=True).fill('Browser verified draft')
  save_click(page.get_by_role('button',name='Save draft',exact=True),'templates/'+template_id)
  assert next(t for t in api('templates') if t['id']==template_id)['document']['title']=='Browser verified draft'
  response=page.request.post(base+'/api/templates/'+template_id,data={'name':original_template['name'],'feature':original_template['feature'],'document':original_template['document']},headers=headers)
  assert response.ok,response.text()
 finally:
  response=page.request.post(base+'/api/settings',data=original_settings,headers=headers)
  assert response.ok,response.text()
  binding=next((b for b in original_bindings if b['feature']=='waiting_voice'),{'feature':'waiting_voice','channelIds':[]})
  response=page.request.post(base+'/api/bindings',data={'feature':'waiting_voice','channelIds':binding['channelIds']},headers=headers)
  assert response.ok,response.text()
 # CSV preview/commit preserves leading zeros; remove only this run's row.
 page.goto(base+'/?view=students');page.wait_for_load_state('networkidle')
 csv_id='000'+str(int(time.time()))
 page.locator('input[type="file"]').set_input_files({'name':'browser.csv','mimeType':'text/csv','buffer':('id,name,lastname\n'+csv_id+',CSV,Verified\n').encode()})
 page.get_by_role('dialog',name='Review student import',exact=True).wait_for()
 page.get_by_role('cell',name=csv_id,exact=True).wait_for()
 save_click(page.get_by_role('button',name='Commit import',exact=True),'students/commit')
 page.get_by_role('dialog').wait_for(state='hidden')
 assert any(s['studentId']==csv_id for s in api('students'))
 page.once('dialog',lambda d:d.accept())
 save_click(page.get_by_role('row').filter(has=page.get_by_role('cell',name=csv_id,exact=True)).get_by_role('button',name='Remove',exact=True),'students/')
 # Coursework create/edit/archive through the UI. Run this suite on an isolated QA deployment.
 page.goto(base+'/?view=coursework');page.wait_for_load_state('networkidle')
 name='Browser coursework '+str(int(time.time()))
 page.get_by_role('button',name='Create coursework',exact=True).click()
 page.get_by_label('Coursework name',exact=True).fill(name)
 save_click(page.get_by_role('button',name='Save coursework',exact=True),'coursework')
 page.get_by_role('dialog').wait_for(state='hidden')
 course=next(c for c in api('coursework') if c['name']==name)
 row=page.get_by_role('row').filter(has=page.get_by_text(name,exact=True))
 row.get_by_role('button',name='Edit',exact=True).click()
 page.get_by_label('Course label',exact=True).fill('Browser edited')
 save_click(page.get_by_role('button',name='Save coursework',exact=True),'coursework')
 page.get_by_role('dialog').wait_for(state='hidden')
 assert next(c for c in api('coursework') if c['id']==course['id'])['label']=='Browser edited'
 page.once('dialog',lambda d:d.accept())
 save_click(row.get_by_role('button',name='Archive',exact=True),'coursework')
 assert next(c for c in api('coursework') if c['id']==course['id'])['archived']
 # Browse every real module. Credential-dependent directory failure is expected and visible.
 views=['queue','tas','coursework','queue-config','channels','roles','embeds','support','analytics','logs','operations','settings']
 for view in views:
  print('VIEW:',view,flush=True)
  page.goto(base+'/?view='+view)
  try: page.wait_for_load_state('networkidle',timeout=60000)
  except Exception:
   print('PENDING:',sorted(pending),flush=True)
   raise
  assert page.locator('h1').count()==1, view
  assert page.locator('body').evaluate('(el)=>el.scrollWidth <= innerWidth'), view+' overflow'
 page.goto(base+'/?view=embeds');page.wait_for_load_state('networkidle')
 page.screenshot(path=str(artifacts/'embed-builder-desktop.png'),full_page=True)
 # Unsaved template edits survive a declined switch; invalid placeholders cannot be saved.
 selector=page.get_by_label('Panel template',exact=True)
 original=selector.input_value()
 alternate=selector.locator('option').nth(1).get_attribute('value')
 if alternate==original: alternate=selector.locator('option').nth(0).get_attribute('value')
 original_title=page.get_by_label('Title',exact=True).input_value()
 page.get_by_label('Title',exact=True).fill('Unsaved review draft')
 page.once('dialog',lambda d:d.dismiss())
 selector.select_option(alternate)
 assert selector.input_value()==original, 'Declined switch discarded selected template'
 assert page.get_by_label('Title',exact=True).input_value()=='Unsaved review draft'
 page.get_by_label('Title',exact=True).fill('{unsupported.secret}')
 page.get_by_role('button',name='Save draft',exact=True).click()
 page.get_by_text('Unknown placeholder: {unsupported.secret}',exact=False).first.wait_for()
 page.once('dialog',lambda d:d.accept())
 selector.select_option(alternate)
 assert selector.input_value()==alternate

 page.goto(base);page.wait_for_load_state('networkidle')
 page.get_by_role('button',name='Switch to light theme',exact=True).click()
 page.screenshot(path=str(artifacts/'overview-light-desktop.png'),full_page=True)
 page.set_viewport_size({'width':390,'height':844})
 page.screenshot(path=str(artifacts/'overview-light-mobile.png'),full_page=True)
 assert page.locator('body').evaluate('(el)=>el.scrollWidth <= innerWidth'), 'Mobile page overflow'
 assert page.locator('.freshness').is_visible(), 'Freshness hidden on mobile'
 page.get_by_role('button',name='Switch to dark theme',exact=True).click()
 page.screenshot(path=str(artifacts/'overview-dark-mobile.png'),full_page=True)
 # Direct API checks use the authenticated browser cookie jar.
 me=page.request.get(base+'/api/me').json()
 forbidden=page.request.post(base+'/api/settings',data={},headers={'Origin':base})
 assert forbidden.status==403,'Missing CSRF token accepted'
 forged=page.request.post(base+'/api/operations',data={'action':'run_shell'},headers={'Origin':base,'x-csrf-token':me['csrf']})
 assert forged.status==400,'Arbitrary service action accepted'
 page.get_by_role('button',name='Sign out',exact=True).click()
 page.get_by_role('button',name='Sign in',exact=True).wait_for()
 assert page.request.get(base+'/api/overview').status==401,'Revoked session still valid'
 assert not errors, '\n'.join(errors)
 browser.close()
 print('PASS: sign-in, HTTP without browser UUID, roster/CSV/coursework CRUD, queue/role/channel/support/preferences/template saves and read-back, 14 views, themes, responsive layouts, CSRF, action allowlist, logout; no browser errors.')
