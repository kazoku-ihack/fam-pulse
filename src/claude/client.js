// Shared Anthropic client wrapper: logs {purpose, promptHash, ms}, enforces a JSON schema
// via zod with one retry on parse failure, and times out fail-safe.
//
// Claude output never gates a payout: the attestation/payment code path (src/routes/payments.js,
// src/routes/attestation.js, src/protosure/*, src/chain/*) imports nothing from src/claude/*.

import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-sonnet-4-6';
// Both callers ask for a ~4-field JSON object with a one/two-sentence reasoning string — capped
// low so an unbounded generation (e.g. a model ignoring the "no prose" instruction) can't run
// long enough to blow through DEFAULT_TIMEOUT_MS.
const MAX_TOKENS = 300;
const DEFAULT_TIMEOUT_MS = 9000;

// An explicit per-call apiKey (see claude/pendingKey.js) always wins over the env var, and is
// never cached on the shared client — each caller-supplied key gets its own short-lived client
// instance so keys from different callers can never cross.
let sharedClient = null;
function getClient(apiKey) {
  if (apiKey) return new Anthropic({ apiKey });
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!sharedClient) sharedClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return sharedClient;
}

function promptHash(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('CLAUDE_TIMEOUT')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) throw new Error('NO_JSON_FOUND');
  return JSON.parse(text.slice(start, end + 1));
}

// callFn(client) => Promise<string raw text>. Lets callers own their own prompt construction
// while sharing logging/timeout/retry/validation plumbing.
async function callRaw({ purpose, system, prompt, timeoutMs, apiKey }) {
  const client = getClient(apiKey);
  const started = Date.now();
  if (!client) {
    const err = new Error('CLAUDE_UNAVAILABLE');
    err.code = 'CLAUDE_UNAVAILABLE';
    throw err;
  }
  try {
    const resp = await withTimeout(
      client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system,
        messages: [{ role: 'user', content: prompt }],
      }),
      timeoutMs
    );
    const text = resp.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    console.log(
      JSON.stringify({ claudeCall: true, purpose, promptHash: promptHash(prompt), ms: Date.now() - started })
    );
    return text;
  } catch (e) {
    console.log(
      JSON.stringify({
        claudeCall: true,
        purpose,
        promptHash: promptHash(prompt),
        ms: Date.now() - started,
        error: e.message,
      })
    );
    throw e;
  }
}

// Calls Claude, parses+validates JSON against a zod schema, retries once on schema/parse
// failure. Throws on unrecoverable failure (timeout, no API key, two bad parses) — callers
// are responsible for the fail-safe fallback per their own guardrails.
export async function callClaudeJson({ purpose, system, prompt, schema, timeoutMs = DEFAULT_TIMEOUT_MS, apiKey }) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await callRaw({ purpose, system, prompt, timeoutMs, apiKey });
      const json = extractJson(text);
      return schema.parse(json);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

export function isClaudeConfigured(apiKey) {
  return Boolean(apiKey || process.env.ANTHROPIC_API_KEY);
}

// Test-only hook: lets tests substitute a fake implementation of callClaudeJson without
// touching the network or requiring an API key.
export const _testing = { callRaw, extractJson, promptHash };
