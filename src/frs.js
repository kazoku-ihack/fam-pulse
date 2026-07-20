// Pure FRS (Family Reassurance Score) math — no I/O, unit-testable in isolation.

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

function median(values) {
  if (!values || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Full credit inside [lo, hi]; falls off linearly to 0 over `falloffRange` beyond the band edge.
function bandScore(value, lo, hi, weight, falloffRange) {
  if (value === null || value === undefined) return 0;
  let distance = 0;
  if (value < lo) distance = lo - value;
  else if (value > hi) distance = value - hi;
  const penalty = clamp(distance / falloffRange, 0, 1);
  return weight * (1 - penalty);
}

export function computeFactors({ dailySteps, sleepHours, heartRateResting, historySteps = [] }) {
  const mobility = clamp((dailySteps ?? 0) / 4000, 0, 1) * 30;
  const vitals = bandScore(heartRateResting, 55, 75, 30, 30);
  const sleep = bandScore(sleepHours, 6.5, 8.5, 20, 3);
  const med = median(historySteps);
  const routine = med > 0 ? clamp((dailySteps ?? 0) / med, 0, 1) * 20 : 20;
  return {
    mobility: Math.round(mobility * 100) / 100,
    vitals: Math.round(vitals * 100) / 100,
    sleep: Math.round(sleep * 100) / 100,
    routine: Math.round(routine * 100) / 100,
  };
}

export function classifyScore(score) {
  if (score >= 70) return { emoticon: 'happy', statusText: 'Feeling good' };
  if (score >= 60) return { emoticon: 'neutral', statusText: 'Doing okay' };
  return { emoticon: 'concerned', statusText: "Let's take care today" };
}

// today: {dailySteps, sleepHours, heartRateResting} | null (null => no row for the date)
// historySteps: array of dailySteps for prior days, used for the routine factor's median
export function computeFRS({ today, historySteps = [] }) {
  if (!today) {
    return {
      score: 0,
      statusText: 'Please wear your watch',
      emoticon: 'concerned',
      factors: { mobility: 0, vitals: 0, sleep: 0, routine: 0 },
      dataSufficient: false,
    };
  }
  const factors = computeFactors({ ...today, historySteps });
  const score = Math.round(factors.mobility + factors.vitals + factors.sleep + factors.routine);
  const { emoticon, statusText } = classifyScore(score);
  return { score, statusText, emoticon, factors, dataSufficient: true };
}
