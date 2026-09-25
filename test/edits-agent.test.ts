import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { editorObservation, inspectEditsWithJev, parseJevEditorAnswer } from '../src/edits/jev.js';
import { validateRecipe } from '../src/edits/recipe.js';
import { findTarget, flatten, runRecipe } from '../src/edits/runner.js';
import { createEditsPlugin } from '../src/edits-plugin.js';
import type { JsonObject } from '../src/types.js';
import type { TaskExecutionContext } from '../src/plugin.js';

const device={name:'Test',udid:'test',coordinateProfile:'iphone13' as const,pluginData:{}};
const node=(label:string,y=100)=>({type:'Button',label,rect:{x:30,y,width:80,height:32}});
const answer=(choice='timeline',confidence=.96)=>({model:'jev-1.13.0',answers:{screen:{type:'choice',choice,confidence,probabilities:{[choice]:.97}},busy:{type:'noul',noul:.01}}});
const sample: {title:string;steps:JsonObject[]}={title:'Add caption tool',steps:[{id:'captions',op:'tap',target:{label:'Captions'},expect:{label:'Generate captions'}},{id:'review',op:'review'}]};

test('Jev is optional; no key makes no WDA or external requests',async()=>{
    await assert.rejects(()=>inspectEditsWithJev(device,{apiKey:'',fetchImpl:async()=>{throw new Error('Must not fetch');}}),/TYPESAFE_API_KEY/);
});
test('Jev refuses unrelated foreground applications before reading content',async()=>{
    const paths:string[]=[];
    await assert.rejects(()=>inspectEditsWithJev(device,{apiKey:'fake',fetchImpl:async(input)=>{
        paths.push(String(input));return Response.json({value:{bundleId:'com.burbn.instagram'}});
    }}),/Open Edits/);
    assert.equal(paths.length,1);
});
test('Jev uses only sessionless reads and sends bounded Edits observations to official endpoint',async()=>{
    const calls:Array<{url:string;init?:RequestInit}>=[];
    const result=await inspectEditsWithJev(device,{apiKey:'fake',fetchImpl:async(input,init)=>{
        const url=String(input);calls.push({url,init});
        if(url.endsWith('/wda/activeAppInfo'))return Response.json({value:{bundleId:'com.burbn.basel'}});
        if(url.includes('/source'))return Response.json({value:{children:[node('Captions'),{...node('secret'),type:'SecureTextField',value:'password'},node('Offscreen',1000)]}});
        return Response.json(answer());
    }});
    assert.equal(result.state,'timeline');
    assert.equal(calls.length,4);
    assert.ok(calls.slice(0,3).every(c=>!c.init?.method));
    assert.equal(calls[3].url,'https://api.typesafe.ai/v1/systemone');
    const payload=JSON.parse(String(calls[3].init?.body));
    assert.deepEqual(payload.state.elements.map((n:{label:string})=>n.label),['Captions']);
    assert.equal(payload.model,'jev-1.13.0');
    assert.equal(result.elementCount,1);
});
test('untrusted decisions fail closed or require review',()=>{
    assert.equal(parseJevEditorAnswer(answer('timeline',.2)).action,'review');
    assert.equal(parseJevEditorAnswer(answer('unknown')).action,'review');
    assert.throws(()=>parseJevEditorAnswer(answer('publish')),/invalid/);
    assert.throws(()=>parseJevEditorAnswer(answer('timeline',NaN)),/invalid/);
    assert.equal(parseJevEditorAnswer(answer('exporting')).action,'wait');
    assert.throws(()=>editorObservation({}, {width:390,height:844}),/No visible/);
});
test('recipes require review, unique steps, supported controls, and immediate execution',()=>{
    assert.equal(validateRecipe(sample).steps.length,2);
    assert.throws(()=>validateRecipe({...sample,steps:sample.steps.slice(0,1)}),/visual review/);
    assert.throws(()=>validateRecipe({...sample,steps:[sample.steps[0],sample.steps[0],sample.steps[1]]}),/unique/);
    assert.throws(()=>validateRecipe({...sample,steps:[{id:'share',op:'tap',target:{point:'shareInstagram'},expect:{label:'Instagram'}},sample.steps[1]]}),/unsupported/);
    assert.throws(()=>createEditsPlugin().tasks[0].validate(sample,{timingKind:'daily',devicePluginData:{}}),/run now/);
});
test('dynamic targets ignore offscreen elements and reject ambiguity',()=>{
    const screen={width:390,height:844};
    const nodes=flatten({value:{children:[node('Split'),node('Split',1200)]}});
    assert.equal(findTarget(nodes,{label:'Split'},screen)?.rect.y,100);
    assert.throws(()=>findTarget(flatten({children:[node('Split'),node('Split',150)]}),{label:'Split'},screen),/Ambiguous/);
    assert.equal(findTarget(flatten({children:[node('Split'),node('Split',150)]}),{label:'Split',minY:140},screen)?.rect.y,150);
});
test('runner executes a batch without sessions and saves a review checkpoint',async(context)=>{
    const dir=await mkdtemp(path.join(os.tmpdir(),'edits-run-'));
    const previous=process.env.SCHEDULER_DATA_DIR;process.env.SCHEDULER_DATA_DIR=dir;
    context.after(()=>{if(previous===undefined)delete process.env.SCHEDULER_DATA_DIR;else process.env.SCHEDULER_DATA_DIR=previous;});
    let tapped=false;
    const calls:string[]=[];
    const execution={executionId:'test-run',signal:new AbortController().signal,log:async()=>{}} as unknown as TaskExecutionContext;
    const result=await runRecipe(execution,device,validateRecipe(sample),async(input,init)=>{
        const url=String(input);calls.push(url);
        if(url.endsWith('/wda/activeAppInfo'))return Response.json({value:{bundleId:'com.burbn.basel'}});
        if(url.includes('/source'))return Response.json({value:{children:[node(tapped?'Generate captions':'Captions')]}});
        if(url.endsWith('/wda/absolute-actions')){
            assert.equal(init?.method,'POST');
            const body=JSON.parse(String(init.body));assert.equal(body.actions[0].actions.filter((a:{type:string})=>a.type==='pointerDown').length,1);
            tapped=true;return Response.json({value:null});
        }
        if(url.endsWith('/screenshot'))return Response.json({value:Buffer.from('test image').toString('base64')});
        throw new Error('Unexpected route');
    });
    assert.equal(result.stopped,true);assert.equal(result.exitCode,0);
    assert.ok(calls.every(url=>!url.includes('/session')));
    const saved=JSON.parse(await readFile(path.join(dir,'edits/test-run/result.json'),'utf8'));
    assert.equal(saved.status,'review');assert.deepEqual(saved.completed,['captions']);assert.equal(saved.metrics.length,1);
});
test('runner preflights missing calibration without sending a tap',async(context)=>{
    const dir=await mkdtemp(path.join(os.tmpdir(),'edits-missing-'));const old=process.env.SCHEDULER_DATA_DIR;process.env.SCHEDULER_DATA_DIR=dir;
    context.after(()=>{if(old===undefined)delete process.env.SCHEDULER_DATA_DIR;else process.env.SCHEDULER_DATA_DIR=old;});
    const result=await runRecipe({executionId:'test',signal:new AbortController().signal,log:async()=>{}} as unknown as TaskExecutionContext,device,
        validateRecipe({...sample,steps:[{...sample.steps[0],target:{point:'captions'}},sample.steps[1]]}),async(input,init)=>{
            assert.equal(init?.method,'GET');assert.ok(String(input).endsWith('/screenshot'));return Response.json({value:''});
        });
    assert.match(result.error??'',/Calibrate captions/);
});

test('a lost tap response is never retried automatically', async(context)=>{
    const dir=await mkdtemp(path.join(os.tmpdir(),'edits-uncertain-')); const old=process.env.SCHEDULER_DATA_DIR;process.env.SCHEDULER_DATA_DIR=dir;
    context.after(()=>{if(old===undefined)delete process.env.SCHEDULER_DATA_DIR;else process.env.SCHEDULER_DATA_DIR=old;});
    let taps=0;
    const result=await runRecipe({executionId:'lost-response',signal:new AbortController().signal,log:async()=>{}} as unknown as TaskExecutionContext,device,validateRecipe(sample),async(input)=>{
        const url=String(input);
        if(url.endsWith('/wda/activeAppInfo'))return Response.json({value:{bundleId:'com.burbn.basel'}});
        if(url.includes('/source'))return Response.json({value:{children:[node('Captions')]}});
        if(url.endsWith('/wda/absolute-actions')){taps++;throw new Error('Response lost');}
        return Response.json({value:''});
    });
    assert.equal(taps,1);assert.match(result.error??'',/Response lost/);
    const saved=JSON.parse(await readFile(path.join(dir,'edits/lost-response/result.json'),'utf8'));
    assert.deepEqual(saved.completed,[]);assert.equal(saved.current,'captions');assert.equal(saved.status,'needs_review');
    assert.equal(createEditsPlugin().tasks[0].retryPolicy({}).retryLimit,0);
});
