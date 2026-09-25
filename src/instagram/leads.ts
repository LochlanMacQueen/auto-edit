import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Lead lists for Instagram cold DMs.
 *
 * A lead list lives at `data/leads/<name>.json` and is either the compact
 * format written by `importLeadList()` or a raw Apify "instagram-likes-scraper"
 * export (an array of `{ username, full_name, is_private, is_verified }`).
 *
 * Contact state is kept beside it at `data/leads/state/<name>.json`, keyed by
 * lowercase username, so a run can pick "the next N nobody has messaged yet"
 * and successive runs never re-DM the same person.
 */

export interface Lead {
    username: string;
    fullName: string;
    isPrivate: boolean;
    isVerified: boolean;
}

export interface LeadList {
    name: string;
    source?: Record<string, unknown>;
    leads: Lead[];
}

export type LeadContactStatus = 'sent' | 'failed' | 'skipped';

export interface LeadContact {
    status: LeadContactStatus;
    at: string;
    account?: string;
    deviceUdid?: string;
    error?: string;
}

export type LeadContactState = Record<string, LeadContact>;

export interface LeadListSummary {
    name: string;
    total: number;
    private: number;
    verified: number;
    sent: number;
    failed: number;
    remaining: number;
    /** Remaining once private accounts are excluded (the default picker mode). */
    remainingPublic: number;
}

export interface PickLeadsOptions {
    size: number;
    skipPrivate?: boolean;
    skipVerified?: boolean;
    /** Re-offer leads whose last attempt failed (default: skip them). */
    retryFailed?: boolean;
    /** Handles to never pick (own accounts etc). With or without '@'. */
    exclude?: Iterable<string>;
}

const LEAD_LIST_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const HANDLE = /^[A-Za-z0-9._]{1,64}$/;

export function leadsDirectory(): string {
    return process.env.LEADS_DIR ?? path.resolve('data', 'leads');
}

function stateDirectory(): string {
    return path.join(leadsDirectory(), 'state');
}

export function normalizeLeadHandle(handle: string): string {
    return handle.trim().toLowerCase().replace(/^@/, '');
}

export function validateLeadListName(name: string): string {
    const trimmed = name.trim();
    if (!LEAD_LIST_NAME.test(trimmed)) {
        throw new Error(`Invalid lead list name "${name}" — use letters, digits, dot, dash, underscore`);
    }
    return trimmed;
}

function leadListPath(name: string): string {
    return path.join(leadsDirectory(), `${validateLeadListName(name)}.json`);
}

function statePath(name: string): string {
    return path.join(stateDirectory(), `${validateLeadListName(name)}.json`);
}

function asString(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

/** Accepts compact `{ leads: [...] }` documents and raw scraper arrays alike. */
export function parseLeadList(name: string, raw: unknown): LeadList {
    const rows: unknown[] = Array.isArray(raw)
        ? raw
        : raw && typeof raw === 'object' && Array.isArray((raw as { leads?: unknown }).leads)
            ? (raw as { leads: unknown[] }).leads
            : [];
    if (!Array.isArray(raw) && rows.length === 0) {
        throw new Error(`Lead list "${name}" has no "leads" array`);
    }
    const seen = new Set<string>();
    const leads: Lead[] = [];
    for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const record = row as Record<string, unknown>;
        const username = normalizeLeadHandle(asString(record.username) || asString(record.ownerUsername));
        if (!username || !HANDLE.test(username) || seen.has(username)) continue;
        seen.add(username);
        leads.push({
            username,
            fullName: (asString(record.fullName) || asString(record.full_name)).trim(),
            isPrivate: Boolean(record.isPrivate ?? record.is_private),
            isVerified: Boolean(record.isVerified ?? record.is_verified),
        });
    }
    const source = !Array.isArray(raw) && raw && typeof raw === 'object'
        ? (raw as { source?: Record<string, unknown> }).source
        : undefined;
    return { name, ...(source ? { source } : {}), leads };
}

export async function loadLeadList(name: string): Promise<LeadList> {
    const file = leadListPath(name);
    let text: string;
    try {
        text = await readFile(file, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new Error(`Lead list "${name}" not found (expected ${file})`);
        }
        throw error;
    }
    return parseLeadList(validateLeadListName(name), JSON.parse(text));
}

export async function listLeadListNames(): Promise<string[]> {
    let entries: string[];
    try {
        entries = await readdir(leadsDirectory());
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
    return entries
        .filter((entry) => entry.endsWith('.json'))
        .map((entry) => entry.slice(0, -'.json'.length))
        .filter((entry) => LEAD_LIST_NAME.test(entry))
        .sort();
}

export async function loadLeadContactState(name: string): Promise<LeadContactState> {
    try {
        const parsed: unknown = JSON.parse(await readFile(statePath(name), 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        return parsed as LeadContactState;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
        throw error;
    }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 1)}\n`, 'utf8');
    await rename(temp, file);
}

/** Read-modify-write so concurrent devices working the same list don't clobber each other. */
export async function markLeadContacted(
    name: string,
    handle: string,
    contact: Omit<LeadContact, 'at'> & { at?: string },
): Promise<void> {
    const state = await loadLeadContactState(name);
    state[normalizeLeadHandle(handle)] = { ...contact, at: contact.at ?? new Date().toISOString() };
    await writeJsonAtomic(statePath(name), state);
}

export function pickLeads(list: LeadList, state: LeadContactState, options: PickLeadsOptions): Lead[] {
    const exclude = new Set(Array.from(options.exclude ?? [], normalizeLeadHandle));
    const picked: Lead[] = [];
    for (const lead of list.leads) {
        if (picked.length >= options.size) break;
        if (exclude.has(lead.username)) continue;
        if (options.skipPrivate && lead.isPrivate) continue;
        if (options.skipVerified && lead.isVerified) continue;
        const previous = state[lead.username];
        if (previous?.status === 'sent') continue;
        if (previous?.status === 'failed' && !options.retryFailed) continue;
        picked.push(lead);
    }
    return picked;
}

export function summarizeLeadList(list: LeadList, state: LeadContactState): LeadListSummary {
    let sent = 0;
    let failed = 0;
    let remaining = 0;
    let remainingPublic = 0;
    for (const lead of list.leads) {
        const status = state[lead.username]?.status;
        if (status === 'sent') { sent += 1; continue; }
        if (status === 'failed') { failed += 1; continue; }
        remaining += 1;
        if (!lead.isPrivate) remainingPublic += 1;
    }
    return {
        name: list.name,
        total: list.leads.length,
        private: list.leads.filter((lead) => lead.isPrivate).length,
        verified: list.leads.filter((lead) => lead.isVerified).length,
        sent,
        failed,
        remaining,
        remainingPublic,
    };
}

export async function summarizeLeadLists(): Promise<LeadListSummary[]> {
    const names = await listLeadListNames();
    return Promise.all(names.map(async (name) => {
        const [list, state] = await Promise.all([loadLeadList(name), loadLeadContactState(name)]);
        return summarizeLeadList(list, state);
    }));
}

/**
 * Convert a raw scraper export into the compact list format and save it as
 * `data/leads/<name>.json`. Returns the parsed list.
 */
export async function importLeadList(
    name: string,
    raw: unknown,
    options: { source?: Record<string, unknown>; exclude?: Iterable<string> } = {},
): Promise<LeadList> {
    const parsed = parseLeadList(validateLeadListName(name), raw);
    const exclude = new Set(Array.from(options.exclude ?? [], normalizeLeadHandle));
    const list: LeadList = {
        name: parsed.name,
        source: { ...(parsed.source ?? {}), ...(options.source ?? {}), importedAt: new Date().toISOString() },
        leads: parsed.leads.filter((lead) => !exclude.has(lead.username)),
    };
    await writeJsonAtomic(leadListPath(list.name), list);
    return list;
}
