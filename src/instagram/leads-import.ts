import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { importLeadList, loadLeadContactState, summarizeLeadList } from './leads.js';

/**
 * Import a scraper export as a named lead list.
 *
 *   npm run instagram:leads:import -- <export.json> <list-name> [--exclude handle,handle]
 *
 * Accepts Apify instagram-likes-scraper / followers-scraper exports (arrays of
 * user records) and our own compact `{ leads: [...] }` format.
 */
const [, , file, rawName, ...rest] = process.argv;
if (!file || !rawName) {
    console.error('Usage: instagram:leads:import <export.json> <list-name> [--exclude a,b,c]');
    process.exit(2);
}

const excludeIndex = rest.indexOf('--exclude');
const exclude = excludeIndex >= 0 ? (rest[excludeIndex + 1] ?? '').split(',').filter(Boolean) : [];

const raw: unknown = JSON.parse(await readFile(path.resolve(file), 'utf8'));
const list = await importLeadList(rawName, raw, {
    source: { file: path.basename(file) },
    exclude,
});
const summary = summarizeLeadList(list, await loadLeadContactState(list.name));
console.log(
    `Imported "${list.name}": ${summary.total} leads `
    + `(${summary.private} private, ${summary.verified} verified, ${summary.remainingPublic} public & uncontacted)`,
);
