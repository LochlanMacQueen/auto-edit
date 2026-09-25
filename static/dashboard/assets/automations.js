const FLEET_VALUE = '__fleet__';
const params = new URLSearchParams(location.search);
const elements = {
    templates: Array.from(document.querySelectorAll('.automation-template[data-template]')),
    workspace: document.querySelector('#pipeline-workspace'),
    device: document.querySelector('#pipeline-device'),
    fleet: document.querySelector('#pipeline-fleet'),
    fleetHint: document.querySelector('#pipeline-fleet-hint'),
    form: document.querySelector('#pipeline-form'),
    video: document.querySelector('#pipeline-video'),
    caption: document.querySelector('#pipeline-caption'),
    addResult: document.querySelector('#pipeline-add-result'),
    submit: document.querySelector('#pipeline-submit'),
    auto: document.querySelector('#pipeline-auto'),
    frequency: document.querySelector('#pipeline-frequency'),
    checkNow: document.querySelector('#pipeline-check-now'),
    refresh: document.querySelector('#pipeline-refresh'),
    status: document.querySelector('#pipeline-status'),
    list: document.querySelector('#pipeline-list'),
};
let devicesCache = [];
let fleetPreview = [];
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
async function jsonRequest(url, init) {
    const response = await fetch(url, init);
    const body = await response.json().catch(() => ({}));
    if (!response.ok)
        throw new Error(body.error || `Request failed (${response.status})`);
    return body;
}
function selectedUdid() {
    if (elements.fleet.checked) {
        return devicesCache.find((device) => !device.disabled)?.udid
            ?? elements.device.value
            ?? '';
    }
    return elements.device.value;
}
function updateFleetHint() {
    const on = elements.fleet.checked;
    elements.device.disabled = on;
    elements.submit.textContent = on ? 'Add to all device queues' : 'Add to queue';
    elements.checkNow.disabled = on;
    if (!on) {
        elements.fleetHint.hidden = true;
        elements.fleetHint.textContent = '';
        return;
    }
    const rows = fleetPreview.length
        ? fleetPreview
        : devicesCache.filter((device) => !device.disabled).map((device, index) => ({
            udid: device.udid,
            name: device.name,
            farmIndex: index + 1,
            staggerMinutes: index * 5,
            order: index + 1,
        }));
    elements.fleetHint.hidden = false;
    elements.fleetHint.textContent = rows.length
        ? `Stagger: ${rows.map((row) => `${row.name} +${row.staggerMinutes}m`).join(' · ')}`
        : 'No active devices for fleet mode.';
}
function selectTemplate(id, options = {}) {
    for (const button of elements.templates) {
        const active = button.dataset.template === id;
        button.setAttribute('aria-pressed', String(active));
        button.classList.toggle('is-active', active);
    }
    elements.workspace.hidden = id !== 'pipeline';
    if (id === 'pipeline') {
        const next = new URL(location.href);
        next.searchParams.set('template', 'pipeline');
        history.replaceState(null, '', next);
        if (options.refresh !== false)
            void refreshPipeline();
    }
}
async function loadDevices() {
    devicesCache = (await jsonRequest('/api/devices')).filter((entry) => !entry.disabled);
    const preferred = params.get('device') ?? '';
    elements.device.innerHTML = '<option value="">Select an iPhone…</option>';
    for (const device of devicesCache) {
        elements.device.add(new Option(device.name, device.udid));
    }
    if (preferred && [...elements.device.options].some((option) => option.value === preferred)) {
        elements.device.value = preferred;
    }
    else if (devicesCache[0]) {
        elements.device.value = devicesCache[0].udid;
    }
    updateFleetHint();
}
function statusLabel(status) {
    if (status === 'ready')
        return 'Ready';
    if (status === 'publishing')
        return 'Publishing';
    if (status === 'published')
        return 'Published';
    if (status === 'failed')
        return 'Failed';
    return status;
}
function escapeHtml(value) {
    return value.replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[character] ?? character));
}
function renderItems(items, udid) {
    elements.list.classList.remove('loading-card');
    elements.list.innerHTML = '';
    if (items.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'empty-state-inline';
        empty.textContent = 'Queue is empty — next tick will skip TikTok (no random posts).';
        elements.list.append(empty);
        return;
    }
    for (const item of items) {
        const row = document.createElement('article');
        row.className = 'pipeline-item';
        const title = item.caption?.trim() || '(no caption)';
        const media = item.assetName ?? 'Published media removed';
        row.innerHTML = `
            <div>
                <strong>${escapeHtml(title)}</strong>
                <div class="run-meta">${escapeHtml(media)} · ${escapeHtml(statusLabel(item.status))} · ${new Date(item.createdAt).toLocaleString()}</div>
                ${item.error ? `<div class="run-error">${escapeHtml(item.error)}</div>` : ''}
            </div>
        `;
        if (item.status === 'ready' || item.status === 'failed') {
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'button secondary';
            remove.textContent = 'Remove';
            remove.addEventListener('click', async () => {
                try {
                    await jsonRequest(`/api/devices/${encodeURIComponent(udid)}/tiktok/pipeline/items/${encodeURIComponent(item.id)}`, {
                        method: 'DELETE',
                    });
                    await refreshPipeline();
                }
                catch (error) {
                    elements.status.textContent = errorMessage(error);
                }
            });
            row.append(remove);
        }
        elements.list.append(row);
    }
}
async function refreshPipeline() {
    const udid = selectedUdid();
    if (!udid) {
        elements.list.classList.remove('loading-card');
        elements.list.textContent = 'Select a device…';
        elements.auto.checked = false;
        elements.status.textContent = '';
        return;
    }
    elements.list.classList.add('loading-card');
    elements.list.innerHTML = '<span class="spinner" aria-hidden="true"></span>Loading queue…';
    try {
        if (elements.fleet.checked) {
            const states = await Promise.all(devicesCache.map(async (device) => {
                const state = await jsonRequest(`/api/devices/${encodeURIComponent(device.udid)}/tiktok/pipeline`);
                return { device, state };
            }));
            const anchor = states[0]?.state;
            if (anchor?.fleetPreview)
                fleetPreview = anchor.fleetPreview;
            elements.auto.checked = states.every(({ state }) => state.enabled);
            if (anchor?.frequency)
                elements.frequency.value = anchor.frequency;
            elements.fleet.checked = true;
            updateFleetHint();
            const ready = states.reduce((sum, row) => sum + row.state.items.filter((item) => item.status === 'ready').length, 0);
            elements.status.textContent = elements.auto.checked
                ? `Fleet auto on · ${anchor?.frequencyLabel ?? 'cadence'} · ${ready} ready across ${states.length} phones`
                : `Fleet auto off · ${ready} ready across ${states.length} phones`;
            elements.list.classList.remove('loading-card');
            elements.list.innerHTML = '';
            for (const { device, state } of states) {
                const heading = document.createElement('h4');
                heading.className = 'pipeline-queue-heading';
                const stagger = state.staggerMinutes ?? 0;
                heading.textContent = `${device.name} · +${stagger}m · ${state.items.filter((i) => i.status === 'ready').length} ready`;
                elements.list.append(heading);
                renderItems(state.items, device.udid);
            }
            return;
        }
        const state = await jsonRequest(`/api/devices/${encodeURIComponent(udid)}/tiktok/pipeline`);
        if (state.fleetPreview)
            fleetPreview = state.fleetPreview;
        elements.auto.checked = state.enabled;
        elements.fleet.checked = state.fleet === true;
        if (state.frequency)
            elements.frequency.value = state.frequency;
        updateFleetHint();
        const label = state.frequencyLabel
            ?? state.checkTimes.map((entry) => entry.label ?? entry.localTime).filter(Boolean).join(', ');
        const stagger = state.staggerMinutes ? ` · stagger +${state.staggerMinutes}m` : '';
        elements.status.textContent = state.enabled
            ? `Auto on · ${label}${stagger}`
            : `Auto off · ${label || 'production'}${stagger} — enable auto or use Check now.`;
        renderItems(state.items, udid);
        const next = new URL(location.href);
        next.searchParams.set('template', 'pipeline');
        next.searchParams.set('device', udid);
        history.replaceState(null, '', next);
    }
    catch (error) {
        elements.list.classList.remove('loading-card');
        elements.list.textContent = errorMessage(error);
    }
}
async function saveAutoSettings(enabled) {
    const udid = selectedUdid();
    if (!udid)
        throw new Error('Select a device first.');
    await jsonRequest(`/api/devices/${encodeURIComponent(udid)}/tiktok/pipeline/auto`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            enabled,
            frequency: elements.frequency.value,
            fleet: elements.fleet.checked,
        }),
    });
}
for (const button of elements.templates) {
    button.addEventListener('click', () => selectTemplate(button.dataset.template ?? 'pipeline'));
}
elements.device.addEventListener('change', () => void refreshPipeline());
elements.fleet.addEventListener('change', () => {
    updateFleetHint();
    void refreshPipeline();
});
elements.refresh.addEventListener('click', () => void refreshPipeline());
elements.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const udid = selectedUdid();
    if (!udid) {
        elements.addResult.textContent = 'Select a device first.';
        return;
    }
    const file = elements.video.files?.[0];
    if (!file) {
        elements.addResult.textContent = 'Choose a video.';
        return;
    }
    const caption = elements.caption.value.trim();
    if (!caption) {
        elements.addResult.textContent = 'Add a title / caption.';
        return;
    }
    const form = new FormData();
    form.append('media', file, file.name);
    form.append('caption', caption);
    if (elements.fleet.checked)
        form.append('fleet', 'true');
    elements.addResult.textContent = elements.fleet.checked ? 'Uploading to all devices…' : 'Uploading…';
    try {
        await jsonRequest(`/api/devices/${encodeURIComponent(udid)}/tiktok/pipeline/items`, { method: 'POST', body: form });
        elements.video.value = '';
        elements.caption.value = '';
        elements.addResult.textContent = elements.fleet.checked ? 'Added to every device queue.' : 'Added to queue.';
        await refreshPipeline();
    }
    catch (error) {
        elements.addResult.textContent = errorMessage(error);
    }
});
elements.auto.addEventListener('change', async () => {
    const previous = !elements.auto.checked;
    if (!selectedUdid()) {
        elements.auto.checked = false;
        elements.status.textContent = 'Select a device first.';
        return;
    }
    elements.status.textContent = 'Saving…';
    try {
        await saveAutoSettings(elements.auto.checked);
        await refreshPipeline();
    }
    catch (error) {
        elements.auto.checked = previous;
        elements.status.textContent = errorMessage(error);
    }
});
elements.frequency.addEventListener('change', async () => {
    if (!selectedUdid()) {
        elements.status.textContent = 'Select a device first.';
        return;
    }
    elements.status.textContent = 'Updating frequency…';
    try {
        await saveAutoSettings(elements.auto.checked);
        await refreshPipeline();
    }
    catch (error) {
        elements.status.textContent = errorMessage(error);
        await refreshPipeline().catch(() => undefined);
    }
});
elements.checkNow.addEventListener('click', async () => {
    const udid = selectedUdid();
    if (!udid || elements.fleet.checked) {
        elements.status.textContent = elements.fleet.checked
            ? 'Check now is per-device — uncheck fleet or open a single phone.'
            : 'Select a device first.';
        return;
    }
    elements.status.textContent = 'Queuing check…';
    try {
        await jsonRequest(`/api/devices/${encodeURIComponent(udid)}/tiktok/pipeline/check-now`, { method: 'POST' });
        elements.status.textContent = 'Check queued — empty queues skip TikTok.';
        await refreshPipeline();
    }
    catch (error) {
        elements.status.textContent = errorMessage(error);
    }
});
void FLEET_VALUE;
selectTemplate(params.get('template') === 'pipeline' || params.has('device') ? 'pipeline' : '', { refresh: false });
void loadDevices().then(() => {
    if (!elements.workspace.hidden)
        return refreshPipeline();
}).catch((error) => {
    elements.status.textContent = errorMessage(error);
});
export {};
