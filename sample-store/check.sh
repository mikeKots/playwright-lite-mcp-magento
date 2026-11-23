#!/usr/bin/env bash
# Verifies the sample store and then playwright-lite-mcp against it.
# Usage: sample-store/check.sh [base-url]     (default: https://app.hyva-demo.test)
# Env:   EXPECT_THEME=Hyva/default (default) | Magento/luma | any   theme the store must run
set -uo pipefail

BASE="${1:-https://app.hyva-demo.test}"
BASE="${BASE%/}"
HERE="$(cd "$(dirname "$0")" && pwd)"
fails=0

pass() { printf '\033[32mOK  \033[0m %s\n' "$*"; }
fail() { printf '\033[31mFAIL\033[0m %s\n' "$*"; fails=$((fails + 1)); }
status() { curl -s -o /dev/null -w '%{http_code}' "$1"; }

echo "Store: $BASE"

home="$(curl -s "$BASE/")"
code="$(status "$BASE/")"
[[ "$code" == 200 ]] && pass "home 200" || fail "home returned $code (TLS? run: warden sign-certificate hyva-demo.test)"

# The theme shows in static asset URLs (/static/<version>/frontend/<Vendor>/<theme>/...). Matching
# "hyva" anywhere in the HTML is not enough: the demo store's own domain contains it.
expect="${EXPECT_THEME:-Hyva/default}"
theme="$(grep -o -E '/frontend/[A-Za-z0-9_]+/[A-Za-z0-9_]+/' <<<"$home" | sort | uniq -c | sort -rn | awk 'NR==1{print $2}' | cut -d/ -f3,4)"
if [[ "$expect" == any || "$theme" == "$expect" ]]; then
  pass "theme ${theme:-unknown}"
else
  fail "theme is ${theme:-unknown}, expected $expect (design/theme/theme_id? or set EXPECT_THEME)"
fi

search="$(curl -s "$BASE/catalogsearch/result/?q=bag")"
grep -q 'Duffle Bag' <<<"$search" && pass "search finds sample products" \
  || fail "search 'bag' found nothing (sample data / indexer:reindex?)"

gql="$(curl -s -H 'Content-Type: application/json' -d '{"query":"{ storeConfig { store_name } }"}' "$BASE/graphql")"
grep -q '"storeConfig"' <<<"$gql" && pass "GraphQL answers" || fail "GraphQL: ${gql:0:200}"

# Varnish: first request may MISS, the repeat must HIT. Warden's VCL reports it as X-Cache,
# stock Magento VCL / built-in FPC as X-Magento-Cache-Debug (developer mode).
curl -s -o /dev/null "$BASE/gear.html"
cache="$(curl -s -D - -o /dev/null "$BASE/gear.html" | tr -d '\r' \
  | awk -F': ' 'tolower($1)=="x-cache" || tolower($1)=="x-magento-cache-debug" {print $2; exit}')"
[[ "$cache" == HIT* ]] && pass "full page cache HIT (Varnish)" || fail "cache header='${cache:-none}' on repeat request"

[[ "$(status "$BASE/checkout/cart/")" == 200 ]] && pass "cart 200" || fail "cart not 200"

echo
echo "MCP: playwright-lite-mcp against $BASE"
if [[ -f "$HERE/../dist/index.js" ]]; then
  node "$HERE/mcp-smoke.mjs" "$BASE" || fails=$((fails + 1))
else
  fail "dist/index.js missing: run npm run build"
fi

echo
[[ $fails -eq 0 ]] && echo "All checks passed" || echo "$fails check(s) failed"
exit $((fails > 0))
