"""EXAMPLE — a real Palmier build from one finished format ("career edition" IQ reels).
The speech spans, file names, overlay sizes and card timings belong to that footage.
Read it for the shape: overlays as full-frame PNGs, one clip per speech span, cards on their
own track, export per timeline. Adapt the numbers to the project you are building.
Requires Palmier Pro's MCP on 127.0.0.1:19789 and UGC_PROJECT pointing at the project folder.
"""
import importlib.util, json, os, re, subprocess, sys, time
spec=importlib.util.spec_from_file_location('p',os.path.join(os.path.dirname(os.path.abspath(__file__)),'..','palmier_mcp.py'))
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
NB=os.environ.get("UGC_PROJECT", os.path.expanduser("~/Neurobank UGC"))  # the project folder; W=f"{NB}/Work/924"; os.makedirs(f"{W}/overlays",exist_ok=True); os.makedirs(f"{W}/raw",exist_ok=True)
FPS=60; PINS=f"{NB}/Assets/Cards/pins"; CARDS=f"{NB}/Assets/Cards"
# --- speech spans (isolation-tested 2026-09-23; noise tails + false starts removed) ---
SEG={"hook-0943":[[3.118,5.532]],"hook-0944":[[0.196,2.46]],"hook-0946":[[0.0,2.689]],
 "teacher":[[0.0,3.45],[4.661,7.244],[12.707,14.667]],
 "lawyer":[[0.0,3.363],[6.705,8.388],[12.973,16.255]],
 "software-developer":[[0.0,4.279],[9.41,11.772],[15.399,17.627]],
 "engineer":[[0.0,3.599],[6.189,8.27],[10.429,12.538]],
 "scientist":[[0.0,3.457],[7.662,9.748],[13.199,15.805]],
 "accountant":[[0.0,3.599],[6.115,8.691],[12.207,14.556]],
 "CTA-0940":[[0.324,5.424],[8.739,12.328]],           # span 2 was a false start
 "CTA-0941":[[0.0,4.273],[4.48,8.607]],
 "CTA-0942":[[0.0,3.89],[4.754,12.674]]}
VIDS=[("career1","hook-0944",["engineer","scientist","accountant"],"CTA-0941"),
      ("career2","hook-0946",["teacher","scientist","lawyer"],"CTA-0942"),
      ("career3","hook-0943",["accountant","software-developer","engineer"],"CTA-0940")]
# --- overlays: 3 per career, 16:9 band 860x484, bottom at y=610 ---
SRC={"engineer":["engineering_1.jpg","engineering_2.jpg","physics_2.png"],
     "scientist":["chemistry_1.jpg","chemistry_2.jpg","physics_1b.png"],
     "accountant":["economics_1.jpg","economics_2.jpg","statistics_2.jpg"],
     "teacher":[f"pins-career/teacher_{i}.jpg" for i in (1,2,3)],
     "lawyer":[f"pins-career/lawyer_{i}.jpg" for i in (1,2,3)],
     "software-developer":[f"pins-career/software-developer_{i}.jpg" for i in (1,2,3)]}
def band(src,dst,off=0.5):
    crop=f"crop='min(iw,ih*16/9)':'min(iw,ih*16/9)*9/16':'(iw-ow)/2':'(ih-oh)*{off}'"
    subprocess.run(["ffmpeg","-v","error","-y","-f","lavfi","-i","color=c=black@0.0:s=1080x1920,format=rgba","-i",src,
      "-filter_complex",f"[1:v]{crop},scale=860:484[img];[0:v][img]overlay=110:126:format=auto,format=rgba","-frames:v","1",dst],check=True)
for c,files in SRC.items():
    for i,f in enumerate(files,1):
        src=f"{CARDS}/{f}" if f.startswith("pins-career") else f"{PINS}/{f}"
        band(src,f"{W}/overlays/o4_{c}_{i}.png")
for name,src,scale in (("o4_app_store","app-store-picture.jpg","900:-1"),("o4_score_card","score-card-v2.png","560:500:force_original_aspect_ratio=decrease")):
    subprocess.run(["ffmpeg","-v","error","-y","-f","lavfi","-i","color=c=black@0.0:s=1080x1920,format=rgba","-i",f"{CARDS}/{src}",
      "-filter_complex",f"[1:v]scale={scale}[img];[0:v][img]overlay=(W-w)/2:610-h:format=auto,format=rgba","-frames:v","1",f"{W}/overlays/{name}.png"],check=True)
print("overlays built", flush=True)
# --- palmier: open career project, close others, import overlays ---
lst=m.call_tool('manage_project',{'action':'list'})
for p in lst['projects']:
    if p['isOpen'] and p['name']!='IQ Careers 9-23': m.call_tool('manage_project',{'action':'close','id':p['id']})
pid=[p['id'] for p in lst['projects'] if p['name']=='IQ Careers 9-23'][0]
m.call_tool('manage_project',{'action':'open','id':pid})
m.call_tool('import_media',{'source':{'path':f"{W}/overlays"},'folder':'Overlays924'})
media={a['name']:a['id'] for a in m.call_tool('get_media',{})['assets']}
GAP=round(0.35*FPS); CTA_A=round(0.15*FPS)   # app-store card lands on 'I made a test' (see below)
IMADE={"CTA-0940":2.6,"CTA-0941":2.26,"CTA-0942":2.3}  # source secs of 'I made/built a test' in each CTA take
out={}
for vid,hook,careers,cta in VIDS:
    tl=m.call_tool('create_timeline',{'name':vid}); tid=tl.get('timelineId')
    entries=[]; f=0; bounds={}
    def place(name,f):
        for s,e in SEG[name]:
            n=round((e-s)*FPS); entries.append({"mediaRef":media[name],"startFrame":f,"source":[round(s,3),round(s+n/FPS,4)]}); f+=n
        return f
    f=place(hook,f)
    for c in careers: st=f; f=place(c,f); bounds[c]=(st,f)
    cst=f; f=place(cta,f); bounds['CTA']=(cst,f); END=f
    r=m.call_tool('add_clips',{'entries':entries})
    tlc=m.call_tool('get_timeline',{}); vt=[t for t in tlc['tracks'] if t.get('kind','video')!='audio'][0]['clips']
    for a,b in zip(vt,vt[1:]):
        if b['frames'][0]>a['frames'][1]: m.call_tool('set_clip_properties',{'clipIds':[a['id']],'durationFrames':b['frames'][0]-a['frames'][0]})
    ov=[]
    for c in careers:
        st,en=bounds[c]; each=(en-st-2*GAP)//3
        for k in range(3):
            a=st+k*(each+GAP); ov.append({"mediaRef":media[f"o4_{c}_{k+1}"],"startFrame":a,"endFrame":(en if k==2 else a+each)})
    cs,ce=bounds['CTA']; s0=SEG[cta][0][0]; app=cs+round((IMADE[cta]-s0)*FPS); app_end=min(app+round(3.0*FPS),ce)
    ov.append({"mediaRef":media["o4_app_store"],"startFrame":app,"endFrame":app_end})
    if ce-(app_end+GAP)>=FPS: ov.append({"mediaRef":media["o4_score_card"],"startFrame":app_end+GAP,"endFrame":ce})
    m.call_tool('add_clips',{'entries':ov})
    out[vid]={"timelineId":tid,"frames":END,"hook":hook,"careers":careers,"cta":cta,"bounds":{k:list(v) for k,v in bounds.items()}}
    print(vid,END/FPS,"s", hook, careers, cta, flush=True)
json.dump(out,open(f"{W}/career_vars.json","w"),indent=1)
# --- export ---
for vid,info in out.items():
    p=f"{W}/raw/{vid}.mp4"
    r=m.call_tool('export_project',{'mode':'video','codec':'H.264','resolution':'Match Timeline','outputPath':p,'timelineId':info['timelineId']})
    for _ in range(150):
        ex=m.call_tool('manage_exports',{'action':'list'}); e=[x for x in ex.get('exports',[]) if x.get('jobId')==r.get('jobId')]
        if e and e[0].get('status') in ('completed','failed'): break
        time.sleep(4)
    print("exported",vid,e[0].get('status') if e else '?', flush=True)
