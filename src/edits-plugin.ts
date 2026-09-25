import type { PhoneFarmPlugin, TaskDefinition } from './plugin.js';
import { loadRegisteredDevices } from './devices/registry.js';
import { inspectEditsWithJev } from './edits/jev.js';
import { validateRecipe, type Recipe } from './edits/recipe.js';
import { runRecipe } from './edits/runner.js';

const recipeTask: TaskDefinition<Recipe> = {
    type: 'recipe', version: 1, displayName: 'Edits recipe',
    validate(value, context) {
        if (context.timingKind !== 'now') throw new Error('Edits recipes must run now on the project currently open.');
        return validateRecipe(value);
    },
    summarize: recipe => recipe.title,
    estimateDurationMs: recipe => Math.min(60 * 60_000, recipe.steps.length * 60_000),
    retryPolicy: () => ({retryLimit:0,retryDelaySeconds:0,retryBackoff:false}),
    supportsStop: () => true,
    async execute(context, recipe) {
        const device=(await loadRegisteredDevices()).find(d=>d.udid===context.device.udid);
        if(!device) return {exitCode:null,stopped:false,error:'Device is no longer registered.'};
        return runRecipe(context,device,recipe);
    },
};
export function createEditsPlugin(): PhoneFarmPlugin {
    return {
        id:'local.edits',version:'0.1.0',displayName:'Edits',tasks:[recipeTask],
        registerRoutes({app,scheduler,loadDevices}) {
            app.get('/api/edits/jev',async()=>({configured:Boolean(process.env.TYPESAFE_API_KEY?.trim()),model:process.env.JEV_MODEL||'jev-1.13.0'}));
            app.post<{Params:{udid:string}}>('/api/devices/:udid/edits/inspect',async(request,reply)=>{
                const device=(await loadDevices()).find(d=>d.udid===request.params.udid);
                if(!device)return reply.code(404).send({error:'Device not found.'});
                if(device.disabled)return reply.code(409).send({error:'Connect this device first.'});
                if(await scheduler.activeExecution(device.udid))return reply.code(409).send({error:'Wait for the current workflow to finish before inspecting.'});
                try{return await inspectEditsWithJev(device);}
                catch(error){return reply.code(503).send({error:error instanceof Error?error.message:'Jev check failed.'});}
            });
        },
    };
}
