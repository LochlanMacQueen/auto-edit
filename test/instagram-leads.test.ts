import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    importLeadList,
    loadLeadContactState,
    loadLeadList,
    markLeadContacted,
    parseLeadList,
    pickLeads,
    summarizeLeadList,
    validateLeadListName,
} from '../src/instagram/leads.js';

const scraperRows = [
    { username: 'Alpha_One', full_name: 'Alpha', is_private: false, is_verified: false },
    { username: 'beta.two', full_name: 'Beta', is_private: true, is_verified: false },
    { username: 'gamma3', full_name: 'Gamma', is_private: false, is_verified: true },
    { username: 'alpha_one', full_name: 'dupe', is_private: false, is_verified: false },
    { username: 'bad handle!', full_name: 'nope', is_private: false, is_verified: false },
    { username: 'owner', full_name: 'Me', is_private: false, is_verified: true },
];

test('parseLeadList accepts raw scraper arrays, normalizes and dedupes handles', () => {
    const list = parseLeadList('x', scraperRows);
    assert.deepEqual(list.leads.map((lead) => lead.username), ['alpha_one', 'beta.two', 'gamma3', 'owner']);
    assert.equal(list.leads[1]!.isPrivate, true);
    assert.equal(list.leads[2]!.isVerified, true);
});

test('parseLeadList accepts the compact format and keeps source', () => {
    const list = parseLeadList('x', { source: { post: 'p' }, leads: [{ username: '@Zed', fullName: 'Z', isPrivate: false, isVerified: false }] });
    assert.deepEqual(list.source, { post: 'p' });
    assert.equal(list.leads[0]!.username, 'zed');
    assert.throws(() => parseLeadList('x', { nope: true }), /no "leads" array/);
});

test('validateLeadListName rejects path-like names', () => {
    assert.equal(validateLeadListName(' ig-likes.2026 '), 'ig-likes.2026');
    assert.throws(() => validateLeadListName('../etc'), /Invalid lead list name/);
    assert.throws(() => validateLeadListName('a/b'), /Invalid lead list name/);
});

test('pickLeads skips contacted, private, verified and excluded handles in order', () => {
    const list = parseLeadList('x', scraperRows);
    const state = { alpha_one: { status: 'sent' as const, at: 'now' } };
    assert.deepEqual(pickLeads(list, state, { size: 10, skipPrivate: true, exclude: ['@Owner'] }).map((l) => l.username), ['gamma3']);
    assert.deepEqual(pickLeads(list, state, { size: 10 }).map((l) => l.username), ['beta.two', 'gamma3', 'owner']);
    assert.deepEqual(pickLeads(list, state, { size: 1, skipVerified: true }).map((l) => l.username), ['beta.two']);
    const failed = { alpha_one: { status: 'failed' as const, at: 'now' } };
    assert.deepEqual(pickLeads(list, failed, { size: 1, skipPrivate: true }).map((l) => l.username), ['gamma3']);
    assert.deepEqual(pickLeads(list, failed, { size: 1, skipPrivate: true, retryFailed: true }).map((l) => l.username), ['alpha_one']);
});

test('summarizeLeadList counts sent, failed and remaining public leads', () => {
    const list = parseLeadList('x', scraperRows);
    const summary = summarizeLeadList(list, {
        alpha_one: { status: 'sent', at: 'now' },
        gamma3: { status: 'failed', at: 'now' },
    });
    assert.equal(summary.total, 4);
    assert.equal(summary.sent, 1);
    assert.equal(summary.failed, 1);
    assert.equal(summary.remaining, 2);
    assert.equal(summary.remainingPublic, 1);
    assert.equal(summary.private, 1);
    assert.equal(summary.verified, 2);
});

test('importLeadList writes the compact file and markLeadContacted persists state', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'leads-'));
    const previous = process.env.LEADS_DIR;
    process.env.LEADS_DIR = dir;
    try {
        const list = await importLeadList('demo', scraperRows, { exclude: ['owner'], source: { file: 'raw.json' } });
        assert.deepEqual(list.leads.map((lead) => lead.username), ['alpha_one', 'beta.two', 'gamma3']);
        const written = JSON.parse(await readFile(path.join(dir, 'demo.json'), 'utf8')) as { source: { file: string; importedAt: string } };
        assert.equal(written.source.file, 'raw.json');
        assert.ok(written.source.importedAt);

        const reloaded = await loadLeadList('demo');
        assert.equal(reloaded.leads.length, 3);

        await markLeadContacted('demo', '@Alpha_One', { status: 'sent', deviceUdid: 'udid-1', account: '@me' });
        await markLeadContacted('demo', 'gamma3', { status: 'failed', error: 'no result' });
        const state = await loadLeadContactState('demo');
        assert.equal(state.alpha_one?.status, 'sent');
        assert.equal(state.alpha_one?.account, '@me');
        assert.equal(state.gamma3?.error, 'no result');
        assert.deepEqual(pickLeads(reloaded, state, { size: 5, skipPrivate: true }), []);

        await assert.rejects(loadLeadList('missing'), /not found/);
        await writeFile(path.join(dir, 'broken.json'), '{"leads": 3}');
        await assert.rejects(loadLeadList('broken'), /no "leads" array/);
    } finally {
        if (previous === undefined) delete process.env.LEADS_DIR; else process.env.LEADS_DIR = previous;
    }
});
