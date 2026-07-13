# How this plugin lines up with Murphy (1993), "What Is a Good Forecast?"

Reference: Allan H. Murphy, 1993, *What Is a Good Forecast? An Essay on the Nature
of Goodness in Weather Forecasting*, **Weather and Forecasting 8, 281–293**
(AMS). PDF kept locally in `docs/references/` (git-ignored — copyrighted).

This is the canonical paper on forecast "goodness." It's directly relevant: our
plugin is a forecast-verification tool, and this note records where our design
agrees with Murphy's framework and where it doesn't.

## Murphy's framework in one paragraph

Murphy separates three kinds of "good":

- **Type 1 — Consistency**: the forecast matches the forecaster's own judgment.
- **Type 2 — Quality**: the forecast matches the observations. This is
  *verification*, and Murphy stresses it is **multifaceted** — Table 2 lists nine
  aspects: bias, association, accuracy, skill, reliability, resolution,
  sharpness, discrimination, uncertainty.
- **Type 3 — Value**: the incremental benefit to a decision-maker who *uses* the
  forecast.

Three theses matter for us: (1) quality is multifaceted, so a single overall
score can't capture it; (2) a better score does **not** guarantee a forecast set
is better "in all respects," nor of greater value to all users, unless a strict
statistical condition (the *sufficiency relation*) holds; (3) quality is only a
valid surrogate for value when its multifaceted nature is respected — the
quality→value link is nonlinear and can be non-monotonic.

## Where we align — well

| Murphy aspect (Type 2) | What we do | Fit |
| :--- | :--- | :--- |
| **Accuracy** (avg correspondence of forecast/obs pairs) | `dirMAE`, `Score`, `vectorRMSE` | direct |
| **Skill** (accuracy relative to a reference) | `skill = 1 − MAE/MAE(persistence)` | direct — persistence is a legitimate low-skill reference; our "beats 'no change'" line is exactly Murphy's skill |
| **Bias** (mean forecast vs mean obs) | `dirBias`, surfaced as the correction to apply | direct — Murphy names systematic characteristics like bias as precisely what helps identify a model's strengths/weaknesses |
| **Discrimination** (do different outcomes get different forecasts) | shift catch-rate — recall/precision of ≥20° change events | partial/analogous — event-based, deterministic version |

Beyond the individual aspects, three bigger things line up:

1. **Stratified verification.** We verify per station, per lead-time bucket, per
   model. Murphy's conclusion explicitly praises exactly this — conditional
   breakdowns are how a forecaster "identifies specific strengths and weaknesses"
   and drives model refinement. Our board is built that way.
2. **We already respect "one number isn't enough."** The recalibrated webapp
   ranks by one Score but deliberately shows several facets in plain language
   (average error, bias, shift-catch, skill-crossover) and *warns* when the
   score-winner isn't the shift-catch winner. That is Murphy's central caution
   made concrete.
3. **We reach toward Value (Type 3).** Most verification tools stop at quality.
   We frame an actual decision — "use this model, apply this bias correction, and
   note who catches the shifts if the race hinges on them." That's a Type-3,
   decision-oriented move, which Murphy treats as the ultimate point.

## Where we diverge — and what's a real gap vs. what simply doesn't apply

1. **Single headline rank (real, mitigated).** Murphy: the better-scored set is
   not guaranteed superior in all respects or more valuable to all users unless
   the sufficiency relation holds. We present one ranked list. We mitigate by
   exposing multiple facets and the shift caveat, but we don't formally test
   sufficiency, and the word "recommended" implies a universality Murphy says is
   decision-dependent. Honest framing (which we have) is the right response.
2. **Quality used as a surrogate for value (real).** We rank on accuracy/catch
   and call the winner the one to "choose to win." Murphy warns accuracy gains
   don't always mean better decisions. For racing, value depends on the tactical
   decision (which way to go), the payoff (places gained/lost), and what you'd do
   with no forecast. A slightly less accurate model that nails the one big left
   shift can be worth more — which is exactly why the catch-rate + "if the race
   hinges on shifts" caveat earns its place. Directionally right; not yet true
   decision-analytic value.
3. **Distributional aspects we omit — mostly N/A.** Reliability, resolution,
   sharpness and uncertainty are defined over *probability* distributions
   (`p(f)`, `p(x|f)`). Our forecasts are single deterministic wind values, so
   these don't directly apply. They would become relevant — and worth adding — if
   we ingest **ensemble/probabilistic** wind (Open-Meteo offers ensemble APIs).
4. **Association not computed (minor).** We don't report a correlation of paired
   forecast/observed; cheap to add.
5. **Type 1 Consistency — N/A.** Our "forecasters" are NWP models via an API;
   there is no separate human judgment for the forecast to be consistent with.
6. **Measures- vs distributions-oriented.** Murphy favours the
   distributions-oriented view (examine the full joint `p(f,x)`). We are
   measures-oriented (MAE/skill/catch). That critique bites hardest for
   probabilistic forecasts; for a single deterministic variable and a sailor's
   needs, measures are appropriate — but a scatter / conditional-mean view
   (forecast vs observed by wind sector) would be a cheap, Murphy-aligned add.

## Verdict

Strongly aligned in spirit and in specifics. We implement Murphy's accuracy,
skill-vs-reference, and bias aspects directly; we stratify verification the way
his conclusion recommends; and — most importantly — the redesigned board already
embodies his core message that **no single score is the whole story**. The honest
gaps are the natural frontier, not mistakes: (a) a single "recommended" rank that
can't be universally best, (b) quality used as a proxy for value without
decision-analytic scoring, and (c) omitted distributional aspects that only
become meaningful with probabilistic forecasts.

## Murphy-inspired next steps (optional)

- **Scatter / conditional-mean panel** (forecast vs observed direction, by wind
  sector) — distributions-oriented, exposes bias-by-regime cheaply.
- **Add `association`** (correlation) to the per-bucket metrics.
- **If ensemble/probabilistic wind is added:** reliability diagram + sharpness +
  a proper probabilistic score (Brier/CRPS) — turns Score into a real
  probabilistic-quality suite.
- **Toward true value:** translate bias + shift-catch into a racing payoff
  ("expected boat-lengths on a beat" / cost–loss framing) — the Type-3 number a
  racer actually optimises.
- **Keep the "one number isn't the whole story" framing** — it is Murphy's thesis
  and our main point of alignment.
