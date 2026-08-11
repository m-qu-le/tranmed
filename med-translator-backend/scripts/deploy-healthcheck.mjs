const origin = `http://127.0.0.1:${process.env.PORT || '8080'}`;
const endpoints = ['/api/health', '/api/readiness'];

for (const endpoint of endpoints) {
    const response = await fetch(`${origin}${endpoint}`);
    if (!response.ok) {
        throw new Error(`Health check ${endpoint} trả HTTP ${response.status}.`);
    }
}

console.log('Backend health and readiness are healthy.');
