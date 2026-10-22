# Dodona pricing, method v0 (`black76-asian-v0`)

This is how the demo prices a price cap (a call), a price floor (a put) and a fixed-price lock on a block of GPU-hours. It is a demo method, not an offer or advice. The code is `lib/pricing.mjs`; every function is pure for given inputs, price history and clock.

## In plain words

A cap lets a business pay the market rate for a block of GPU-hours, but never more than the cap price. The fee for that right depends on three things: where the price is expected to be during the window (the forward), how much it moves (volatility), and how far away and how long the window is. A floor is the mirror image for a provider. A lock fixes the price outright, so it has no fee; the provider's 2% margin over the forward is built into the price.

## Inputs

- **GPU, count, window.** GPU is one of the series in the Ornn daily index. Count is 1, 2, 4, 8, 16, 32, 64, 128 or 256 GPUs; larger blocks go through a quote request. The window is two ISO date-times (UTC or with an offset). GPU-hours = count × window hours.
- **Spot S0.** The latest point of the index series.
- **Volatility σ and drift μ.** Taken from `marketStats` in `lib/valuation.mjs`, so a quote and a Dodona Value agree. σ is the sample standard deviation of weekly log returns (every 7th point back from the latest) × √52, falling back to daily × √365 below 8 weekly points. μ = clamp(mean daily log return × 365, ±30%) / 2.
- **Rate.** r = 5% a year, continuously compounded. A year is 365 days.
- **Region and configuration.** Validated against the valuation's factors (US East, US West, Europe; SXM-IB, PCIe) and recorded on the quote. v0 does not apply the basis to the premium.

## Formulas

Times are in years from now: t_start to the window start, t_end to the window end, t_mid = (t_start + t_end) / 2.

1. **Forward.** F = S0 · e^(μ · t_mid).
2. **Average-price adjustment.** The holder pays the average rate over the window, which moves less than the rate on its last day. v0 uses t_eff = t_start + (t_end − t_start) / 3, floored at one week (1/52).
3. **Black-76 call.** d1 = [ln(F/K) + σ² · t_eff / 2] / (σ · √t_eff), d2 = d1 − σ · √t_eff, C = e^(−r · t_end) · [F · N(d1) − K · N(d2)].
4. **Put by parity.** P = C − e^(−r · t_end) · (F − K).
5. **N(x).** Abramowitz and Stegun 7.1.26 for erf, N(x) = ½ [1 + erf(x/√2)]. The erf error is at most 1.5 × 10⁻⁷, so N is within 7.5 × 10⁻⁸.
6. **Fee per GPU-hour.** The option value, rounded up to the next cent, with a $0.01 floor.
7. **Lock.** Fixed price = F × 1.02, rounded to the cent. Fee 0.

Check value: F = K = $2.80, σ = 40%, t_eff = t_end = 1/12 gives C ≈ $0.128 per GPU-hour ($0.129 before discounting), quoted as $0.13.

## What the quote shows

| Field | Meaning |
|---|---|
| `premiumPerGpuHour`, `premiumTotal` | The fee, per GPU-hour and for the block |
| `platformFee` | 15% of `premiumTotal`, shown as "of which Dodona fee" |
| `bookingFee` | $2.00 per booking |
| `payNow` | `premiumTotal` + booking fee |
| `costIfUsed` | Strike × GPU-hours (lock: fixed price × GPU-hours; floor: the floor revenue) |
| `breakEven` | Call: strike + fee ("pays off above"). Put: strike − fee. Lock: none |
| `forward`, `spot`, `vol`, `volSampling`, `tYears`, `tEffYears`, `asOf`, `inputs` | Everything needed to reproduce the number |

`GET /api/quote` returns this object with `Cache-Control: no-store`, or `400 { error }` for invalid input. A call or put without a strike is struck at the forward rounded to $0.05. The MCP tool `quote_cap` returns the same object plus a plain-words summary.

## Limits

- Start at least 48 hours ahead and at most 12 months ahead. End after start. Window at least 4 hours. Strike above $0 and at most $1,000.
- Index data is the Ornn daily index, used for demonstration only and not licensed for commercial valuation.

## What v0 ignores

- **Skew and smile.** One volatility for every strike; real cap markets price spikes higher.
- **Mean reversion.** σ√t grows without bound, while the daily index tends to revert. Weekly sampling only partly corrects for this.
- **Provider credit.** The premium assumes the backing neocloud delivers. The valuation applies a bond-implied hazard; pricing v0 does not.
- **Basis.** Region and configuration factors are not applied to F; the quote is on the headline index.
- **Term structure, seasonality and liquidity.** The forward is one halved, clamped drift; there is no event calendar and no size discount.
- **The exact Asian formula.** The t/3 rule is an approximation for an arithmetic average with uniform sampling.
