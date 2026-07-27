// Applied identically to every activation credential in both ACTIVATION_MODE=stub and
// ACTIVATION_MODE=protosure, before comparison or upstream call — a mode that normalises more
// permissively than the other would make the two behave differently for the same input, which is
// exactly the kind of drift this module exists to prevent.

export class NormalisationError extends Error {
  constructor(field) {
    super(`invalid ${field}`);
    this.code = 'NORMALISATION_ERROR';
    this.field = field;
  }
}

// E.164. Strips spaces/hyphens/parentheses; a leading 0 (JP local format) becomes +81 + remainder.
// Anything that doesn't resolve to a plausible E.164 number is rejected rather than guessed.
export function normalisePhone(raw) {
  if (typeof raw !== 'string') throw new NormalisationError('phone');
  let s = raw.trim().replace(/[\s\-()]/g, '');
  if (s.startsWith('0')) {
    s = `+81${s.slice(1)}`;
  }
  if (!/^\+[1-9]\d{7,14}$/.test(s)) {
    throw new NormalisationError('phone');
  }
  return s;
}

export function normaliseEmail(raw) {
  if (typeof raw !== 'string') throw new NormalisationError('email');
  const s = raw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) {
    throw new NormalisationError('email');
  }
  return s;
}

// Strict YYYY-MM-DD — reject other formats rather than guessing at intent.
export function normaliseDob(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new NormalisationError('insuredDob');
  }
  const [y, m, d] = raw.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    throw new NormalisationError('insuredDob');
  }
  return raw;
}

export function normalisePolicyNumber(raw) {
  if (typeof raw !== 'string') throw new NormalisationError('policyNumber');
  const s = raw.trim().toUpperCase().replace(/\s+/g, ' ');
  if (!s) throw new NormalisationError('policyNumber');
  return s;
}

export function normaliseCredentials({ policyNumber, insuredDob, phone, email }) {
  return {
    policyNumber: normalisePolicyNumber(policyNumber),
    insuredDob: normaliseDob(insuredDob),
    phone: normalisePhone(phone),
    email: normaliseEmail(email),
  };
}
