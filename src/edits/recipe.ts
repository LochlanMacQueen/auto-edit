import type { JsonObject, JsonValue } from '../types.js';
import { EDITS_CALIBRATABLE_POINTS } from './coordinates.js';

export interface Selector { label?: string; type?: string; minY?: number; maxY?: number }
export type Step =
    | { id: string; op: 'tap'; target: Selector | { point: string }; expect: Selector }
    | { id: string; op: 'wait'; target: Selector; timeoutMs?: number }
    | { id: string; op: 'type'; field: Selector; previous: string; text: string; verify: Selector }
    | { id: string; op: 'swipe'; from: [number, number]; to: [number, number]; durationMs: number; expect: Selector }
    | { id: string; op: 'align'; caption: Selector; scrollTrack: Selector; playheadX: number; tolerance?: number }
    | { id: string; op: 'jev'; expected: string[] }
    | { id: string; op: 'review' };
export interface Recipe extends JsonObject { title: string; steps: JsonValue[] }
const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
function selector(v: unknown): void {
    if (!isRecord(v)) throw new Error('Invalid target.');
    if (v.label !== undefined && (typeof v.label !== 'string' || v.label.length > 300)) throw new Error('Invalid target label.');
    if (v.label === undefined && !(typeof v.type === 'string' && typeof v.minY === 'number' && typeof v.maxY === 'number')) throw new Error('Use an exact label or a type with vertical bounds.');
    if (v.type !== undefined && (typeof v.type !== 'string' || v.type.length > 50)) throw new Error('Invalid target type.');
    for (const key of ['minY', 'maxY']) if (v[key] !== undefined && (typeof v[key] !== 'number' || !Number.isFinite(v[key]) || v[key] < 0)) throw new Error('Invalid target bounds.');
}
const stateNames = ['projects','media_picker','timeline','text_editor','text_selected','captions','audio_picker','audio_selected','audio_fades','export','exporting','share'];
export function validateRecipe(value: JsonValue): Recipe {
    if (!isRecord(value) || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 120
        || !Array.isArray(value.steps) || !value.steps.length || value.steps.length > 100) throw new Error('Recipe needs a title and 1–100 steps.');
    const ids = new Set<string>();
    for (const step of value.steps) {
        if (!isRecord(step) || typeof step.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(step.id) || ids.has(step.id)) throw new Error('Every step needs a unique id.');
        ids.add(step.id);
        switch (step.op) {
            case 'tap':
                if (isRecord(step.target) && 'point' in step.target) {
                    if (!(EDITS_CALIBRATABLE_POINTS as readonly unknown[]).includes(step.target.point) || step.target.point === 'shareInstagram') throw new Error('Unknown or unsupported Edits point.');
                } else {
                    selector(step.target);
                    if (/^(share|instagram|post|publish)$/i.test(((step.target as Selector).label ?? ''))) throw new Error('Publishing and app handoff are outside editing recipes.');
                }
                selector(step.expect); break;
            case 'wait':
                selector(step.target);
                if (step.timeoutMs !== undefined && (!Number.isInteger(step.timeoutMs) || (step.timeoutMs as number) < 100 || (step.timeoutMs as number) > 120000)) throw new Error('Wait timeout must be 100–120000 ms.');
                break;
            case 'type':
                selector(step.field); selector(step.verify);
                if (typeof step.text !== 'string' || typeof step.previous !== 'string' || step.text.length > 300 || step.previous.length > 300 || !/^[\x20-\x7E\n]*$/.test(step.text) || !/^[\x20-\x7E\n]*$/.test(step.previous)) throw new Error('Text entry supports up to 300 ASCII characters.');
                break;
            case 'swipe':
                for (const key of ['from','to']) if (!Array.isArray(step[key]) || step[key].length !== 2 || !(step[key] as unknown[]).every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0)) throw new Error('Swipe endpoints must be [x,y].');
                if (!Number.isInteger(step.durationMs) || (step.durationMs as number) < 100 || (step.durationMs as number) > 3000) throw new Error('Swipe duration must be 100–3000 ms.');
                selector(step.expect); break;
            case 'align':
                selector(step.caption); selector(step.scrollTrack);
                if (typeof step.playheadX !== 'number' || !Number.isFinite(step.playheadX) || step.playheadX < 0) throw new Error('A measured playheadX is required.');
                if (step.tolerance !== undefined && (typeof step.tolerance !== 'number' || !Number.isFinite(step.tolerance) || step.tolerance < 1 || step.tolerance > 20)) throw new Error('Invalid alignment tolerance.');
                break;
            case 'jev':
                if (!Array.isArray(step.expected) || !step.expected.length || !step.expected.every(s => stateNames.includes(s as string))) throw new Error('Jev expected states are invalid.');
                break;
            case 'review': break;
            default: throw new Error(`Unsupported step: ${step.op}`);
        }
    }
    if ((value.steps.at(-1) as Record<string, unknown>).op !== 'review') throw new Error('End the recipe with a visual review checkpoint.');
    return value as Recipe;
}
