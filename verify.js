// Pure math for circular quantities and (in M2) forecast verification.
// No I/O in this module — everything here is unit-testable in isolation.

function normalize(diff) {
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  return diff;
}

function normalize2pi(angle) {
  return ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
}

function circularMeanFromSums(sumSin, sumCos) {
  return normalize2pi(Math.atan2(sumSin, sumCos));
}

module.exports = { normalize, normalize2pi, circularMeanFromSums };
