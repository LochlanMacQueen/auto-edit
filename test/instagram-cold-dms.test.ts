import assert from 'node:assert/strict';
import test from 'node:test';

import {
    COLD_DMS_MAX_HANDLES,
    parseColdDmHandles,
    validateColdDmHandles,
    validateColdDmMessage,
} from '../src/instagram/cold-dms-payload.js';
import { PluginRegistry } from '../src/registry.js';
import { createInstagramPlugin } from '../src/instagram-plugin.js';

test('parseColdDmHandles accepts newlines, commas, and missing @', () => {
    assert.deepEqual(
        parseColdDmHandles('@one\ntwo, @three\n@one'),
        ['@one', '@two', '@three'],
    );
});

test('validateColdDmHandles enforces caps and format', () => {
    assert.throws(() => validateColdDmHandles([]), /at least one/);
    assert.throws(() => validateColdDmHandles(['bad handle']), /Invalid/);
    const tooMany = Array.from({ length: COLD_DMS_MAX_HANDLES + 1 }, (_, i) => `@u${i}`);
    assert.throws(() => validateColdDmHandles(tooMany), /at most/);
    assert.deepEqual(validateColdDmHandles(['@ok_user.1']), ['@ok_user.1']);
});

test('validateColdDmMessage requires non-empty text within limit', () => {
    assert.throws(() => validateColdDmMessage('   '), /required/);
    assert.throws(() => validateColdDmMessage('x'.repeat(1001)), /1000/);
    assert.equal(validateColdDmMessage('  hey  '), 'hey');
});

test('Instagram plugin registers cold-dms task', () => {
    const plugin = createInstagramPlugin({ coldDmsEntrypoint: '/example/cold-dms.js' });
    assert.ok(plugin.tasks.some((task) => task.type === 'cold-dms' && task.version === 1));
    const registry = new PluginRegistry([plugin]);
    const value = registry.validate({
        deviceUdid: 'device-12345678',
        task: {
            pluginId: plugin.id, taskType: 'cold-dms', taskVersion: 1,
            payload: { handles: ['@a', '@b'], message: 'Hey there' },
        },
        timing: { kind: 'now' },
    });
    assert.deepEqual(value.task.payload.handles, ['@a', '@b']);
    const task = plugin.tasks.find((entry) => entry.type === 'cold-dms')!;
    assert.equal(task.summarize(value.task.payload as never), 'Cold DMs · 2 handles');
});

test('Instagram cold-dms task accepts a lead list instead of handles', () => {
    const plugin = createInstagramPlugin({ coldDmsEntrypoint: '/example/cold-dms.js' });
    const registry = new PluginRegistry([plugin]);
    const task = plugin.tasks.find((entry) => entry.type === 'cold-dms')!;
    const validate = (payload: Record<string, unknown>) => registry.validate({
        deviceUdid: 'device-12345678',
        task: { pluginId: plugin.id, taskType: 'cold-dms', taskVersion: 1, payload: payload as never },
        timing: { kind: 'now' },
    }).task.payload as Record<string, unknown>;

    const payload = validate({ leadList: 'ig-likes-demo', message: 'Hey there' });
    assert.deepEqual(payload.handles, []);
    assert.equal(payload.leadList, 'ig-likes-demo');
    assert.equal(payload.leadBatch, 10);
    assert.equal(task.summarize(payload as never), 'Cold DMs · next 10 from ig-likes-demo');

    const custom = validate({ leadList: 'ig-likes-demo', leadBatch: 5, skipPrivate: false, handles: '', message: 'Hey' });
    assert.equal(custom.leadBatch, 5);
    assert.equal(custom.skipPrivate, false);

    assert.throws(() => validate({ leadList: '../x', message: 'Hey' }), /Invalid lead list name/);
    assert.throws(() => validate({ leadList: 'ok', leadBatch: 99, message: 'Hey' }), /between 1 and 25/);
    assert.throws(() => validate({ leadList: 'ok', handles: ['@a'], message: 'Hey' }), /not both/);
    assert.throws(() => validate({ message: 'Hey' }), /handles must be/);
});
