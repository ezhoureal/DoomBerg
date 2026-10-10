"""Turn observed node metrics into incidents.

This is the only place where an observation becomes a failure probability, so the
mapping is explicit and auditable. Simulated events and (later) live feeds both
produce metrics; both go through these rules. pFail / lossGivenFailure are coarse
priors over the snapshot horizon, not calibrated estimates.
"""


def _incident(rule, node, kind, severity, title, p_fail, lgf, description):
    return {
        "id": "det-%s-%s" % (rule, node["id"]),
        "nodeId": node["id"],
        "kind": kind,
        "severity": severity,
        "title": title,
        "description": description,
        "status": "active",
        "pFail": round(min(p_fail, 0.95), 4),
        "lossGivenFailure": round(min(lgf, 0.95), 4),
        "source": "%s monitor" % rule,
    }


def oracle_deviation(node, m, params):
    d = m.get("deviationPct")
    if node["type"] != "oracle" or d is None or d < params["oracleDeviationWarnPct"]:
        return None
    severity = "high" if d >= params["oracleDeviationCritPct"] else "medium"
    # Liquidations or borrows at a wrong price: likelihood grows with the gap.
    return _incident("oracle-deviation", node, "oracle_deviation", severity,
                     "%s %.1f%% away from market" % (node["label"], d),
                     0.05 * d, 0.35,
                     "Oracle price deviates %.2f%% from the market reference "
                     "(warn %.1f%%, critical %.1f%%)."
                     % (d, params["oracleDeviationWarnPct"], params["oracleDeviationCritPct"]))


def oracle_stale(node, m, params):
    age, heartbeat = m.get("stalenessSec"), m.get("heartbeatSec")
    if node["type"] != "oracle" or age is None or not heartbeat or age <= heartbeat:
        return None
    ratio = age / heartbeat
    severity = "high" if ratio >= 3 else "medium"
    return _incident("oracle-stale", node, "oracle_deviation", severity,
                     "%s stale: %.0fx heartbeat" % (node["label"], ratio),
                     0.03 * ratio, 0.3,
                     "Last update %ds ago against a %ds heartbeat. Consumers keep using "
                     "the old price while the market moves." % (age, heartbeat))


def peg_deviation(node, m, params):
    d = m.get("pegDeviationPct")
    if d is None or abs(d) < params["pegDeviationWarnPct"]:
        return None
    a = abs(d)
    severity = "critical" if a >= 5 else "high" if a >= 2 else "medium"
    return _incident("peg", node, "depeg", severity,
                     "%s off peg by %+.2f%%" % (node["label"], d),
                     0.08 * a, max(0.2, 3 * a / 100),
                     "Trading %+.2f%% from peg (warn %.1f%%). Deeper depegs raise both the "
                     "chance of a full break and the loss if it happens."
                     % (d, params["pegDeviationWarnPct"]))


def liquidity_crunch(node, m, params):
    u = m.get("utilization")
    if u is None or u < 0.98:
        return None
    return _incident("utilization", node, "liquidity_crunch",
                     "high" if u >= 0.995 else "medium",
                     "%s %.1f%% utilised" % (node["label"], u * 100),
                     0.1, 0.05,
                     "Lenders cannot withdraw until borrowers repay or rates pull in "
                     "liquidity. Mostly an exit risk; principal loss is small.")


RULES = (oracle_deviation, oracle_stale, peg_deviation, liquidity_crunch)


def detect_incidents(snapshot, detected_at):
    params = snapshot["riskParams"]
    out = []
    for node in snapshot["nodes"]:
        m = node.get("metrics") or {}
        for rule in RULES:
            inc = rule(node, m, params)
            if inc:
                inc["detectedAt"] = detected_at
                out.append(inc)
    return out
