import { readFile } from 'node:fs/promises';
import { validateRecipe } from './recipe.js';

async function main() {
    const [command, argument, recipePath] = process.argv.slice(2);
    const origin = new URL(process.env.PHONE_FARM_URL ?? 'http://127.0.0.1:3000').origin;
    const headers: Record<string,string> = {Origin:origin,'Content-Type':'application/json'};
    if(process.env.PHONE_FARM_API_TOKEN)headers.Authorization=`Bearer ${process.env.PHONE_FARM_API_TOKEN}`;
    async function api(route:string,body?:unknown) {
        const response=await fetch(origin+route,{method:body===undefined?'GET':'POST',headers,signal:AbortSignal.timeout(35000),...(body===undefined?{}:{body:JSON.stringify(body)})});
        const data=await response.json();
        if(!response.ok)throw new Error(JSON.stringify(data));
        return data;
    }
    switch(command) {
        case 'validate': {
            if(!argument)throw new Error('Provide a recipe file.');
            const recipe=validateRecipe(JSON.parse(await readFile(argument,'utf8')));
            console.log(JSON.stringify({valid:true,title:recipe.title,steps:recipe.steps.length}));break;
        }
        case 'submit': {
            if(!argument||!recipePath)throw new Error('Usage: edits submit DEVICE_UDID recipe.json');
            const payload=validateRecipe(JSON.parse(await readFile(recipePath,'utf8')));
            console.log(JSON.stringify(await api('/api/schedules',{deviceUdid:argument,timing:{kind:'now'},runWindowMinutes:60,task:{pluginId:'local.edits',taskType:'recipe',taskVersion:1,payload}}),null,2));break;
        }
        case 'inspect':
            if(!argument)throw new Error('Provide a device UDID.');
            console.log(JSON.stringify(await api(`/api/devices/${encodeURIComponent(argument)}/edits/inspect`,{}),null,2));break;
        case 'status':
            if(!argument)throw new Error('Provide a device UDID.');
            console.log(JSON.stringify(await api(`/api/executions?deviceUdid=${encodeURIComponent(argument)}`),null,2));break;
        default: throw new Error('Usage: npm run edits -- validate RECIPE | submit UDID RECIPE | inspect UDID | status UDID');
    }
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
