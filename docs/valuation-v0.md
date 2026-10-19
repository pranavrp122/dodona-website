# Dodona Value, method v0.1-test

This is a test method for a demo. It is a valuation and analytics output, not a credit rating and not advice. It is impersonal: every viewer sees the same number for the same inputs. The code is `lib/valuation.mjs`. Every function is pure and deterministic for given inputs and a given valuation date.

## Inputs

A contract has a GPU type, a GPU count, a contract price per GPU-hour (K), a start and an end date, a region, a hardware configuration, a provider and a term type. Dates are UTC days. The end date is exclusive, so a contract for March through August 2027 runs from 2027-03-01 to 2027-09-01.

- **Region** is US East, US West or Europe.
- **Configuration** is SXM-IB or PCIe.
- **Provider** carries a label, a credit tier and the price of its bonds in cents.
- **Term type** is take-or-pay or usage-with-cancel.

Prices come from the Ornn daily GPU rental index, about 92 daily points per GPU. The server caches them for an hour. It falls back to a saved copy in `data/ornn-index.json` when the live feed is unavailable.

## Steps

1. **Market.** Spot S0 is the latest index value. Daily log returns are r_i = ln(P_i / P_(i-1)). Volatility is σ = stdev(r) × √365, using the sample standard deviation. Drift is μ = clamp(mean(r) × 365, ±30 %) / 2. We clamp and halve it because 90 days of drift is weak evidence.
2. **Forward curve.** F(t) = S0 · e^(μt), where t is in years from the valuation date and a year is 365 days. An optional per-month market-implied settle, such as a Kalshi price, is blended 50/50 with F(t) when supplied. The demo does not supply one.
3. **Basis.** The multiplier is b = region × configuration. The region factor is 1.00 for US East, 1.00 for US West and 1.04 for Europe. The configuration factor is 1.00 for SXM-IB and 0.85 for PCIe. The market price for this exact contract is F(t)·b.
4. **Remaining hours.** The remaining window [max(today, start), end) is cut at UTC month boundaries. Each slice m has H_m = count × hours in the slice and a tenor t_m measured to the slice's midpoint. The remaining cost is C = Σ H_m · K.
5. **Provider credit.** The spread is s = (100 − bond price in cents) / 100 × 0.5 per year, so a 78c bond gives 11 % a year and a 100c bond gives 0. The hazard is h = s / (1 − 0.4), assuming 40 % recovery. Survival to slice m is Q_m = e^(−h·t_m). Buyer credit is ignored in v0.
6. **Discounting.** D_m = e^(−r·t_m), with r = 5 %.
7. **Value.** V = Σ_m H_m · (F(t_m)·b − K) · D_m · Q_m. For usage-with-cancel, each monthly term is floored at zero, because the holder walks away when the market is below K: V = Σ_m H_m · max(F(t_m)·b − K, 0) · D_m · Q_m.
8. **Range.** Low and high recompute V with F scaled by e^(∓σ√t_mid). Here t_mid is the midpoint tenor of the remaining window, halfway between the remaining start and the end.
9. **Cents on the dollar.** This is (C + V) / C × 100. It shows what the remaining commitment is worth per dollar still owed. Above 100 means the locked price beats the market. It is blank when no hours remain.
10. **History.** The chart repeats the value for each of the last 90 index dates. On each date it uses that day's index as S0 and that day as the valuation date, so remaining hours shrink over time. It holds σ and μ at today's trailing-window values.

The forward average shown on a contract page is the hour-weighted mean of F(t_m)·b over the remaining slices. The price gap is that forward average minus K.

## GPU-backed loans (lender view)

The mark uses the income approach. Remaining life is the useful life minus the months since install. A month is 365/12 days and the useful life defaults to 48 months. The unit value is the sum, over each remaining month, of S0 × 24 × 30 × utilization × D_m, plus a residual of 10 % of that income value. Utilization defaults to 75 %. The last partial month counts pro rata. The index is held flat at S0 here, with no drift and no basis.

The fleet value is the unit value × units. Loan-to-value is LTV = loan balance / fleet value. The status is ok below 0.60, watch below 0.75 and breach at 0.75 or above.

## Known simplifications

- Credit survival applies to the whole monthly term, including out-of-the-money terms. In reality a provider default on an underwater contract would release the holder.
- There is no seasonality, no term structure beyond the halved drift, and no liquidity discount for selling a large block.
- The basis factors are placeholders, not fitted values.
- The sample contracts are illustrative. No real counterparties or terms are shown.
