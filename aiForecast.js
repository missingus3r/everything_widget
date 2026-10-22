// Weekly quota forecasting. Percentages are provider quota usage, not token counts.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AIUsageForecast = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const HOUR = 3600000;
  const DAY = 24 * HOUR;
  const WEEK = 7 * DAY;
  const MAX_SAMPLES = 2048;
  const RESET_TOLERANCE = 60000;
  const MIN_RECENT_SPAN = HOUR / 2;

  function validSample(s) {
    return !!s && Number.isFinite(s.at) && Number.isFinite(s.resetAt)
      && Number.isFinite(s.pct) && s.pct >= 0 && s.pct <= 100
      && s.resetAt > s.at && s.resetAt - s.at <= WEEK + RESET_TOLERANCE;
  }

  // Treat reset changes and quota decreases as a new series. Never infer a
  // negative rate or join observations from different weekly allowances.
  function normalize(history) {
    const samples = (Array.isArray(history) ? history : [])
      .filter(validSample).sort((a, b) => a.at - b.at).slice(-MAX_SAMPLES);
    let result = [];
    for (const s of samples) {
      const last = result[result.length - 1];
      if (last && (Math.abs(s.resetAt - last.resetAt) > RESET_TOLERANCE || s.pct < last.pct)) result = [];
      if (result.length && s.at === result[result.length - 1].at) result.pop();
      result.push({ at: s.at, pct: s.pct, resetAt: s.resetAt });
    }
    return result;
  }

  function recordSample(history, sample) {
    const previous = normalize(history);
    if (!validSample(sample)) return previous;
    const last = previous[previous.length - 1];
    if (last && sample.at < last.at) return previous;
    return normalize([...previous, sample]);
  }

  function project(history, now = Date.now(), options = {}) {
    const samples = normalize(history);
    const last = samples[samples.length - 1];
    if (!last) return { status: 'unavailable' };
    const { at, pct, resetAt } = last;
    const base = { at, pct, resetAt, remainingMs: Math.max(0, resetAt - now) };
    if (!Number.isFinite(now) || now < at) return { ...base, status: 'unavailable' };
    if (now >= resetAt) return { ...base, status: 'resetting' };
    const maxAgeMs = options.maxAgeMs ?? HOUR / 2;
    if (options.available === false || now - at > maxAgeMs) return { ...base, status: 'stale' };
    if (pct >= 100) return { ...base, status: 'exhausted', projectedPct: 100 };

    // Use observed changes over at most 24 hours (including idle time).
    // Until there is enough history, show the explicit whole-week average.
    const first = samples.find(s => s.at >= at - DAY);
    const recentHours = (at - first.at) / HOUR;
    const weekHours = (at - (resetAt - WEEK)) / HOUR;
    let ratePerHour, basis, observedHours;
    if (at - first.at >= MIN_RECENT_SPAN) {
      ratePerHour = (pct - first.pct) / recentHours;
      basis = 'recent';
      observedHours = recentHours;
    } else if (weekHours >= 1) {
      ratePerHour = pct / weekHours;
      basis = 'week';
      observedHours = weekHours;
    } else {
      return { ...base, status: 'learning' };
    }

    // Anchor the rate and projection to the last real reading. Ticking the UI
    // or a failed fetch must not dilute the rate or fabricate fresh samples.
    const hoursToReset = (resetAt - at) / HOUR;
    const projectedPct = pct + ratePerHour * hoursToReset;
    const budgetPerDay = (100 - pct) / hoursToReset * 24;
    const exhaustionAt = ratePerHour > 0 ? at + (100 - pct) / ratePerHour * HOUR : null;
    const overBudget = projectedPct > 100 + 1e-8;
    return {
      ...base,
      status: overBudget ? 'risk' : projectedPct >= 90 ? 'tight' : 'safe',
      basis, observedHours, projectedPct, ratePerDay: ratePerHour * 24, budgetPerDay,
      exhaustionAt,
      reductionPct: overBudget ? Math.ceil((1 - budgetPerDay / (ratePerHour * 24)) * 100) : 0,
    };
  }

  return { HOUR, DAY, WEEK, MAX_SAMPLES, normalize, recordSample, project };
});
