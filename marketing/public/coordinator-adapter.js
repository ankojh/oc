export class CoordinatorProvider {
    fetcher;
    constructor(fetcher = fetch) {
        this.fetcher = fetcher;
    }
    async request(path, body) {
        const fetcher = this.fetcher;
        const r = await fetcher(path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
        const json = await r.json();
        if (!r.ok)
            throw new Error(json.error?.message || 'The integration is unavailable. Your existing run is not restarted.');
        return json;
    }
    connection() { return this.request('/api/connection'); }
    async research(mode, videoUrl, creatorGoal) {
        const out = await this.request('/api/integrations', { mode, videoUrl, creatorGoal: creatorGoal || null });
        return out.integration;
    }
    observe(id) { return this.request(`/api/integrations/${encodeURIComponent(id)}`); }
    async generate(id, confirmCredits) {
        if (!confirmCredits)
            throw new Error('Acknowledge OpusClip credits before Generate.');
        const out = await this.request(`/api/integrations/${encodeURIComponent(id)}/generate`, { confirmCredits: true });
        return out.integration;
    }
    retryReview(id) { return this.request(`/api/integrations/${encodeURIComponent(id)}/retry-review`, {}); }
    retryHandoff(id) { return this.request(`/api/integrations/${encodeURIComponent(id)}/retry-handoff`, {}); }
    resumePolling(id) { return this.request(`/api/integrations/${encodeURIComponent(id)}/resume-polling`, {}); }
    reconcile(id) { return this.request(`/api/integrations/${encodeURIComponent(id)}/reconcile`, {}); }
    adopt(id, projectId) { return this.request(`/api/integrations/${encodeURIComponent(id)}/adopt-project`, { projectId }); }
}
