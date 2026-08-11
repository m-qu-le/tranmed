const action = process.argv[2];
const token = process.env.MAINTENANCE_CONTROL_TOKEN?.trim();
const origin = `http://127.0.0.1:${process.env.PORT || '8080'}`;

if (!['pause', 'resume'].includes(action)) {
    throw new Error('Maintenance action must be pause or resume.');
}
if (!token) {
    throw new Error('MAINTENANCE_CONTROL_TOKEN is required for deployment maintenance.');
}

async function call(path, options = {}) {
    const response = await fetch(`${origin}${path}`, {
        ...options,
        headers: {
            ...options.headers,
            'X-Maintenance-Token': token,
        },
    });
    if (!response.ok) throw new Error(`Maintenance API ${path} returned HTTP ${response.status}.`);
    return response.json();
}

if (action === 'resume') {
    await call('/api/translate/maintenance/cancel', { method: 'POST' });
    console.log('Queue maintenance pause cancelled.');
    process.exit(0);
}

await call('/api/translate/maintenance/pause', { method: 'POST' });
const timeoutAt = Date.now() + 15 * 60_000;
while (Date.now() < timeoutAt) {
    const status = await call('/api/translate/status');
    if (status.maintenanceState === 'drained' && status.worker?.activeJobs === 0) {
        console.log('Queue drained for deployment.');
        process.exit(0);
    }
    await new Promise(resolve => setTimeout(resolve, 2_000));
}

throw new Error('Timed out waiting for the queue to drain.');
