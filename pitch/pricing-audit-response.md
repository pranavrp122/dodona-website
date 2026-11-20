# Pricing audit response

This applies the October 2026 pricing and fee audit to the options deck. The deck keeps its slide order, all 19 slides, its style and the fit-to-viewport script. Every number the audit verified is unchanged.

## Change log by slide

- **Slide 4.** The notes gain two sentences saying the exercise, delivery and invoice sequence is still open and pointing to Appendix B. The visible slide is unchanged.
- **Slide 7.** The setup now says the week is about a month from now. The source line states the $2.70 assumed forward, the 40% volatility and that the buyer pays only the cap fee and the capped rent. The notes replace the $0.52 statement with the forward-qualified version and say "assumed forward" instead of "the market expects".
- **Slide 8.** The tag under $23,000 to $35,000 now shows gross and the roughly $19,600 to $30,000 Northwind keeps after our 15%, then the 1% on delivered compute. The Outcomes panel gains one line on the rent Northwind gives up above $3.02 and the block being tied up. In the notes, "Either way it wins" is gone and the audit's trade-off wording replaces it. The notes also add the gross-versus-net figures for both volatility cases, say who is paid for holding capacity, label the rule-of-thumb method and rounding, and add the 50% delivery case of $3,306.90.
- **Slide 10.** The cap-fee chart now reads as the cap flow. The paragraph says proposed pilot pricing taken from the neocloud's side. The caption gives the assumptions and says the figures are before operating and transaction costs. The source line says not a forecast. In the notes, $0.1611 is labelled a rounded rule-of-thumb value, about $0.1605 moment-matched. The 50% delivery share is labelled a business assumption against the 47.3% model probability. The notes add the model-value-versus-net problem with both pilot choices and the gross-up figures, and they note that premium flows differ for floors. The comparables paragraph is rewritten, with the 7% to 20% range, its link and the "pays for holding the capacity" claim removed. The notes also add the revenue qualification.
- **Slide 15.** The notes add that the term sheet must fix the exercise, delivery and invoice sequence before the fee and venue questions can be settled.
- **Slide 17.** The pricing line marks Black 1976 as implemented in our engine and Turnbull and Wakeman 1991 and Curran 1994 as intended methods for the exact average.
- **Slide 18.** The revenue answer now reads "under our proposed fees and assumptions".
- **Slide 19.** The headline and first paragraph now describe the engine as it runs, Black-76 on an assumed forward with the variance time cut to the window start plus a third. All four tables have new captions and headers and keep their numbers. The weekly table now says the window starts one month ahead. The Ornn rows say our calculation, 18 Jul to 17 Oct 2026, daily and weekly log returns, at 89% / 38% and 39% / 60%. The source line adds units, before platform fees and the open sequence. The notes are rewritten to cover the engine method and its model forward, the t/3 approximation and its limits, and the intended Turnbull-Wakeman and Curran methods as not implemented. They also cover the narrow CME 20-198 reading, the volatility sensitivity, the fixing convention, the Ornn reproduction result and the open exercise, delivery and invoice decision.

The Ornn figures were recomputed from the repo's cached Ornn daily index, 18 Jul to 17 Oct 2026, with the engine's conventions. That gives 88.8% / 37.7% for H100 SXM and 39.0% / 60.2% for B200, matching the slide after rounding. The audit's 92% / 39% and 40% / 60% come from a shorter window with Saturday-anchored weeks, and the slide 19 notes explain the gap.

## Decisions the founders still need to make

1. **Fee acceptance model.** Either buyers pay the model value and neoclouds accept about 24% less net at 50% delivery, or the customer price is grossed up to about $0.19 to $0.23 and buyers accept that. The pilot should test which.
2. **Exercise, delivery and invoice sequence.** The demo delivers during the window and invoices at the lower of the window average and the cap. Whether a buyer can decline before the window by a deadline, or vary usage inside it, is open, and each choice changes the price.
3. **Floor and collar fee bases.** A neocloud buying a floor pays the fee rather than receiving it, and a collar's net fee can be near zero. Each needs its own fee definition.
4. **Resale fees.** Decide whether the 1% or any transfer fee recurs on each resale and who pays it.
5. **Index licence.** Ornn data is for demonstration only. A commercial licence for the settlement index is still needed.
6. **Delivered-compute fee base.** Define the 1% base, covering taxes, ancillary services, refunds, partial deliveries, resales and escrow or payment charges.
7. **The demo site's $2 booking fee. Decided.** The booking fee was dropped from the site on 24 Oct 2026. A cap or floor now pays only its fee up front, and a fixed price pays nothing up front, so the site and deck agree. The site describes the 1% of delivered compute as the proposed model only, and settlement does not take it yet.

## Acceptance checklist from the audit

- [x] The weekly $0.25 example still refers to a week starting about one month ahead, on slide 7 and in the slide 19 caption.
- [x] Model values are labelled as estimates under stated assumptions.
- [x] The deck no longer claims exact average-price pricing from vanilla Black-76.
- [x] Black-76 with the t/3 rule is named as implemented, which matches the engine code. Turnbull-Wakeman and Curran are named only as intended methods.
- [x] Forward inputs, spot prices and forecasts are distinguished on slides 7 and 19.
- [x] Option premiums on the pricing appendix state USD per covered GPU-hour.
- [x] Volatility figures carry index, period and sampling convention, with the full Ornn convention in the slide 19 notes.
- [x] Forty percent is called an illustrative base case.
- [x] The 15% applies to the cap fee and the 1% to delivered compute.
- [x] Both fees come from the neocloud's side, and their effect on its proceeds is in the slide 8 and slide 10 notes.
- [x] The revenue ladder is unchanged and matches the retained assumptions.
- [x] Revenue, provider compensation and provider profit are kept apart, and the notes say the net figure is not total revenue.
- [x] The 50% delivery share is labelled a business assumption.
- [x] AWS's 12% base and Deribit's 12.5% cap are described accurately.
- [x] The unverified 7% to 20% range is removed and SF Compute's 10% is labelled a reported figure.
- [x] The exercise, delivery and settlement sequence is marked unresolved on slide 19 and in the slide 4, 15 and 19 notes.
- [x] No new partners, quotes, customer validation or legal conclusions were added.
- [x] This change log and the decisions list accompany the deck.
