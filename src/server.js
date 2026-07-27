import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import swaggerUiDist from 'swagger-ui-dist';

import { openDb, seedIfEmpty, resetDb } from './db.js';
import { apiKeyAuth, judgeKeyAuth, requireDevice } from './auth.js';
import { activationRouter, reconcileHousehold } from './routes/activation.js';
import { healthkitRouter } from './routes/healthkit.js';
import { frsRouter } from './routes/frs.js';
import { incidentsRouter, startGeofenceTick } from './routes/incidents.js';
import { telemetryRouter } from './routes/telemetry.js';
import { parentRouter } from './routes/parent.js';
import { eventsRouter } from './routes/events.js';
import { dispatchRouter, uberWebhookRouter } from './routes/dispatch.js';
import { careRouter } from './routes/care.js';
import { paymentsRouter } from './routes/payments.js';
import { attestationRouter } from './routes/attestation.js';
import { settingsRouter } from './routes/settings.js';
import { demoRouter } from './routes/demo.js';
import { API_INDEX, apiIndexHtml, swaggerDocsHtml } from './apiIndex.js';
import { openApiSpec } from './openapi.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp(db, deps = {}) {
  const app = express();
  app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
  app.use(
    express.json({
      limit: '256kb',
      verify: (req, res, buf) => {
        req.rawBody = buf;
      },
    })
  );
  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      limit: parseInt(process.env.RATE_LIMIT_PER_MIN, 10) || 120,
      standardHeaders: true,
      legacyHeaders: false,
    })
  );

  app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));
  app.get('/', (req, res) => {
    if (req.accepts(['json', 'html']) === 'html') {
      res.type('html').send(apiIndexHtml());
    } else {
      res.json(API_INDEX);
    }
  });
  // `index: 'judge.html'` so the bare /judge URL (what people actually type/click) resolves —
  // express.static's default index.html lookup would otherwise 404 past this point and fall
  // through into apiKeyAuth below, returning a bare {"error":"UNAUTHORIZED"} for a page that's
  // meant to be public.
  app.use('/judge', express.static(path.join(__dirname, '..', 'public'), { index: 'judge.html' }));

  app.get('/openapi.json', (req, res) => res.json(openApiSpec));
  app.get('/docs', (req, res) => res.type('html').send(swaggerDocsHtml()));
  // Self-hosted Swagger UI assets (no CDN dependency — works even if a venue blocks it mid-demo).
  app.use('/docs', express.static(swaggerUiDist.absolutePath()));

  // Provider webhook: authenticated by HMAC signature, not x-api-key (a real Uber callback
  // would never carry our internal API key) — must be mounted before apiKeyAuth.
  app.use(uberWebhookRouter(db));

  // Judge Console actions: the console is a plain static page with no server-side secret
  // holder, so it can't carry x-api-key (which must never reach a browser, per the security
  // floor). Gated instead by the optional JUDGE_KEY, enforced only if that env var is set.
  app.use(judgeKeyAuth, demoRouter(db, deps.demo));

  app.use(apiKeyAuth);
  // Additive on top of apiKeyAuth — resolves an optional device token into req.household so
  // routes can be household-scoped/role-gated; a request with no token behaves exactly as before.
  app.use(requireDevice(db));

  app.use(activationRouter(db));
  app.use(healthkitRouter(db));
  app.use(frsRouter(db));
  app.use(incidentsRouter(db));
  app.use(telemetryRouter(db));
  app.use(parentRouter(db));
  app.use(eventsRouter(db));
  app.use(dispatchRouter(db));
  app.use(careRouter(db, deps.care));
  app.use(paymentsRouter(db, deps.payments));
  app.use(attestationRouter(db, deps.attestation));
  app.use(settingsRouter(db));

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = openDb();
  if (process.env.SEED_ON_BOOT === '1') {
    resetDb(db);
  } else {
    seedIfEmpty(db);
  }
  const app = createApp(db);
  const port = parseInt(process.env.PORT, 10) || 3000;
  app.listen(port, () => {
    console.log(`kazoku-demo listening on :${port}`);
  });

  if (parseInt(process.env.AUTO_RESET_MINUTES, 10) > 0) {
    const ms = parseInt(process.env.AUTO_RESET_MINUTES, 10) * 60 * 1000;
    setInterval(() => {
      console.log('auto-reset: reseeding demo data');
      resetDb(db);
    }, ms).unref();
  }

  if (process.env.ACTIVATION_MODE === 'protosure') {
    setInterval(() => {
      const households = db.prepare('SELECT householdId FROM households').all();
      for (const { householdId } of households) {
        reconcileHousehold(db, householdId).catch((e) => console.error('reconcile error', e));
      }
    }, 60 * 60 * 1000).unref();
  }

  startGeofenceTick(db);
}
