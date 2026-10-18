import os,json,pathlib,time,subprocess
from playwright.sync_api import sync_playwright,expect
base=os.environ['E2E_BASE_URL'];assert base=='http://127.0.0.1:3010'
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    context=browser.new_context(viewport={'width':1440,'height':1000})
    context.add_init_script("window.__vitals={lcp:0,cls:0}; new PerformanceObserver(list=>{for(const e of list.getEntries())window.__vitals.lcp=e.startTime}).observe({type:'largest-contentful-paint',buffered:true}); new PerformanceObserver(list=>{for(const e of list.getEntries())if(!e.hadRecentInput)window.__vitals.cls+=e.value}).observe({type:'layout-shift',buffered:true});window.__longTasks=[]; new PerformanceObserver(list=>window.__longTasks.push(...list.getEntries().map(e=>e.duration))).observe({type:'longtask',buffered:true});")
    page=context.new_page();requests=[];durations=[];errors=[]
    page.on('request',lambda r: requests.append(r.url))
    page.on('response',lambda r: durations.append({'path':r.url.split('/api/')[-1], 'ms':r.request.timing['responseEnd']-r.request.timing['requestStart']}) if '/api/' in r.url and r.request.timing['responseEnd']>=0 else None)
    page.on('pageerror',lambda e:errors.append(str(e)))
    try:
        start=time.perf_counter();page.goto(base);page.wait_for_load_state('networkidle');initial=(time.perf_counter()-start)*1000
        resources=page.evaluate("performance.getEntriesByType('resource').filter(r=>r.initiatorType==='script').map(r=>({name:r.name.split('/').pop(),encoded:r.encodedBodySize,decoded:r.decodedBodySize}))")
        page.get_by_label('Username',exact=True).fill(os.environ['E2E_USERNAME']);page.get_by_label('Password',exact=True).fill(os.environ['E2E_PASSWORD'])
        page.get_by_role('button',name='Sign in',exact=True).click();page.get_by_role('heading',name='Workspace overview').wait_for();page.wait_for_load_state('networkidle')
        navigation=[]
        for name in ['Live queue','TA management','Students','Coursework','Queue configuration','Discord channels','Roles & Access','Embed builder','Support tickets','Analytics & rankings','Logs & audit','System operations','Settings','Overview']:
            begin=time.perf_counter();page.get_by_role('link',name=name,exact=True).click();page.wait_for_load_state('networkidle');navigation.append({'view':name,'ms':(time.perf_counter()-begin)*1000})
        page.get_by_role('link',name='Embed builder',exact=True).click();page.wait_for_load_state('networkidle')
        before=len(requests);begin=time.perf_counter();description=page.get_by_label('Description',exact=True);draft=description.input_value()+'\nSynthetic unsaved edit';description.fill(draft);editing_ms=(time.perf_counter()-begin)*1000
        page.wait_for_timeout(500);edit_requests=[r for r in requests[before:] if '/api/' in r]
        expect(description).to_have_value(draft)
        storm_requests=[]
        if os.environ.get('PERFORMANCE_EVENT_STORM_ENV'):
            event_begin=len(requests)
            subprocess.run(['node','--env-file='+os.environ['PERFORMANCE_EVENT_STORM_ENV'],'--import','tsx','tests/fixtures/performance-events.ts'],check=True,capture_output=True)
            page.wait_for_timeout(5000)
            expect(description).to_have_value(draft)
            storm_requests=[r.split('/api/')[-1] for r in requests[event_begin:] if '/api/' in r]
            assert not any(r.split('?')[0] in ['templates','settings','bindings','coursework','students','analytics','support','sessions'] for r in storm_requests),storm_requests
        assert not errors,errors
        pathlib.Path(os.environ['PERFORMANCE_BROWSER_OUTPUT']).write_text(json.dumps({'initialMs':initial,'initialScriptEncodedBytes':sum(r['encoded'] for r in resources),'initialScriptDecodedBytes':sum(r['decoded'] for r in resources),'resources':resources,'navigation':navigation,'apiRequests':len([r for r in requests if '/api/' in r]),'editMs':editing_ms,'editingApiRequests':edit_requests,'longTasksMs':page.evaluate('window.__longTasks'),'apiDurations':durations,'noteStormApiRequests':storm_requests,'webVitals':page.evaluate('window.__vitals'),'fcpMs':page.evaluate("performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null"),'noBrowserErrors':True},indent=2))
        print('Browser performance recorded: all 14 views, bundles, requests, navigation, unsaved edits and long tasks.')
    finally:
        me=page.request.get(base+'/api/me')
        if me.ok:page.request.post(base+'/api/logout',headers={'Origin':base,'x-csrf-token':me.json()['csrf']})
        context.close();browser.close()
