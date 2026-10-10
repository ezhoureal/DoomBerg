# Doomberg Terminal presentation

**Audience:** Belem Capital challenge judges  
**Format:** 10 slides, including the title slide  
**Suggested duration:** 8–10 minutes, including a short dashboard demonstration

Use the content under each slide heading on screen. The expandable speaker notes provide the explanation and demonstration instructions.

---

## Slide 1 — Doomberg Terminal

### Dependency risk decision support for Belem Capital

**What does an investment depend on, what happens if something fails, and is leaving worth the cost?**

A working dashboard using live DeFi data.

<details>
<summary>Speaker notes</summary>

“Doomberg Terminal helps a portfolio or risk employee examine a DeFi investment. It discovers dependencies, estimates how failures could affect the position, and compares the modeled loss avoided with the cost of exiting. The employee receives an explanation alongside the recommendation.”

The prototype supports holding a Pendle Principal Token and supplying assets to a Morpho lending market with a Pendle Principal Token as collateral. It produces recommendations. It does not execute trades.

</details>

---

## Slide 2 — The problem: hidden exposure

- A USDC lending position can depend on another asset several steps away.
- An oracle error, issuer problem or liquidity shortage can reach the lender.
- The same incident can cause very different losses in different positions.
- Leaving has costs, and part of the investment may be unavailable to withdraw.

**The employee needs a position-specific economic decision.**

<details>
<summary>Speaker notes</summary>

“Seeing USDC on a balance sheet does not describe every risk behind a lending investment. Borrowers may provide collateral that depends on another issuer and another protocol. The lender can suffer even without owning that collateral directly.”

An incident alert alone cannot answer whether to exit. A small collateral decline may remain inside a lending safety buffer. A severe incident may justify leaving, but high execution costs or unavailable liquidity can change that comparison. This is the decision described in the Belem Capital challenge.

</details>

---

## Slide 3 — The investment and its participants

**Illustrative mandate: an employee monitors a fund’s $1 million USDC lending position.**

| Participant or asset | Role |
| --- | --- |
| Fund | Owns the invested capital and acts as the lender |
| Belem Capital employee | Monitors exposure and evaluates the recommendation |
| Borrowers | Borrow USDC and deposit collateral |
| Morpho market | Connects lending capital with collateralized borrowing |
| USDC | The asset supplied and borrowed |
| PT-reUSD-10DEC2026 | Borrower collateral with a 10 December 2026 maturity |
| reUSD | The underlying yield-accruing asset supporting the PT |

<details>
<summary>Speaker notes</summary>

“The employee is monitoring the fund’s money. The fund supplies USDC to the market. Borrowers provide PT-reUSD as security and pay interest on their USDC loans. That borrowing interest generates the lender’s return.”

PT means Principal Token. Pendle separates an underlying investment’s principal claim from its future yield. The PT represents the principal claim at maturity, subject to its backing and redemption mechanics. The exact redemption denomination depends on the market. One PT does not automatically redeem for one reUSD or one US dollar.

Re Protocol’s reUSD is a senior, yield-accruing investment token connected to reinsurance capital. Its price can increase as yield accumulates. A price above $1 is not automatically a depeg. The fund can depend on reUSD through borrower collateral without holding reUSD directly.

This mandate illustrates the prototype. It is not a statement about Belem Capital’s actual clients or positions.

References: [Pendle PT mechanics](https://docs.pendle.finance/pendle-v2/ProtocolMechanics/YieldTokenization/PT), [Re’s reUSD documentation](https://docs.re.xyz/products/about-reusd), [Circle USDC](https://www.circle.com/usdc).

</details>

---

## Slide 4 — Dependency discovery on real data

The employee enters a supported position, its size and a forecast horizon.

| Dependency | Why it matters |
| --- | --- |
| Assets and issuers | Backing, redemption and dollar value |
| Oracles and feeds | Borrowing and liquidation prices |
| Lending markets | Collateral buffers and withdrawable cash |
| Pendle trading pool | Sale liquidity and forced-selling effects |
| Protocols, token controls and chain | Contract security, privileged actions and execution |

**Every discovered relationship carries source evidence.**

<details>
<summary>Speaker notes</summary>

“Discovery combines blockchain reads, Morpho’s API, Pendle data and a registry for relationships that contracts alone cannot establish. The graph distinguishes direct observations from API evidence, inferred relationships and unverified information.”

Graph arrows point from a component to the dependency it relies on. Economic damage generally propagates back toward the investment. Simplified groups reduce visual clutter while retaining the underlying dependencies. Fixed boxes and separated connection routes make the graph easier to interpret.

The checked PT-reUSD/USDC example contained 17 nodes and 20 relationships. Those counts can change with live data. Discovery also checks other Morpho markets that accept the same PT, because forced sales there can affect its value here. Coverage is bounded to the largest five qualifying collateral venues and is not exhaustive across DeFi.

Suggested visual: a screenshot of the actual simplified dependency graph with the collateral and backing relationship highlighted.

</details>

---

## Slide 5 — Failure probability responds to evidence

1. **Starting risk:** a Gamma-Poisson model represents an uncertain annual failure rate.
2. **Live evidence:** rules detect peg deviations, stale feeds, price drops and liquidity stress.
3. **Probability update:** likelihood ratios increase the odds when signals strengthen.
4. **Recent stress:** a decaying contagion multiplier raises related failure rates temporarily.

**Example:** a 1% prior becomes approximately 16.8% when an alert multiplies its odds by 20.

Configured parameters require further empirical calibration.

<details>
<summary>Speaker notes</summary>

“Probability answers how likely a selected failure is over the chosen horizon. The starting rate is uncertain, so the model samples a distribution rather than assigning a single unquestionable value.”

The Poisson assumption models event arrivals at a rate. A Gamma distribution represents uncertainty in that positive rate. The implementation samples:

```text
annual rate λ ~ Gamma(shape = k + 0.5, rate = T / m)
horizon probability p = 1 − exp(−λ × horizon_days / 365)
```

Here, k is a configured event count, T is assumed exposure in component-years, and m combines risk modifiers. These are curated judgments rather than estimates from a comprehensive audited incident dataset.

Signal updates use Bayesian odds:

```text
odds = p / (1 − p)
updated odds = odds × likelihood ratio
updated p = updated odds / (1 + updated odds)
```

At p = 1%, multiplying odds by 20 gives approximately 16.8%. The likelihood ratios are hand-set. Signal families reduce known duplicate evidence, but different families are not proven statistically independent.

The contagion mechanism is Hawkes-style: recorded incidents and alert episodes contribute stress that decays over time. Its weights are heuristic. Oracle staleness currently uses configured thresholds, not individually verified provider heartbeats. The system does not automatically discover every hack or every outage.

</details>

---

## Slide 6 — Economic impact follows the dependency path

**Illustrative loan:** $100 borrowed against $150 of PT collateral.

- A backing problem reduces the collateral to $90.
- Timely liquidation can limit damage before collateral becomes insufficient.
- A blind oracle or execution freeze can prevent that response.
- If only $90 is recovered against $100 owed, the uncovered debt is $10.

**Monte Carlo simulation samples possible severities and responses, then computes position losses.**

<details>
<summary>Speaker notes</summary>

“The engine does not assume that a 40% collateral decline produces a 40% lender loss. It accounts for the borrower’s collateral buffer and whether liquidators can respond.”

The example isolates one loan and ignores interest and fees. Actual pool losses depend on borrowed exposure and the lender’s share.

In the model, borrower leverage varies within assumed bounds below the market’s liquidation threshold, called LLTV. A simplified uncovered-debt calculation is:

```text
uncovered debt fraction = max(0, 1 − remaining collateral value / initial debt)
```

The engine samples liquidation effectiveness and reduces that mitigation when the oracle is stale, fails to track market prices, or the chain stops execution. Wrong high prices can also allow excessive borrowing against collateral.

Other lending venues introduce a further channel: liquidators selling the same PT can depress its price through the Pendle pool. This is a single-pass approximation, not a complete iterative liquidation cascade.

Detailed scenarios normally use 5,000 simulations. The output shows average, median and 95th-percentile conditional losses. Those values describe modeled damage if the selected failure occurs. Probability is a separate calculation.

</details>

---

## Slide 7 — Stay or exit: an economic comparison

### Selected incident scenario

```text
EXIT when probability × average loss if failure occurs × removable share
          exceeds the whole-position exit cost
```

- Withdrawal liquidity limits the exposure that can leave now.
- Available PT sale quotes reflect the entered position size.
- Costs include execution impact, gas and modeled redeployment carry.
- The employee sees the recommendation, reasons and remaining exposure.

<details>
<summary>Speaker notes</summary>

“Expected loss combines likelihood with consequence. The removable share matters because withdrawing half the investment only removes half its modeled exposure.”

The scenario rule is p × mean loss × f > c. All quantities use whole-position fractions, and f is the share that can be removed immediately. Multiplying by position size converts the comparison into dollars.

For example, a 10% chance of a 40% loss means 4% expected loss. If only half can leave, the modeled loss avoided is 2% of the original position. That is the quantity to compare with the whole-position exit cost.

For a held PT, the engine requests available KyberSwap and Pendle cash routes and selects the cheaper quoted cost. It values output tokens using separate USD marks rather than assuming every stablecoin equals $1. For a lending position, withdrawal comes first and available market cash constrains it.

The scenario exit calculation includes a default seven days of forgone yield during redeployment. Quotes can change before execution. A blocked route removes no modeled exposure, so a STAY result with execution blocked must not be interpreted as an endorsement of safety.

</details>

---

## Slide 8 — Scheduled monitoring and daily decisions

- A saved watchlist screens supported investments on a configured schedule.
- Live rules set alert levels and feed the probability model.
- SQLite retains forecasts, observations, decisions and changes.
- Missing required inputs produce **REVIEW**.

### Daily rule

```text
EXIT when (aggregate expected loss − remaining-horizon yield credit)
          × removable share exceeds exit cost
```

<details>
<summary>Speaker notes</summary>

“Daily monitoring checks the investment repeatedly and remembers what changed. Historical replay serves a different purpose: testing the model’s response to a known incident scenario.”

Daily expected loss adds component-mode probability times average conditional position loss. The exit estimate uses calm liquidity assumptions. The latest daily rule also credits the yield forgone over the remaining horizon:

```text
E = sum of p_i × mean loss_i
Y = current APY × max(horizon_days − redeploy_days, 0) / 365
EXIT if (E − Y) × f > c
```

Exit cost c already includes seven days of redeployment carry. For a 30-day horizon, Y covers the other 23 days. The calculation assumes exited capital earns nothing afterward and approximates APY linearly. This can favor staying and does not represent a complete comparison with another investment.

History identifies changes such as verdict flips, stronger alerts and increasing expected loss. An optional webhook can deliver configured notifications. The scheduler requires the backend process to remain running, and source caches mean readings are not simultaneous or tick-by-tick.

Calibration reports score matured forecasts against recorded outcomes. A short history cannot establish forecast accuracy. Missing outcome records can bias those reports. The optional AI summary explains computed results and does not choose the numeric verdict.

</details>

---

## Slide 9 — Demonstration: real discovery and different decisions

**Entered investment: $1 million USDC supplied against PT-reUSD collateral.**

| Checked case | Modeled loss avoided versus exit cost | Output |
| --- | --- | --- |
| Live daily snapshot | $909 net of yield versus $1,446 | **STAY** |
| Controlled USDC depeg: 80% probability, 0.5% exit cost | Approximately $47,602 versus $5,000 | **EXIT** |
| Same failure: 5% probability, 11% exit cost | Approximately $2,975 versus $110,000 | **STAY** |

Live snapshot: 11 October 2026. Controlled cases use explicit overrides. Values can change with refreshed data.

<details>
<summary>Speaker notes and demonstration steps</summary>

Allow approximately two minutes for the demonstration. Rehearse after refreshing the investment, since current data can alter the numbers.

1. Open the PT-reUSD/USDC reference lending position. Show the entered $1 million size and 30-day horizon. Trace the borrower collateral to reUSD, then inspect the oracle or its source evidence.
2. Show the recorded daily STAY example. Its total modeled expected loss was approximately $5,530. The remaining-horizon yield credit was approximately $4,621. With 100% removable exposure, net modeled loss avoided was approximately $909, below the $1,446 exit cost.
3. Select USDC and its depeg failure mode. In Advanced overrides, set probability to 80% and exit cost to 0.5%. Run the scenario and show EXIT.
4. Repeat with probability 5% and exit cost 11%. Show STAY and explain that the economics changed while the dependency remained the same.

The controlled cases ran on the checked live graph with 5,000 draws. Average conditional loss was approximately 5.96%, and the stressed removable share was approximately 99.77%. The overrides demonstrate the decision boundary. They are not estimates that these probabilities or costs currently apply.

If time is short, use a saved screenshot of the daily run and demonstrate one controlled case live. Clear the overrides afterward. Do not present a saved result as a newly refreshed observation.

Evidence: the project manual’s checked snapshot and scenarios at backend commit e85961f. Backend tests passed in that review. The graph update passed 24 frontend tests and a production build, with browser checks confirming fixed nodes and separated routes on the live example. These checks establish implementation behavior, not predictive profitability.

</details>

---

## Slide 10 — Value for Belem Capital and remaining work

| Challenge objective | What Doomberg Terminal provides |
| --- | --- |
| Dependency discovery | A position graph with source evidence and expandable components |
| Impact estimation | Simulated losses through lending, oracle and liquidation relationships |
| Decision usefulness | STAY, EXIT or REVIEW with costs, removable exposure and reasons |
| Working implementation | Live discovery, a usable dashboard and persistent scheduled history |

**A traceable route from dependency evidence to an economic decision.**

Next priorities: validate parameters and classifications, broaden dependency coverage, and add production operating controls.

<details>
<summary>Speaker notes</summary>

“The contribution is the integration. The employee can follow the reasoning from a discovered dependency through modeled damage to an exit comparison, then see how that result changes over time.”

The challenge weights dependency discovery and impact estimation at 30% each, decision usefulness at 25%, and the working demo at 15%. The presentation and demonstration address each of these directly.

Be explicit about the prototype’s limits if challenged. Priors, likelihood ratios and severity assumptions need empirical validation. Daily aggregation simplifies correlated and overlapping failures. Discovery cannot guarantee completeness, and the fire-sale approximation does not simulate every borrower or a full cascade. Source freshness and oracle classifications need stronger validation.

Institutional deployment also requires authentication, access controls, process supervision and an execution review workflow. The tool supports employee judgment and does not promise guaranteed returns or accurate prediction of every incident.

Close with: “Doomberg Terminal makes the dependencies and the stay-or-exit trade-off visible enough for a portfolio manager to inspect, question and act on.”

</details>
