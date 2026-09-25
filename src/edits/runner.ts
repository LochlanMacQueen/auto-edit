import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import type { TaskExecutionContext } from '../plugin.js';
import { coordinatesForProfile, type Point } from '../devices/coordinates.js';
import type { RegisteredDevice } from '../devices/registry.js';
import { EDITS_BUNDLE_ID } from './coordinates.js';
import { inspectEditsWithJev } from './jev.js';
import type { Recipe, Selector, Step } from './recipe.js';

interface Node { type: string; label: string; value?: unknown; rect: { x: number; y: number; width: number; height: number }; visible?: boolean; children?: Node[] }
export function flatten(raw: unknown): Node[] {
    const result: Node[] = [];
    const pending: any[] = [(raw as any)?.value ?? raw];
    let visited = 0;
    while (pending.length && visited++ < 10000) {
        const n = pending.pop();
        if (!n || typeof n !== 'object') continue;
        if (Array.isArray(n.children)) pending.push(...n.children.slice().reverse());
        const r = n.rect;
        if (r && [r.x,r.y,r.width,r.height].every(Number.isFinite) && r.width > 0 && r.height > 0 && n.visible !== false && n.visible !== 'false') {
            result.push({ ...n, label: String(n.label || n.name || '') });
        }
    }
    return result;
}
export function findTarget(nodes: Node[], selector: Selector, screen: {width: number; height: number}): Node | undefined {
    const matches = nodes.filter(n => (selector.label === undefined || n.label === selector.label) && (!selector.type || n.type === selector.type)
        && (selector.minY === undefined || n.rect.y >= selector.minY) && (selector.maxY === undefined || n.rect.y <= selector.maxY)
        && n.rect.x < screen.width && n.rect.y < screen.height && n.rect.x + n.rect.width > 0 && n.rect.y + n.rect.height > 0);
    if (matches.length > 1) throw new Error(`Ambiguous target: ${selector.label}. Specify type and vertical bounds.`);
    return matches[0];
}
export async function runRecipe(context: TaskExecutionContext, device: RegisteredDevice, recipe: Recipe, fetchImpl: typeof fetch = fetch) {
    const screen = coordinatesForProfile(device.coordinateProfile).screenSize;
    const wda = `http://127.0.0.1:${device.wdaLocalPort ?? Number(process.env.WDA_LOCAL_PORT ?? 8100)}`;
    const dir = path.resolve(process.env.SCHEDULER_DATA_DIR ?? '.scheduler-data', 'edits', context.executionId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const done: string[] = [];
    const metrics: Array<{ id: string; ms: number }> = [];
    let current: string | undefined;
    async function request(route: string, body?: unknown): Promise<any> {
        context.signal.throwIfAborted();
        const response = await fetchImpl(wda + route, {
            method: body === undefined ? 'GET' : 'POST',
            signal: AbortSignal.any([context.signal, AbortSignal.timeout(15000)]),
            ...(body === undefined ? {} : { headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) }),
        });
        if (!response.ok) throw new Error(`WDA failed (${response.status}); inspect before retrying this step.`);
        const data = await response.json() as any;
        if (data?.value?.error) throw new Error(`WDA rejected the action: ${String(data.value.error)}`);
        return data;
    }
    async function foreground() {
        if ((await request('/wda/activeAppInfo'))?.value?.bundleId !== EDITS_BUNDLE_ID) throw new Error('Edits is not foreground. The recipe has stopped without relaunching it.');
    }
    async function nodes() { return flatten(await request('/source?format=json')); }
    function point(p: Point) {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.y < 0 || p.x >= screen.width || p.y >= screen.height) throw new Error('Target is outside the screen.');
        return p;
    }
    function center(n: Node): Point {
        const x1 = Math.max(0,n.rect.x), x2 = Math.min(screen.width,n.rect.x+n.rect.width);
        const y1 = Math.max(0,n.rect.y), y2 = Math.min(screen.height,n.rect.y+n.rect.height);
        return point({x:(x1+x2)/2,y:(y1+y2)/2});
    }
    async function actions(items: unknown[]) {
        await request('/wda/absolute-actions', { actions: [{type:'pointer',id:'edits',parameters:{pointerType:'touch'},actions:items}] });
    }
    async function tap(p: Point, hold = 60) {
        point(p);
        await actions([{type:'pointerMove',duration:0,...p,origin:'viewport'}, {type:'pointerDown',button:0}, {type:'pause',duration:hold}, {type:'pointerUp',button:0}]);
    }
    async function swipe(from: Point, to: Point, duration: number) {
        point(from);point(to);
        await actions([{type:'pointerMove',duration:0,...from,origin:'viewport'}, {type:'pointerDown',button:0}, {type:'pause',duration:60}, {type:'pointerMove',duration,...to,origin:'viewport'}, {type:'pointerUp',button:0}]);
    }
    async function wait(target: Selector, timeout = 10000) {
        const deadline = Date.now()+timeout;
        do {
            await foreground();
            const found = findTarget(await nodes(), target, screen);
            if (found) return found;
            await pause(250, undefined, {signal:context.signal});
        } while (Date.now()<deadline);
        throw new Error(`Timed out waiting for ${target.label}.`);
    }
    async function screenshot() {
        const data = await request('/screenshot');
        if (typeof data.value !== 'string') throw new Error('Screenshot unavailable.');
        await writeFile(path.join(dir,'review.png'),Buffer.from(data.value,'base64'),{mode:0o600});
    }
    async function checkpoint(status: string, error?: string) {
        await writeFile(path.join(dir,'result.json'), JSON.stringify({status,current,completed:done,metrics,error,screenshot:path.join(dir,'review.png')},null,2),{mode:0o600});
    }
    async function type(step: Extract<Step,{op:'type'}>) {
        // Only the explicitly selected field is read, never the first TextView.
        const field = await wait(step.field);
        if (String(field.value ?? '') !== step.previous) throw new Error('Text field does not match the expected previous text. Nothing was cleared.');
        await tap(center(field));
        let snapshot = await nodes();
        const keyboardDeadline = Date.now() + 5000;
        while (!snapshot.some(n => n.type === 'Key') && Date.now() < keyboardDeadline) {
            await pause(250, undefined, {signal:context.signal});
            await foreground();
            snapshot = await nodes();
        }
        const keys = () => snapshot.filter(n => n.type === 'Key' || (n.type === 'Button' && n.rect.y > screen.height*.6));
        const key = (name:string) => {
            const matches = keys().filter(n => (n.label || (n.rect.width>150?'space':'')).toLowerCase() === name.toLowerCase());
            if (matches.length !== 1) throw new Error(`Keyboard key unavailable or ambiguous: ${name}`);
            return matches[0];
        };
        const refresh = async () => { snapshot = await nodes(); };
        // Select All makes replacement independent of where the field tap put
        // the caret. Never guess a deletion count or clear-and-retry.
        if (!snapshot.some(n=>n.type==='Key')) throw new Error('Keyboard is not ready.');
        if (step.previous.length) {
            await tap(center(field),650);
            await tap(center(await wait({label:'Select All'})));
            await refresh();
            await tap(center(key('delete')));
            await refresh();
            const emptied = findTarget(snapshot, {type:field.type,minY:field.rect.y-2,maxY:field.rect.y+2}, screen);
            if (!emptied || String(emptied.value ?? '') !== '') throw new Error('Replacement field did not clear as expected. Review before continuing.');
        }
        for (const char of step.text) {
            await foreground();
            await refresh();
            const name = char===' '?'space':char==='\n'?'return':char.toLowerCase();
            if (!keys().some(n => (n.label || (n.rect.width>150?'space':'')).toLowerCase() === name)) {
                const alternatives = /[a-z]/i.test(char) ? ['letters','ABC'] : ['numbers','123'];
                const toggle = keys().find(n=>alternatives.includes(n.label));
                if (!toggle) throw new Error(`Keyboard layout for ${char} is unavailable.`);
                await tap(center(toggle)); await refresh();
            }
            if (/[a-z]/i.test(char)) {
                const shift = key('shift');
                if ((String(shift.value)==='1') !== (char===char.toUpperCase())) {
                    await tap(center(shift)); await refresh();
                    if ((String(key('shift').value)==='1') !== (char===char.toUpperCase())) throw new Error('Shift did not settle.');
                }
            }
            await tap(center(key(name)));
            await pause(140,undefined,{signal:context.signal});
        }
        const verified = await wait(step.verify);
        if (String(verified.value ?? verified.label) !== step.text) throw new Error('Typed text did not verify on the specified target. Review without clearing it.');
    }
    try {
        // Validate every calibration reference before changing the project.
        if (recipe.steps.some(s => (s as {op?:string}).op === 'jev') && !process.env.TYPESAFE_API_KEY?.trim()) throw new Error('Configure TYPESAFE_API_KEY on the worker before running Jev checkpoints.');
        for (const step of recipe.steps as unknown as Step[]) {
            if (step.op==='tap' && 'point' in step.target && !device.editsCoordinates?.[step.target.point as keyof typeof device.editsCoordinates]) throw new Error(`Calibrate ${step.target.point} before running this recipe.`);
        }
        for (const step of recipe.steps as unknown as Step[]) {
            current=step.id;
            await checkpoint('running');
            await foreground();
            const started=performance.now();
            await context.log(`Edits step ${step.id}: ${step.op}`);
            switch (step.op) {
                case 'tap': {
                    const target = 'point' in step.target ? device.editsCoordinates![step.target.point as keyof typeof device.editsCoordinates]! : center(await wait(step.target));
                    await tap(target); await wait(step.expect); break;
                }
                case 'wait': await wait(step.target,step.timeoutMs); break;
                case 'type': await type(step); break;
                case 'swipe': await swipe({x:step.from[0],y:step.from[1]},{x:step.to[0],y:step.to[1]},step.durationMs); await wait(step.expect); break;
                case 'align': {
                    let aligned=false;
                    for(let i=0;i<12;i++) {
                        const state=await nodes();
                        const caption=findTarget(state,step.caption,screen), track=findTarget(state,step.scrollTrack,screen);
                        if(!caption||!track) throw new Error('Bring the named caption and overlay track into view before aligning.');
                        if(Math.abs(caption.rect.y-track.rect.y)<15) throw new Error('Use a non-caption track for timeline scrolling.');
                        const delta=caption.rect.x-step.playheadX;
                        if(Math.abs(delta)<=(step.tolerance??10)){aligned=true;break;}
                        if(Math.abs(delta)<15) throw new Error('Alignment is below the reliable drag distance; review the boundary.');
                        const y=center(track).y;
                        const from=delta>0?screen.width*.8:screen.width*.2;
                        const to=Math.max(screen.width*.15,Math.min(screen.width*.85,from-delta));
                        await swipe({x:from,y},{x:to,y},450);
                        await pause(250,undefined,{signal:context.signal});
                    }
                    if(!aligned) throw new Error('Caption alignment did not converge.');
                    break;
                }
                case 'jev': {
                    const decision=await inspectEditsWithJev(device,{fetchImpl, signal:context.signal});
                    await context.log(`Jev ${decision.state}; confidence=${decision.confidence}; observation=${decision.observationMs}ms inference=${decision.inferenceMs}ms`);
                    if(decision.reviewRequired||decision.action==='wait'||!step.expected.includes(decision.state)) throw new Error(`Jev checkpoint needs review: ${decision.recommendation}`);
                    break;
                }
                case 'review':
                    await screenshot(); await checkpoint('review');
                    await context.log(`Visual review required. ${path.join(dir,'result.json')}`);
                    return {exitCode:0,stopped:true};
            }
            done.push(step.id); metrics.push({id:step.id,ms:Math.round(performance.now()-started)});
            await checkpoint('running');
        }
        return {exitCode:0,stopped:false};
    } catch(error) {
        const message=error instanceof Error?error.message:String(error);
        if(!context.signal.aborted) await screenshot().catch(()=>{});
        await checkpoint(context.signal.aborted?'stopped':'needs_review',message);
        await context.log(`Edits stopped at ${current??'preflight'}; completed ${done.length} steps. Inspect ${path.join(dir,'result.json')}. Do not replay completed steps.`);
        return {exitCode:null,stopped:context.signal.aborted,error:message};
    }
}
