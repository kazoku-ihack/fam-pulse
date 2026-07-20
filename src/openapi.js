// Hand-authored OpenAPI 3.0 document — mirrors the actual zod schemas and response shapes in
// src/routes/*.js exactly (not generated/inferred), so it stays a reliable contract for UI
// teams building against this API. Served at GET /openapi.json and rendered at GET /docs.

const Error_ = {
  type: 'object',
  properties: {
    error: { type: 'string', example: 'VALIDATION_ERROR' },
    message: { type: 'string' },
    details: { type: 'array', items: {} },
  },
  required: ['error'],
};

const FRSResult = {
  type: 'object',
  properties: {
    score: { type: 'integer', minimum: 0, maximum: 100 },
    statusText: { type: 'string', example: 'Feeling good' },
    emoticon: { type: 'string', enum: ['happy', 'neutral', 'concerned'] },
    factors: {
      type: 'object',
      properties: {
        mobility: { type: 'number' },
        vitals: { type: 'number' },
        sleep: { type: 'number' },
        routine: { type: 'number' },
      },
    },
    dataSufficient: { type: 'boolean' },
  },
};

const MetricsInput = {
  type: 'object',
  required: ['date', 'dailySteps', 'sleepHours', 'heartRateAvg', 'heartRateResting'],
  properties: {
    parentId: { type: 'string', example: 'yoshiko-001' },
    date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', example: '2026-07-19' },
    dailySteps: { type: 'integer', minimum: 0, maximum: 50000 },
    sleepHours: { type: 'number', minimum: 0, maximum: 16 },
    heartRateAvg: { type: 'integer', minimum: 30, maximum: 220 },
    heartRateResting: { type: 'integer', minimum: 30, maximum: 220 },
  },
};

const MetricsRow = {
  allOf: [MetricsInput, { type: 'object', properties: { ts: { type: 'integer', description: 'epoch ms' } } }],
};

const TriageResult = {
  type: 'object',
  nullable: true,
  properties: {
    severity: { type: 'string', enum: ['low', 'medium', 'high'] },
    falseAlarmLikelihood: { type: 'number', minimum: 0, maximum: 1 },
    recommendedAction: { type: 'string', enum: ['notify_now', 'soft_check', 'dispatch_suggest'] },
    reasoning: { type: 'string' },
    guardsPass: { type: 'boolean' },
  },
};

const TimelineEntry = {
  type: 'object',
  properties: {
    ts: { type: 'integer' },
    event: { type: 'string' },
    detail: { type: 'string' },
  },
};

const Incident = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    parentId: { type: 'string' },
    type: { type: 'string', enum: ['WANDERING', 'SOS', 'LOW_FRS', 'INACTIVITY'] },
    severity: { type: 'string', enum: ['low', 'medium', 'high'] },
    ts: { type: 'integer' },
    active: { type: 'boolean' },
    lat: { type: 'number', nullable: true },
    lng: { type: 'number', nullable: true },
    exitTs: { type: 'integer', nullable: true },
    dwellMin: { type: 'number', nullable: true },
    escalationDueTs: { type: 'integer', nullable: true },
    pickupConfirmed: { type: 'boolean' },
    dropoffConfirmed: { type: 'boolean' },
    timeline: { type: 'array', items: TimelineEntry },
    pt01Eligible: { type: 'boolean' },
    triage: TriageResult,
  },
};

const DriverInfo = {
  type: 'object',
  properties: {
    name: { type: 'string', example: 'Kenji T.' },
    rating: { type: 'number', example: 4.9 },
    vehicle: { type: 'string', example: 'Toyota Prius' },
    plate: { type: 'string' },
    driverWalletAddr: { type: 'string' },
  },
};

const DispatchCreateResponse = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    incidentId: { type: 'string' },
    status: { type: 'string', enum: ['requested', 'accepted', 'en_route', 'arrived', 'completed', 'cancelled'] },
    driver: DriverInfo,
    etaMin: { type: 'number', nullable: true },
    lat: { type: 'number' },
    lng: { type: 'number' },
    retryCount: { type: 'integer' },
  },
};

const DispatchPollResponse = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['requested', 'accepted', 'en_route', 'arrived', 'completed', 'cancelled'] },
    driverName: { type: 'string' },
    rating: { type: 'number' },
    vehicle: { type: 'string' },
    plate: { type: 'string' },
    etaMin: { type: 'number', nullable: true },
    driverLocation: { type: 'object', properties: { lat: { type: 'number' }, lng: { type: 'number' } } },
    routePolyline: { type: 'array', items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 } },
    driverWalletAddr: { type: 'string' },
    retryCount: { type: 'integer' },
  },
};

const CarePlan = {
  type: 'object',
  nullable: true,
  properties: {
    staff: { type: 'string' },
    visitAt: { type: 'string', format: 'date-time' },
    services: { type: 'array', items: { type: 'string' } },
    rate: { type: 'number', maximum: 10000 },
  },
};

const CareRequest = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    parentId: { type: 'string' },
    needSummary: { type: 'string' },
    windows: { type: 'array', items: { type: 'string' } },
    channelStatus: {
      type: 'object',
      properties: {
        requestedChannel: { type: 'string', enum: ['email', 'call'] },
        executedChannel: { type: 'string', enum: ['email'], description: 'call channel is STUB in this demo' },
        reasoning: { type: 'string' },
        emailSent: { type: 'boolean' },
        parsedByClaude: { type: 'boolean' },
      },
    },
    slaDueTs: { type: 'integer', description: 'epoch ms, 4h timescaled SLA' },
    plan: CarePlan,
    status: { type: 'string', enum: ['pending', 'proposed', 'approved', 'clarify'] },
  },
};

const Attestation = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    policyId: { type: 'string' },
    triggerCode: { type: 'string', enum: ['PT-01', 'PT-02', 'PT-03', 'PT-04'] },
    payoutAmount: { type: 'integer', description: 'JPY, fixed schedule: PT-01=3000 PT-02=30000 PT-03=20000 PT-04=10000' },
    recipient: { type: 'string', description: '0x-prefixed EVM address' },
    timestamp: { type: 'integer' },
    nonce: { type: 'string' },
    payloadHash: { type: 'string' },
    signature: { type: 'string' },
    signerAddress: { type: 'string' },
    txHash: { type: 'string', nullable: true },
    status: { type: 'string', enum: ['signed', 'paid'] },
    source: { type: 'string', enum: ['stub', 'protosure', 'stub-fallback'] },
    raterRef: { type: 'string', nullable: true },
  },
};

const SettlementLine = {
  type: 'object',
  properties: {
    lineId: { type: 'string' },
    type: { type: 'string', enum: ['visit', 'reward'] },
    description: { type: 'string' },
    amount: { type: 'number' },
    attested: { type: 'boolean' },
    disputed: { type: 'boolean' },
    ts: { type: 'integer' },
  },
};

const Settlement = {
  type: 'object',
  nullable: true,
  properties: {
    id: { type: 'string' },
    parentId: { type: 'string' },
    period: { type: 'string', example: '2026-06' },
    lines: { type: 'array', items: SettlementLine },
    netCredit: { type: 'number', description: 'sum of attested, non-disputed visit lines' },
    pt03Credit: { type: 'number' },
  },
};

const Chips = {
  type: 'object',
  properties: {
    careNetwork: { type: 'string', enum: ['auto', 'manual'] },
    careChannel: { type: 'string', enum: ['auto', 'email', 'call'] },
    triageMode: { type: 'string', enum: ['auto', 'manual'] },
    frsReviewMode: { type: 'string', enum: ['auto', 'manual'] },
  },
};

const KnownSafePlace = {
  type: 'object',
  properties: { name: { type: 'string' }, lat: { type: 'number' }, lng: { type: 'number' } },
};

const Settings = {
  type: 'object',
  properties: {
    parentId: { type: 'string' },
    pairingStatus: { type: 'string', example: 'connected' },
    sharingEnabled: { type: 'boolean' },
    homeLatLng: { type: 'object', properties: { lat: { type: 'number' }, lng: { type: 'number' } } },
    geofenceRadius: { type: 'integer', minimum: 100, maximum: 2000 },
    monitoringActive: { type: 'boolean' },
    knownSafePlaces: { type: 'array', items: KnownSafePlace },
    chips: Chips,
  },
};

const ParentStatus = {
  type: 'object',
  properties: {
    pairingStatus: { type: 'string' },
    sharingEnabled: { type: 'boolean' },
    geofenceConfigured: { type: 'boolean' },
    monitoringActive: { type: 'boolean' },
  },
};

const TelemetryFrame = {
  type: 'object',
  properties: {
    lastLocation: { type: 'object', properties: { lat: { type: 'number' }, lng: { type: 'number' } } },
    accuracyM: { type: 'number' },
    dailySteps: { type: 'integer', nullable: true },
    sleepHours: { type: 'number', nullable: true },
    lastHeartRate: { type: 'integer', nullable: true },
    sharingEnabled: { type: 'boolean', description: 'false means consent is off — all other fields are omitted' },
    ts: { type: 'integer' },
  },
};

const Event = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: ['wandering', 'sos', 'frs_dip', 'frs_void', 'visit_completed', 'payout', 'settlement', 'settings'],
    },
    ts: { type: 'integer' },
    title: { type: 'string' },
    deepLink: { type: 'string', nullable: true },
    refId: { type: 'string', nullable: true },
  },
};

const FrsReview = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    parentId: { type: 'string' },
    ts: { type: 'integer' },
    conditionType: { type: 'string', enum: ['LOW_FRS', 'INACTIVITY'] },
    conditionKey: { type: 'string' },
    decision: { type: 'string', enum: ['raise', 'void'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    category: { type: 'string', enum: ['genuine_decline', 'watch_not_worn', 'data_gap', 'one_off_outlier'] },
    reasoning: { type: 'string' },
  },
};

function jsonBody(schema, example) {
  return { content: { 'application/json': { schema, ...(example ? { example } : {}) } } };
}
function jsonResponse(description, schema) {
  return { description, content: { 'application/json': { schema } } };
}
const errRes = (description) => jsonResponse(description, Error_);
const parentIdParam = { name: 'parentId', in: 'query', schema: { type: 'string' }, description: 'defaults to yoshiko-001' };
const idParam = (name = 'id') => ({ name, in: 'path', required: true, schema: { type: 'string' } });

export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Kazoku Pulse — Demo API',
    version: '1.0.0',
    description:
      'Elder-wellness monitoring demo backend: FRS scoring, geo-fence wandering detection with Claude ' +
      'triage, 助けて! SOS, simulated taxi dispatch, a Claude-parsed care-request loop, and a REAL-LITE ' +
      'on-chain payout path on Avalanche Fuji gated by a parametric attestation. See ' +
      '[README](https://github.com/kazoku-ihack/fam-pulse#readme) for the full 8-scene runbook.',
  },
  servers: [{ url: 'https://fam-pulse-api.onrender.com', description: 'Live demo (Render)' }],
  security: [{ ApiKeyAuth: [] }],
  components: {
    securitySchemes: {
      ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'x-api-key' },
    },
    schemas: {
      Error: Error_,
      FRSResult,
      MetricsInput,
      MetricsRow,
      Incident,
      TriageResult,
      DispatchCreateResponse,
      DispatchPollResponse,
      CareRequest,
      CarePlan,
      Attestation,
      Settlement,
      SettlementLine,
      Settings,
      ParentStatus,
      TelemetryFrame,
      Event,
      FrsReview,
    },
  },
  tags: [
    { name: 'System', description: 'Health, discovery — no auth' },
    { name: 'FRS', description: 'Family Reassurance Score wellness pipeline' },
    { name: 'HealthKit', description: 'Wearable metrics ingest' },
    { name: 'Incidents', description: 'Wandering / SOS / LOW_FRS / INACTIVITY' },
    { name: 'Telemetry', description: 'Live location + vitals poll frame' },
    { name: 'Parent', description: 'Pairing/consent status + next care visit' },
    { name: 'Events', description: 'Unified activity feed (poll-based "push")' },
    { name: 'Dispatch', description: 'Simulated taxi dispatch + provider webhook' },
    { name: 'Care', description: 'Care-request loop (Claude-parsed replies)' },
    { name: 'Payments', description: 'JPYC wallet + on-chain transfer + settlement' },
    { name: 'Attestation', description: 'Parametric trigger validation + REAL-LITE signing' },
    { name: 'Settings', description: 'Chips/prefs + geo-fence policy' },
    { name: 'Demo', description: 'Judge Console actions — public, JUDGE_KEY-gated only' },
  ],
  paths: {
    '/health': {
      get: {
        tags: ['System'],
        summary: 'Liveness check',
        security: [],
        responses: { 200: jsonResponse('OK', { type: 'object', properties: { ok: { type: 'boolean' }, ts: { type: 'integer' } } }) },
      },
    },
    '/': {
      get: {
        tags: ['System'],
        summary: 'API index (this document, human-readable)',
        security: [],
        responses: { 200: { description: 'Route manifest (HTML or JSON via content negotiation)' } },
      },
    },
    '/openapi.json': {
      get: {
        tags: ['System'],
        summary: 'This OpenAPI document',
        security: [],
        responses: { 200: { description: 'OpenAPI 3.0 JSON' } },
      },
    },

    '/v1/frs/today': {
      get: {
        tags: ['FRS'],
        summary: "Today's FRS score",
        parameters: [parentIdParam],
        responses: { 200: jsonResponse('FRS for today (dataSufficient:false if no metrics row yet)', FRSResult) },
      },
    },
    '/v1/frs/history': {
      get: {
        tags: ['FRS'],
        summary: 'FRS score history',
        parameters: [parentIdParam, { name: 'days', in: 'query', schema: { type: 'integer', default: 7, minimum: 1, maximum: 90 } }],
        responses: {
          200: jsonResponse('Oldest-first', {
            type: 'array',
            items: { type: 'object', properties: { date: { type: 'string' }, score: { type: 'integer', nullable: true } } },
          }),
        },
      },
    },
    '/v1/frs/reviews': {
      get: {
        tags: ['FRS'],
        summary: "Claude's FRS false-alarm review audit trail",
        parameters: [parentIdParam],
        responses: { 200: jsonResponse('Newest-first', { type: 'array', items: FrsReview }) },
      },
    },

    '/v1/healthkit/metrics': {
      post: {
        tags: ['HealthKit'],
        summary: 'Upsert a day of wearable metrics (also recomputes that day\'s FRS)',
        requestBody: {
          required: true,
          ...jsonBody(MetricsInput, { date: '2026-07-19', dailySteps: 4200, sleepHours: 7.2, heartRateAvg: 70, heartRateResting: 64 }),
        },
        responses: {
          201: jsonResponse('Upserted', MetricsInput),
          400: errRes('Validation error (steps 0-50000, sleep 0-16h, HR 30-220)'),
        },
      },
      get: {
        tags: ['HealthKit'],
        summary: 'List all metrics rows for a parent, oldest first',
        parameters: [parentIdParam],
        responses: { 200: jsonResponse('OK', { type: 'array', items: MetricsRow }) },
      },
    },

    '/v1/incidents': {
      get: {
        tags: ['Incidents'],
        summary: 'List incidents',
        parameters: [
          parentIdParam,
          { name: 'active', in: 'query', schema: { type: 'string', enum: ['1', '0', 'true', 'false'] }, description: 'omit for all' },
        ],
        responses: { 200: jsonResponse('Newest-first', { type: 'array', items: Incident }) },
      },
    },
    '/v1/incidents/{id}': {
      get: {
        tags: ['Incidents'],
        summary: 'Get one incident',
        parameters: [idParam()],
        responses: { 200: jsonResponse('OK', Incident), 404: errRes('NOT_FOUND') },
      },
    },
    '/v1/incident/{id}': {
      patch: {
        tags: ['Incidents'],
        summary: 'Confirm pickup (only valid once the dispatch is en_route)',
        parameters: [idParam()],
        requestBody: jsonBody({ type: 'object', required: ['pickupConfirmed'], properties: { pickupConfirmed: { type: 'boolean', enum: [true] } } }),
        responses: {
          200: jsonResponse('OK', Incident),
          404: errRes('NOT_FOUND'),
          409: errRes('DISPATCH_NOT_EN_ROUTE — no dispatch is currently en_route for this incident'),
        },
      },
    },
    '/v1/sos': {
      post: {
        tags: ['Incidents'],
        summary: '助けて! — always severity:high, no dedupe, never triaged by Claude',
        requestBody: jsonBody({
          type: 'object',
          properties: { parentId: { type: 'string' }, lat: { type: 'number' }, lng: { type: 'number' } },
        }),
        responses: { 201: jsonResponse('Created', Incident) },
      },
    },

    '/v1/telemetry': {
      get: {
        tags: ['Telemetry'],
        summary: 'Poll frame: location + today\'s vitals (2s polling, replaces the spec\'d WS channel)',
        parameters: [parentIdParam],
        responses: { 200: jsonResponse('If sharingEnabled is false, only that one field is returned', TelemetryFrame) },
      },
    },

    '/v1/parent/status': {
      get: {
        tags: ['Parent'],
        summary: 'Pairing/consent/geo-fence/monitoring status (powers all W-08 cards in one call)',
        parameters: [parentIdParam],
        responses: { 200: jsonResponse('OK', ParentStatus) },
      },
    },
    '/v1/consent': {
      patch: {
        tags: ['Parent'],
        summary: 'Toggle location sharing (consent gate — real, closes /v1/telemetry when false)',
        requestBody: {
          required: true,
          ...jsonBody({ type: 'object', required: ['sharingEnabled'], properties: { parentId: { type: 'string' }, sharingEnabled: { type: 'boolean' } } }),
        },
        responses: { 200: jsonResponse('OK', { type: 'object', properties: { sharingEnabled: { type: 'boolean' } } }) },
      },
    },
    '/v1/carePlan/next': {
      get: {
        tags: ['Parent'],
        summary: 'Next approved care visit, or null',
        parameters: [parentIdParam],
        responses: {
          200: jsonResponse('null if no plan is approved yet', {
            type: 'object',
            nullable: true,
            properties: { staff: { type: 'string' }, visitAt: { type: 'string', format: 'date-time' } },
          }),
        },
      },
    },

    '/v1/events': {
      get: {
        tags: ['Events'],
        summary: 'Unified activity feed — every state change anywhere appends here',
        parameters: [parentIdParam, { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, maximum: 200 } }],
        responses: { 200: jsonResponse('Newest-first', { type: 'array', items: Event }) },
      },
    },

    '/v1/uber/dispatch': {
      post: {
        tags: ['Dispatch'],
        summary: 'Dispatch a taxi to an incident (pickup = incident location, dropoff = home, server-derived)',
        parameters: [{ name: 'Idempotency-Key', in: 'header', schema: { type: 'string' }, description: 'replays the same dispatch instead of creating a duplicate' }],
        requestBody: { required: true, ...jsonBody({ type: 'object', required: ['incidentId'], properties: { incidentId: { type: 'string' } } }) },
        responses: {
          201: jsonResponse('Created', DispatchCreateResponse),
          200: jsonResponse('Idempotency-Key replay of an existing dispatch', DispatchCreateResponse),
          404: errRes('INCIDENT_NOT_FOUND'),
          409: errRes('DUPLICATE_ACTIVE_DISPATCH'),
          429: errRes('RETRY_LIMIT_EXCEEDED (max 3 dispatches per incident)'),
        },
      },
    },
    '/v1/uber/dispatch/{id}': {
      get: {
        tags: ['Dispatch'],
        summary: 'Poll dispatch status (2s polling)',
        parameters: [idParam()],
        responses: { 200: jsonResponse('OK', DispatchPollResponse), 404: errRes('NOT_FOUND') },
      },
      delete: {
        tags: ['Dispatch'],
        summary: 'Cancel a dispatch',
        parameters: [idParam()],
        responses: { 204: { description: 'Cancelled' }, 404: errRes('NOT_FOUND') },
      },
    },
    '/v1/webhooks/uber': {
      post: {
        tags: ['Dispatch'],
        summary: 'Provider webhook — HMAC-signed (x-uber-signature), NOT x-api-key. Called by the internal simulator, not meant for external callers.',
        security: [],
        parameters: [{ name: 'x-uber-signature', in: 'header', required: true, schema: { type: 'string' } }],
        requestBody: jsonBody({
          type: 'object',
          properties: {
            dispatchId: { type: 'string' },
            incidentId: { type: 'string' },
            status: { type: 'string', enum: ['accepted', 'en_route', 'arrived', 'completed'] },
            driverLocation: { type: 'object', properties: { lat: { type: 'number' }, lng: { type: 'number' } } },
            etaMin: { type: 'number' },
            ts: { type: 'integer' },
          },
        }),
        responses: {
          200: jsonResponse('OK', { type: 'object', properties: { ok: { type: 'boolean' } } }),
          401: errRes('BAD_SIGNATURE'),
          409: errRes('INVALID_STATE_TRANSITION — state machine cannot skip states, or DISPATCH_ALREADY_TERMINAL'),
        },
      },
    },

    '/v1/careRequest': {
      post: {
        tags: ['Care'],
        summary: 'Submit a care request — agent picks a channel (email only in this demo), 4h SLA timer starts',
        requestBody: {
          required: true,
          ...jsonBody({
            type: 'object',
            required: ['needSummary'],
            properties: { parentId: { type: 'string' }, needSummary: { type: 'string', maxLength: 500 }, windows: { type: 'array', items: { type: 'string' } } },
          }),
        },
        responses: { 201: jsonResponse('Created', CareRequest) },
      },
    },
    '/v1/careRequest/{id}': {
      get: {
        tags: ['Care'],
        summary: 'Poll a care request (plan appears once a reply is parsed)',
        parameters: [idParam()],
        responses: { 200: jsonResponse('OK', CareRequest), 404: errRes('NOT_FOUND') },
      },
    },
    '/v1/carePlan/{id}': {
      patch: {
        tags: ['Care'],
        summary: 'Approve or request clarification on a proposed plan',
        parameters: [idParam()],
        requestBody: { required: true, ...jsonBody({ type: 'object', required: ['action'], properties: { action: { type: 'string', enum: ['approve', 'clarify'] } } }) },
        responses: {
          200: jsonResponse('OK — approving opens a settlement line accrual', CareRequest),
          404: errRes('NOT_FOUND'),
          409: errRes('NO_PLAN_TO_APPROVE'),
        },
      },
    },

    '/v1/wallet/balance': {
      get: {
        tags: ['Payments'],
        summary: 'Real ERC20 balanceOf (JPYC on Fuji) — configured:false if chain not deployed yet',
        parameters: [{ name: 'address', in: 'query', schema: { type: 'string' }, description: 'defaults to the seeded Sakura wallet' }],
        responses: {
          200: jsonResponse('OK', {
            type: 'object',
            properties: { address: { type: 'string' }, balance: { type: 'number', nullable: true }, configured: { type: 'boolean' } },
          }),
        },
      },
    },
    '/v1/jpyc/transfer': {
      post: {
        tags: ['Payments'],
        summary: 'Execute a payout on-chain for a signed attestation',
        requestBody: jsonBody({
          type: 'object',
          properties: { attestationId: { type: 'string' }, toAddr: { type: 'string' }, incidentId: { type: 'string' }, parentId: { type: 'string' } },
        }),
        responses: {
          200: jsonResponse('paid (with txHash+explorerUrl), pending (>10s, resolve by polling), or DEMO_TX_LIMIT', {
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['paid', 'pending', 'DEMO_TX_LIMIT'] },
              txHash: { type: 'string' },
              explorerUrl: { type: 'string' },
            },
          }),
          400: errRes('RECIPIENT_MISMATCH'),
          403: errRes('ATTESTATION_REQUIRED — missing, unknown, or unsigned attestationId'),
          409: errRes('NONCE_ALREADY_USED | SIGNER_MISMATCH | COOLDOWN_EXCEEDED (mapped from the on-chain revert reason)'),
          503: errRes('CHAIN_NOT_CONFIGURED (no deployed contracts / signer)'),
        },
      },
    },
    '/v1/jpyc/batchTransfer': {
      post: {
        tags: ['Payments'],
        summary: 'Pay a settlement\'s PT-03 batch attestation. Server re-derives exclusions = disputed ∪ unattested — a client-supplied exclusion list is never trusted.',
        requestBody: { required: true, ...jsonBody({ type: 'object', required: ['settlementId'], properties: { settlementId: { type: 'string' }, parentId: { type: 'string' } } }) },
        responses: {
          200: jsonResponse('paid/pending/DEMO_TX_LIMIT, plus which lines were included/excluded', {
            type: 'object',
            properties: {
              status: { type: 'string' },
              txHash: { type: 'string' },
              explorerUrl: { type: 'string' },
              included: { type: 'array', items: { type: 'string' } },
              excluded: { type: 'array', items: { type: 'string' } },
            },
          }),
          400: errRes('NOTHING_TO_TRANSFER'),
          403: errRes('ATTESTATION_REQUIRED — run POST /v1/attestation/settlement/batch first'),
          503: errRes('CHAIN_NOT_CONFIGURED'),
        },
      },
    },
    '/v1/settlement/current': {
      get: {
        tags: ['Payments'],
        summary: 'Latest settlement period with real netting math',
        parameters: [parentIdParam],
        responses: { 200: jsonResponse('null if no settlement exists yet', Settlement) },
      },
    },
    '/v1/settlement/{id}/line/{lineId}': {
      patch: {
        tags: ['Payments'],
        summary: 'Flag/clear a dispute on one settlement line — persists, survives refresh',
        parameters: [idParam('id'), idParam('lineId')],
        requestBody: { required: true, ...jsonBody({ type: 'object', required: ['disputed'], properties: { disputed: { type: 'boolean' } } }) },
        responses: {
          200: jsonResponse('OK', { type: 'object', properties: { lineId: { type: 'string' }, disputed: { type: 'boolean' } } }),
          404: errRes('NOT_FOUND | LINE_NOT_FOUND'),
        },
      },
    },

    '/v1/attestation/trigger': {
      post: {
        tags: ['Attestation'],
        summary: 'Validate a parametric trigger (Protosure rater or local stub, per ATTESTATION_MODE) and REAL-LITE-sign the payload',
        requestBody: {
          required: true,
          ...jsonBody({
            type: 'object',
            required: ['policyId', 'triggerCode', 'recipient'],
            properties: {
              policyId: { type: 'string' },
              triggerCode: { type: 'string', enum: ['PT-01', 'PT-02', 'PT-03', 'PT-04'] },
              recipient: { type: 'string', description: '0x-prefixed EVM address' },
              parentId: { type: 'string' },
              incidentId: { type: 'string' },
              eventTimestamp: { type: 'integer' },
            },
          }),
        },
        responses: {
          201: jsonResponse('Signed attestation (payoutAmount is always the fixed schedule value, never client-supplied)', Attestation),
          422: errRes('RATER_AMOUNT_MISMATCH | POLICY_NOT_IN_FORCE | TRIGGER_NOT_CONFIGURED | COOLDOWN_EXCEEDED | RATER_UNAVAILABLE'),
          503: errRes('SIGNER_NOT_CONFIGURED'),
        },
      },
    },
    '/v1/attestation/{id}': {
      get: {
        tags: ['Attestation'],
        summary: 'Get an attestation (includes source + raterRef for judge transparency)',
        parameters: [idParam()],
        responses: { 200: jsonResponse('OK', Attestation), 404: errRes('NOT_FOUND') },
      },
    },
    '/v1/attestation/settlement/batch': {
      post: {
        tags: ['Attestation'],
        summary: 'Batch-attest a settlement (PT-03, fixed ¥20,000) and mark all non-disputed lines attested',
        requestBody: {
          required: true,
          ...jsonBody({ type: 'object', required: ['settlementId', 'recipient'], properties: { settlementId: { type: 'string' }, recipient: { type: 'string' }, parentId: { type: 'string' } } }),
        },
        responses: { 201: jsonResponse('Created', Attestation), 404: errRes('NOT_FOUND') },
      },
    },
    '/v1/attestation/signer/current': {
      get: {
        tags: ['Attestation'],
        summary: 'Current REAL-LITE signer address (pinnedSigner on-chain must match this)',
        responses: {
          200: jsonResponse('OK', {
            type: 'object',
            properties: { configured: { type: 'boolean' }, signerAddress: { type: 'string', nullable: true } },
          }),
        },
      },
    },

    '/v1/settings': {
      get: {
        tags: ['Settings'],
        summary: 'Get settings (chips, geo-fence, known safe places)',
        parameters: [parentIdParam],
        responses: { 200: jsonResponse('OK', Settings) },
      },
      patch: {
        tags: ['Settings'],
        summary: 'Update chips / known safe places (explicit prefs override agent)',
        requestBody: jsonBody({
          type: 'object',
          properties: {
            parentId: { type: 'string' },
            chips: Chips,
            knownSafePlaces: { type: 'array', items: KnownSafePlace },
          },
        }),
        responses: { 200: jsonResponse('OK', Settings) },
      },
    },
    '/v1/policy/monitoringConfig': {
      patch: {
        tags: ['Settings'],
        summary: 'Update geo-fence home/radius/monitoring (separate from /v1/settings for OpenAPI contract-compatibility)',
        requestBody: {
          required: true,
          ...jsonBody({
            type: 'object',
            required: ['homeLatLng', 'geofenceRadius', 'monitoringActive'],
            properties: {
              parentId: { type: 'string' },
              homeLatLng: { type: 'object', properties: { lat: { type: 'number' }, lng: { type: 'number' } } },
              geofenceRadius: { type: 'integer', minimum: 100, maximum: 2000 },
              monitoringActive: { type: 'boolean' },
            },
          }),
        },
        responses: { 200: jsonResponse('OK', Settings), 409: errRes('PAIRING_REQUIRED') },
      },
    },

    '/v1/demo/reset': {
      post: {
        tags: ['Demo'],
        summary: 'Wipe + reseed all demo data (never touches wallets/chain state)',
        security: [],
        responses: { 200: jsonResponse('OK', { type: 'object', properties: { ok: { type: 'boolean' }, resetAt: { type: 'integer' } } }) },
      },
    },
    '/v1/demo/status': {
      get: {
        tags: ['Demo'],
        summary: 'Public summary for the Judge Console (active incidents, latest payout)',
        security: [],
        parameters: [parentIdParam],
        responses: {
          200: jsonResponse('OK', {
            type: 'object',
            properties: {
              parentId: { type: 'string' },
              activeIncidents: { type: 'integer' },
              latestPayout: { type: 'object', nullable: true, properties: { title: { type: 'string' }, deepLink: { type: 'string' }, ts: { type: 'integer' } } },
            },
          }),
        },
      },
    },
    '/v1/demo/scenario/{name}': {
      post: {
        tags: ['Demo'],
        summary: 'Trigger a scripted demo scenario',
        security: [],
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string', enum: ['wandering', 'false-alarm', 'care-reply'] } }],
        requestBody: jsonBody({ type: 'object', properties: { parentId: { type: 'string' }, careRequestId: { type: 'string' } } }),
        responses: { 200: jsonResponse('OK', { type: 'object' }), 404: errRes('UNKNOWN_SCENARIO | NO_PENDING_CARE_REQUEST') },
      },
    },
  },
};
