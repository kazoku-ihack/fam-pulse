// Static manifest of every route, served at GET / (no auth) so the API is self-documenting —
// judges, Mendix devs, or anyone with the URL can see what's available without reading the repo.

export const API_INDEX = {
  name: 'Kazoku Pulse — Demo API',
  interactiveDocs: '/docs',
  openApiSpec: '/openapi.json',
  repo: 'https://github.com/kazoku-ihack/fam-pulse#readme',
  judgeConsole: '/judge',
  note: 'Every route below requires header "x-api-key: <your key>" except the ones marked public. An optional "Authorization: Bearer <deviceToken>" (from POST /v1/activation/complete) scopes a request to its household and enforces parent/adult_child role gating; omitted, routes behave exactly as before activation existed. Full request/response schemas: /docs.',
  routes: [
    { method: 'GET', path: '/health', auth: 'public' },
    { method: 'GET', path: '/judge', auth: 'public', description: 'Judge Console (static page; /judge/judge.html also works)' },
    { method: 'GET', path: '/v1/demo/status', auth: 'public (or JUDGE_KEY if set)' },
    { method: 'POST', path: '/v1/demo/reset', auth: 'public (or JUDGE_KEY if set)' },
    { method: 'POST', path: '/v1/demo/scenario/:name', auth: 'public (or JUDGE_KEY if set)', description: 'name = wandering | false-alarm | care-reply' },
    { method: 'POST', path: '/v1/webhooks/uber', auth: 'HMAC signature (x-uber-signature), not x-api-key' },

    { method: 'POST', path: '/v1/activation/verify', auth: 'x-api-key', description: 'body: { role, policyNumber, insuredDob, phone, email, deviceId }' },
    { method: 'POST', path: '/v1/activation/complete', auth: 'x-api-key', description: 'body: { activationId, deviceId, pushToken? } — issues the deviceToken' },
    { method: 'GET', path: '/v1/activation/status', auth: 'x-api-key', description: 'query: deviceId' },
    { method: 'GET', path: '/v1/household/:id', auth: 'x-api-key' },

    { method: 'POST', path: '/v1/healthkit/metrics', auth: 'x-api-key' },
    { method: 'GET', path: '/v1/healthkit/metrics', auth: 'x-api-key' },

    { method: 'GET', path: '/v1/frs/today', auth: 'x-api-key' },
    { method: 'GET', path: '/v1/frs/history', auth: 'x-api-key' },
    { method: 'GET', path: '/v1/frs/reviews', auth: 'x-api-key' },

    { method: 'GET', path: '/v1/incidents', auth: 'x-api-key' },
    { method: 'GET', path: '/v1/incidents/:id', auth: 'x-api-key' },
    { method: 'PATCH', path: '/v1/incident/:id', auth: 'x-api-key', description: 'body: { pickupConfirmed: true }' },
    { method: 'POST', path: '/v1/sos', auth: 'x-api-key' },

    { method: 'GET', path: '/v1/telemetry', auth: 'x-api-key' },

    { method: 'GET', path: '/v1/parent/status', auth: 'x-api-key' },
    { method: 'PATCH', path: '/v1/consent', auth: 'x-api-key', description: 'body: { sharingEnabled: boolean }' },
    { method: 'GET', path: '/v1/carePlan/next', auth: 'x-api-key' },

    { method: 'GET', path: '/v1/events', auth: 'x-api-key' },

    { method: 'POST', path: '/v1/uber/dispatch', auth: 'x-api-key', description: 'header: Idempotency-Key' },
    { method: 'GET', path: '/v1/uber/dispatch/:id', auth: 'x-api-key' },
    { method: 'DELETE', path: '/v1/uber/dispatch/:id', auth: 'x-api-key' },

    { method: 'POST', path: '/v1/careRequest', auth: 'x-api-key' },
    { method: 'GET', path: '/v1/careRequest/:id', auth: 'x-api-key' },
    { method: 'PATCH', path: '/v1/carePlan/:id', auth: 'x-api-key', description: 'body: { action: "approve" | "clarify" }' },

    { method: 'GET', path: '/v1/wallet/balance', auth: 'x-api-key' },
    { method: 'POST', path: '/v1/jpyc/transfer', auth: 'x-api-key' },
    { method: 'POST', path: '/v1/jpyc/batchTransfer', auth: 'x-api-key' },
    { method: 'GET', path: '/v1/settlement/current', auth: 'x-api-key' },
    { method: 'PATCH', path: '/v1/settlement/:id/line/:lineId', auth: 'x-api-key', description: 'body: { disputed: boolean }' },

    { method: 'POST', path: '/v1/attestation/trigger', auth: 'x-api-key' },
    { method: 'GET', path: '/v1/attestation/:id', auth: 'x-api-key' },
    { method: 'POST', path: '/v1/attestation/settlement/batch', auth: 'x-api-key' },
    { method: 'GET', path: '/v1/attestation/signer/current', auth: 'x-api-key' },

    { method: 'GET', path: '/v1/settings', auth: 'x-api-key' },
    { method: 'PATCH', path: '/v1/settings', auth: 'x-api-key' },
    { method: 'PATCH', path: '/v1/policy/monitoringConfig', auth: 'x-api-key' },
  ],
};

export function apiIndexHtml() {
  const rows = API_INDEX.routes
    .map(
      (r) =>
        `<tr><td class="m m-${r.method.toLowerCase()}">${r.method}</td><td><code>${r.path}</code></td><td>${r.auth}</td><td>${r.description || ''}</td></tr>`
    )
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${API_INDEX.name}</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 900px; margin: 40px auto; padding: 0 16px; color: #1a1d23; background: #f6f7f9; }
  @media (prefers-color-scheme: dark) { body { color: #e6e8eb; background: #0f1115; } table { background: #171a21; } tr { border-color: #2a2e37 !important; } }
  h1 { font-size: 1.3rem; }
  p.note { color: #6b7280; font-size: 0.9rem; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; background: #fff; border-radius: 8px; overflow: hidden; }
  td { padding: 8px 10px; border-bottom: 1px solid #e2e5ea; font-size: 0.85rem; vertical-align: top; }
  code { font-family: ui-monospace, monospace; }
  .m { font-weight: 700; font-size: 0.75rem; }
  .m-get { color: #2563eb; } .m-post { color: #16a34a; } .m-patch { color: #b45309; } .m-delete { color: #dc2626; }
  a { color: #2563eb; }
</style></head>
<body>
  <h1>${API_INDEX.name}</h1>
  <p class="note">${API_INDEX.note}<br>
    <a href="${API_INDEX.interactiveDocs}">Interactive docs (Swagger UI)</a> ·
    <a href="${API_INDEX.openApiSpec}">OpenAPI spec (JSON)</a> ·
    <a href="${API_INDEX.judgeConsole}">Judge Console</a> ·
    <a href="${API_INDEX.repo}">Repo</a>
  </p>
  <table>
    <tbody>${rows}</tbody>
  </table>
</body></html>`;
}

// Custom Swagger UI shell — points at our own /openapi.json rather than swagger-ui-dist's
// bundled index.html (which defaults to the Petstore demo spec). Assets are served statically
// from the swagger-ui-dist package at this same /docs path, no CDN involved.
export function swaggerDocsHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${API_INDEX.name} — API Docs</title>
  <link rel="stylesheet" href="/docs/swagger-ui.css">
  <link rel="icon" href="/docs/favicon-32x32.png">
  <style>body { margin: 0; } .topbar { display: none; }</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="/docs/swagger-ui-bundle.js"></script>
  <script src="/docs/swagger-ui-standalone-preset.js"></script>
  <script>
    window.onload = () => {
      window.ui = SwaggerUIBundle({
        url: '/openapi.json',
        dom_id: '#swagger-ui',
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
        layout: 'StandaloneLayout',
      });
    };
  </script>
</body>
</html>`;
}
