import test from 'node:test';
import assert from 'node:assert/strict';
import { computeNetCredit } from '../src/routes/payments.js';

function randomLine(i) {
  const type = Math.random() < 0.8 ? 'visit' : 'reward';
  return {
    lineId: `L${i}`,
    type,
    amount: Math.floor(Math.random() * 10) * 1000,
    attested: Math.random() < 0.6,
    disputed: Math.random() < 0.3,
  };
}

test('netting property: netCredit always equals the manual sum of eligible visit lines', () => {
  for (let trial = 0; trial < 50; trial++) {
    const n = Math.floor(Math.random() * 8);
    const lines = Array.from({ length: n }, (_, i) => randomLine(i));
    const expected = lines
      .filter((l) => l.type === 'visit' && l.attested === true && l.disputed === false)
      .reduce((sum, l) => sum + l.amount, 0);
    assert.equal(computeNetCredit(lines), expected);
  }
});

test('netting excludes disputed lines even if attested', () => {
  const lines = [{ lineId: 'A', type: 'visit', amount: 3000, attested: true, disputed: true }];
  assert.equal(computeNetCredit(lines), 0);
});

test('netting excludes unattested lines', () => {
  const lines = [{ lineId: 'A', type: 'visit', amount: 3000, attested: false, disputed: false }];
  assert.equal(computeNetCredit(lines), 0);
});

test('netting excludes reward-type lines even when attested and undisputed', () => {
  const lines = [{ lineId: 'A', type: 'reward', amount: 3000, attested: true, disputed: false }];
  assert.equal(computeNetCredit(lines), 0);
});

test('netting is order-independent and additive', () => {
  const lines = [
    { lineId: 'A', type: 'visit', amount: 3000, attested: true, disputed: false },
    { lineId: 'B', type: 'visit', amount: 2000, attested: true, disputed: false },
  ];
  assert.equal(computeNetCredit(lines), 5000);
  assert.equal(computeNetCredit([...lines].reverse()), 5000);
});
