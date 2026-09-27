import os,sys,time; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import phone, edits_pipeline as P
key = sys.argv[1]
print('New reel?', phone.find('New reel') is not None, 'caption', (P.caption_field() or {}).get('value'))
phone.swipe(195,650,195,150,ms=700); time.sleep(2)
def trial():
    return [n for n in phone.elements() if n.get('type')=='Switch' and 'Trial' in str(n.get('label'))]
tr = trial(); print('trial:', [t['label'][:22] for t in tr])
if tr and tr[0]['label'].startswith('Not checked'):
    r = tr[0]['rect']; phone.tap(r['x'] + r['width'] - 40, r['y'] + 15); time.sleep(2)
    tr = trial(); print('trial after tap:', [t['label'][:22] for t in tr])
    if tr and tr[0]['label'].startswith('Not checked'):
        sw=[n for n in phone.elements() if n.get('type')=='Switch' and not n.get('label') and abs(n['rect']['y']-r['y'])<30]
        if sw:
            s=sw[0]['rect']; phone.tap(s['x']+s['width']/2, s['y']+s['height']/2); time.sleep(2)
            print('trial after 2nd tap:', [t['label'][:22] for t in trial()])
assert trial()[0]['label'].startswith('Checked'), 'trial switch not on'
acct=[n['label'] for n in phone.elements() if 'Also share on' in str(n.get('label'))]; print(acct)
s=phone.find('Share',exact=True,kind='Button'); phone.tap(s['x'],s['y']); time.sleep(8)
labs=[n['label'] for n in phone.elements() if n.get('type') in ('Button','StaticText') and n.get('label')]
print(time.strftime('%H:%M:%S'), [l for l in labs if 'Step' in l or 'Shar' in l or 'Upload' in l][:3])
open(os.path.join(phone._state_dir(), 'post_times.txt'),'a').write('%s trial %s\n' % (key, time.strftime('%Y-%m-%d %H:%M:%S')))
