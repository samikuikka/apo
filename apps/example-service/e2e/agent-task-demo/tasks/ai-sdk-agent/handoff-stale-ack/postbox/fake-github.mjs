// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Marco Gernand

/**
 * In-memory stand-in for the GitHub REST API, covering only the endpoints
 * agent-postbox may call. Synthetic data only.
 */
export function fakeGitHub({ owner = 'example-org', repo = 'example-repo', login: defaultLogin = 'agent-a-bot', classicScopes } = {}) {
  const base = `/repos/${owner}/${repo}`;
  const state = {
    calls: [],
    issues: new Map(),
    comments: new Map(),
    reviews: new Map(),
    nextId: 1000,
    failNext: null, // { method, path, status } or { method, path, network: true }
    dropNextWrite: false, // simulate a lost response: write applied, client sees network error
  };
  const html = (p) => `https://github.com/${owner}/${repo}${p}`;
  const json = (status, data, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: new Map(Object.entries(headers)),
    text: async () => (data === undefined ? '' : JSON.stringify(data)),
  });

  state.addIssue = (number, fields = {}) => {
    state.issues.set(number, { number, title: `Issue ${number}`, body: '', state: 'open', user: { login: 'human' }, labels: [], html_url: html(`/issues/${number}`), ...fields });
    return state.issues.get(number);
  };

  // Several agents (different logins) can share one in-memory repository.
  async function fetchAs(login, url, opts = {}) {
    const u = new URL(url);
    const method = opts.method || 'GET';
    const path = u.pathname;
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    state.calls.push({ method, path, query: Object.fromEntries(u.searchParams), body, auth: opts.headers?.Authorization });
    if (state.failNext && state.failNext.method === method && path.startsWith(state.failNext.path)) {
      const f = state.failNext;
      state.failNext = null;
      if (f.network) throw new Error('socket hang up');
      return json(f.status, { message: 'synthetic failure' });
    }
    const lost = (res) => {
      if (method !== 'GET' && state.dropNextWrite) {
        state.dropNextWrite = false;
        throw new Error('connection reset after write');
      }
      return res;
    };
    let m;
    if (method === 'GET' && path === '/user') return json(200, { login });
    if (method === 'GET' && path === base) {
      return json(200, { full_name: `${owner}/${repo}`, private: true, permissions: { admin: false, push: true } }, classicScopes !== undefined ? { 'x-oauth-scopes': classicScopes } : {});
    }
    if (method === 'GET' && path === `${base}/issues`) {
      const labels = u.searchParams.get('labels');
      const st = u.searchParams.get('state') || 'open';
      return json(200, [...state.issues.values()].filter((i) => (st === 'all' || i.state === st) && (!labels || i.labels.some((l) => l.name === labels))));
    }
    if (method === 'POST' && path === `${base}/issues`) {
      const number = state.issues.size + 1;
      state.addIssue(number, { title: body.title, body: body.body, user: { login }, labels: body.labels.map((name) => ({ name })) });
      return lost(json(201, state.issues.get(number)));
    }
    if ((m = path.match(new RegExp(`^${base}/issues/(\\d+)$`))) && method === 'GET') {
      const i = state.issues.get(Number(m[1]));
      return i ? json(200, i) : json(404, { message: 'Not Found' });
    }
    if ((m = path.match(new RegExp(`^${base}/issues/(\\d+)/comments$`)))) {
      const n = Number(m[1]);
      if (!state.issues.has(n)) return json(404, { message: 'Not Found' });
      if (method === 'GET') return json(200, [...state.comments.values()].filter((c) => c.issue === n));
      const id = state.nextId++;
      state.comments.set(id, { id, issue: n, body: body.body, user: { login }, created_at: '2026-01-01T00:00:00Z', html_url: html(`/issues/${n}#issuecomment-${id}`) });
      return lost(json(201, state.comments.get(id)));
    }
    if ((m = path.match(new RegExp(`^${base}/issues/comments/(\\d+)$`))) && method === 'GET') {
      const c = state.comments.get(Number(m[1]));
      return c ? json(200, c) : json(404, { message: 'Not Found' });
    }
    if ((m = path.match(new RegExp(`^${base}/issues/(\\d+)/labels(?:/(.+))?$`)))) {
      const i = state.issues.get(Number(m[1]));
      if (!i) return json(404, { message: 'Not Found' });
      if (method === 'GET') return json(200, i.labels);
      if (method === 'POST') {
        for (const name of body.labels) if (!i.labels.some((l) => l.name === name)) i.labels.push({ name });
        return lost(json(200, i.labels));
      }
      if (method === 'DELETE') {
        const name = decodeURIComponent(m[2]);
        if (!i.labels.some((l) => l.name === name)) return json(404, { message: 'Label does not exist' });
        i.labels = i.labels.filter((l) => l.name !== name);
        return json(200, i.labels);
      }
    }
    if ((m = path.match(new RegExp(`^${base}/pulls/(\\d+)$`))) && method === 'GET') {
      const i = state.issues.get(Number(m[1]));
      return i?.pull ? json(200, { number: i.number, state: i.state, user: i.user, head: { sha: i.pull.sha } }) : json(404, { message: 'Not Found' });
    }
    if ((m = path.match(new RegExp(`^${base}/pulls/(\\d+)/reviews(?:/(\\d+))?$`)))) {
      const n = Number(m[1]);
      if (method === 'GET' && m[2]) {
        const r = state.reviews.get(Number(m[2]));
        return r ? json(200, r) : json(404, { message: 'Not Found' });
      }
      if (method === 'GET') return json(200, [...state.reviews.values()].filter((r) => r.pull === n));
      const states = { APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' };
      const id = state.nextId++;
      state.reviews.set(id, { id, pull: n, state: states[body.event], body: body.body, commit_id: body.commit_id, user: { login }, html_url: html(`/pull/${n}#pullrequestreview-${id}`) });
      return lost(json(200, state.reviews.get(id)));
    }
    return json(404, { message: `fake: no route for ${method} ${path}` });
  }

  const fetch = (url, opts) => fetchAs(defaultLogin, url, opts);
  const fetchFor = (other) => (url, opts) => fetchAs(other, url, opts);
  return { fetch, fetchFor, state };
}
