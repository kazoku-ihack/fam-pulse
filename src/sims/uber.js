// Provider simulator: driver lifecycle -> signed webhooks POSTed to our own
// /v1/webhooks/uber. The webhook handler (routes/dispatch.js) is real code — HMAC-verified,
// state-machine-enforced — only the "provider" on the other end is simulated.

import crypto from 'node:crypto';

const DRIVER = { name: 'Kenji T.', rating: 4.9, vehicle: 'トヨタ プリウス', plate: '秋田 500 A 12-34' };
const DRIVER_WALLET = '0x' + crypto.randomBytes(20).toString('hex');

const timers = new Map(); // dispatchId -> timeout handles

function getTimescale() {
  return parseFloat(process.env.DEMO_TIMESCALE) || 1;
}

function scaledMs(realSeconds) {
  return (realSeconds * 1000) / getTimescale();
}

export function signPayload(secret, bodyStr) {
  return crypto.createHmac('sha256', secret).update(bodyStr).digest('hex');
}

async function postWebhook(baseUrl, secret, payload) {
  const body = JSON.stringify(payload);
  const signature = signPayload(secret, body);
  try {
    await fetch(`${baseUrl}/v1/webhooks/uber`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-uber-signature': signature },
      body,
    });
  } catch (e) {
    console.error('uber sim webhook post failed', e.message);
  }
}

export function driverInfo() {
  return { ...DRIVER, driverWalletAddr: DRIVER_WALLET };
}

function statusLocation(status, pickup, dropoff) {
  const t = { requested: 0, accepted: 0.1, en_route: 0.4, arrived: 0.9, completed: 1 }[status] ?? 0;
  return {
    lat: pickup.lat + (dropoff.lat - pickup.lat) * t,
    lng: pickup.lng + (dropoff.lng - pickup.lng) * t,
  };
}

function statusEta(status) {
  return { requested: 8, accepted: 6, en_route: 4, arrived: 1, completed: 0 }[status] ?? null;
}

export function routePolyline(pickup, dropoff) {
  const pts = [];
  for (let i = 0; i <= 4; i++) {
    const t = i / 4;
    pts.push([pickup.lat + (dropoff.lat - pickup.lat) * t, pickup.lng + (dropoff.lng - pickup.lng) * t]);
  }
  return pts;
}

// SIM_FAIL_DISPATCH=1 forces the timeout path: driver accepts, then never advances beyond
// accepted, for rehearsing the escalation banner.
export function startDispatchSimulation({ dispatchId, incidentId, baseUrl, secret, pickup, dropoff }) {
  const failMode = process.env.SIM_FAIL_DISPATCH === '1';
  const handles = [];
  const schedule = (realSeconds, status) => {
    const h = setTimeout(() => {
      postWebhook(baseUrl, secret, {
        dispatchId,
        incidentId,
        status,
        driverLocation: statusLocation(status, pickup, dropoff),
        etaMin: statusEta(status),
        ts: Date.now(),
      });
    }, scaledMs(realSeconds));
    h.unref?.();
    handles.push(h);
  };

  schedule(3, 'accepted');
  if (!failMode) {
    schedule(6, 'en_route');
    schedule(15, 'arrived');
    schedule(20, 'completed');
  }
  timers.set(dispatchId, handles);
}

export function cancelDispatchSimulation(dispatchId) {
  const handles = timers.get(dispatchId);
  if (handles) {
    for (const h of handles) clearTimeout(h);
    timers.delete(dispatchId);
  }
}
