"""Morpho GraphQL API client (https://api.morpho.org/graphql). Public, no key."""

from __future__ import annotations

from typing import Any

from .http import post_json

URL = "https://api.morpho.org/graphql"


class MorphoError(RuntimeError):
    pass


def query(q: str, variables: dict | None = None, ttl: float = 120) -> dict[str, Any]:
    res = post_json(URL, {"query": q, "variables": variables or {}}, ttl=ttl)
    if res.get("errors"):
        raise MorphoError("; ".join(e.get("message", "?") for e in res["errors"]))
    return res["data"]


ASSET = "address symbol name decimals tags price { usd }"

ORACLE = """oracle { address type data { __typename
  ... on MorphoChainlinkOracleV2Data { baseFeedOne { address } baseFeedTwo { address } quoteFeedOne { address } quoteFeedTwo { address }
        baseOracleVault { address } quoteOracleVault { address } }
  ... on MorphoChainlinkOracleData { baseFeedOne { address } baseFeedTwo { address } quoteFeedOne { address } quoteFeedTwo { address }
        baseOracleVault { address } } } }"""

MARKET = f"""marketId lltv irmAddress creationTimestamp
  loanAsset {{ {ASSET} }} collateralAsset {{ {ASSET} }}
  {ORACLE}
  morphoBlue {{ address }}
  state {{ supplyAssetsUsd borrowAssetsUsd liquidityAssetsUsd collateralAssetsUsd utilization supplyApy borrowApy dailyPriceVariation }}
  badDebt {{ usd }} realizedBadDebt {{ usd }}
  warnings {{ type level }}"""

VAULT_V2 = f"""address name symbol creationTimestamp chain {{ id network }} asset {{ {ASSET} }}
  totalAssetsUsd liquidityUsd idleAssetsUsd netApy performanceFee managementFee
  owner {{ address }} curator {{ address }} curators(first: 3) {{ items {{ name verified }} }}
  timelocks {{ selector duration }}
  warnings {{ type level }}
  adapters(first: 10) {{ items {{ __typename address type assetsUsd forceDeallocatePenalty
    ... on MorphoMarketV1Adapter {{ positions(first: 40) {{ items {{ state {{ supplyAssetsUsd }} market {{ {MARKET} }} }} }} }}
    ... on MetaMorphoAdapter {{ metaMorpho {{ address name }} }}
  }} }}"""

VAULT_V1 = f"""address name symbol creationTimestamp chain {{ id network }} asset {{ {ASSET} }}
  liquidity {{ usd }}
  warnings {{ type level }}
  state {{ totalAssetsUsd netApy fee curator owner guardian timelock
    curators {{ name verified }}
    allocation {{ supplyAssetsUsd supplyCapUsd market {{ {MARKET} }} }} }}"""


def vault_v2(address: str, chain_id: int) -> dict | None:
    try:
        d = query(f"query($a:String!,$c:Int!){{ vaultV2ByAddress(address:$a, chainId:$c) {{ {VAULT_V2} }} }}",
                  {"a": address, "c": chain_id})
    except MorphoError:
        try:
            d = query(f"query($a:String!,$c:Int!){{ vaultV2ByAddress(address:$a, chainId:$c) {{ {VAULT_V2.replace('timelocks { selector duration }', '')} }} }}",
                      {"a": address, "c": chain_id})
        except MorphoError:
            return None
    return d.get("vaultV2ByAddress")


def vault_v1(address: str, chain_id: int) -> dict | None:
    try:
        d = query(f"query($a:String!,$c:Int!){{ vaultByAddress(address:$a, chainId:$c) {{ {VAULT_V1} }} }}",
                  {"a": address, "c": chain_id})
    except MorphoError:
        return None
    return d.get("vaultByAddress")


def market(market_id: str, chain_id: int) -> dict | None:
    try:
        d = query(f"query($k:String!,$c:Int!){{ marketById(marketId:$k, chainId:$c) {{ {MARKET} chain {{ id network }} }} }}",
                  {"k": market_id, "c": chain_id})
        return d.get("marketById")
    except MorphoError:
        d = query(f"query($k:[String!]){{ markets(first:1, where:{{ uniqueKey_in:$k }}) {{ items {{ {MARKET} chain {{ id network }} }} }} }}",
                  {"k": [market_id]})
        items = d["markets"]["items"]
        return items[0] if items else None


def asset(address: str, chain_id: int) -> dict | None:
    try:
        d = query(f"query($a:String!,$c:Int!){{ assetByAddress(address:$a, chainId:$c) {{ {ASSET} }} }}",
                  {"a": address, "c": chain_id}, ttl=600)
        return d.get("assetByAddress")
    except MorphoError:
        return None


def markets_for_collateral(address: str, chain_id: int, first: int = 5) -> list[dict]:
    try:
        d = query(f"""query($a:[String!],$c:[Int!]){{ markets(first:{first}, orderBy: SupplyAssetsUsd, orderDirection: Desc,
                       where:{{ collateralAssetAddress_in:$a, chainId_in:$c }}) {{ items {{ {MARKET} }} }} }}""",
                  {"a": [address], "c": [chain_id]})
        return d["markets"]["items"]
    except MorphoError:
        return []


def vaults_by_curator(curator_addresses: list[str]) -> list[dict]:
    d = query("""query($c:[Address!]){ vaultV2s(first: 50, where:{ curatorAddress_in:$c }) { items {
        address name chain { id network } asset { symbol } totalAssetsUsd liquidityUsd netApy curators(first:2){ items { name } } } } }""",
              {"c": curator_addresses}, ttl=600)
    return d["vaultV2s"]["items"]


def user_positions(address: str, chain_id: int) -> dict | None:
    try:
        d = query("""query($a:String!,$c:Int!){ userByAddress(address:$a, chainId:$c) {
            vaultV2Positions { assetsUsd vault { address name asset { symbol } } }
            vaultPositions { state { assetsUsd } vault { address name asset { symbol } } }
            marketPositions { state { supplyAssetsUsd borrowAssetsUsd collateralUsd } healthFactor
               market { marketId loanAsset { symbol } collateralAsset { symbol } } } } }""",
                  {"a": address, "c": chain_id})
        return d.get("userByAddress")
    except MorphoError:
        return None
