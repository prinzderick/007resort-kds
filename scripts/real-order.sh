#!/usr/bin/env bash
# Create + send a real order on the local node as wait1 (tablet TABLET_WAITER_01 checked out to RESTAURANT).
# usage: scripts/real-order.sh [food|drink|both|pool] [qty]    -> prints order id; needs curl + jq.
# Env: R007_API_BASE_URL (default http://127.0.0.1:8080)
set -euo pipefail
API="${R007_API_BASE_URL:-http://127.0.0.1:8080}/api/v1"
KIND="${1:-both}"; QTY="${2:-1}"
RST=a206b41c-f916-5185-b405-db8a5b67b4db; POOL=991c6184-c816-52a5-8dc8-edd5f8e83142
WDEV=e612c5af-f79f-508d-98ae-73f229403ebb; WTOK=r7d_dev_tablet_waiter_01; WSTAFF=e2ba390c-a6cc-53c3-9a84-b4fc1af047be
c() { curl -sS -H 'Accept: application/json' -H "X-Device-Token: $WTOK" -H "Idempotency-Key: ro-$RANDOM-$(date +%s%N)" "$@"; }
FAC=$RST; [ "$KIND" = pool ] && FAC=$POOL
if [ "$KIND" = pool ]; then WLOGIN=wait2; WTOK=r7d_dev_tablet_waiter_02; WDEV=feb70e78-fd5d-5496-9537-856258138bf4; else WLOGIN=wait1; fi
TOKEN=$(c -X POST "$API/auth/staff/login" -H 'Content-Type: application/json' -d "{\"credentialType\":\"PIN\",\"identifier\":\"$WLOGIN\",\"secret\":\"1234\"}")
STAFF=$(echo "$TOKEN" | jq -r .staffId); TOKEN=$(echo "$TOKEN" | jq -r .accessToken)
A=(-H "Authorization: Bearer $TOKEN")
CO=$(c -X POST "$API/devices/$WDEV/checkout" "${A[@]}" -H 'Content-Type: application/json' -d "{\"staffId\":\"$STAFF\",\"facilityId\":\"$FAC\"}" -o /dev/null -w '%{http_code}')
if [ "$CO" = 409 ]; then c -X POST "$API/devices/$WDEV/checkin" "${A[@]}" -H 'Content-Type: application/json' -d '{}' -o /dev/null; c -X POST "$API/devices/$WDEV/checkout" "${A[@]}" -H 'Content-Type: application/json' -d "{\"staffId\":\"$STAFF\",\"facilityId\":\"$FAC\"}" -o /dev/null; fi
PRODUCTS=$(c "$API/catalog/products?facilityId=$FAC&limit=200" "${A[@]}")
pid() { echo "$PRODUCTS" | jq -r --arg s "$1" '[.items[]|select(.sku==$s)][0].id'; }
TABLES=$(c "$API/tables?facilityId=$FAC&limit=200" "${A[@]}")
TABLE=$(echo "$TABLES" | jq -r '[.items[]|select(.status=="FREE" or .status=="AVAILABLE")][0].id // empty')
[ -n "$TABLE" ] && c -X POST "$API/tables/$TABLE/open" "${A[@]}" -H 'Content-Type: application/json' -d '{}' -o /dev/null || true
JOL=$(pid FD-JOL-CH); STAR=$(pid BR-STAR)
case "$KIND" in
  food) LINES="[{\"productId\":\"$JOL\",\"quantity\":$QTY,\"notes\":\"no pepper\"}]";;
  drink|pool) LINES="[{\"productId\":\"$STAR\",\"quantity\":$QTY}]";;
  both) LINES="[{\"productId\":\"$JOL\",\"quantity\":$QTY,\"notes\":\"no pepper\"},{\"productId\":\"$STAR\",\"quantity\":$QTY}]";;
esac
TB=""; [ -n "$TABLE" ] && TB=",\"tableId\":\"$TABLE\""
ORD=$(c -X POST "$API/orders" "${A[@]}" -H 'Content-Type: application/json' -d "{\"facilityId\":\"$FAC\"$TB,\"channel\":\"DINE_IN\",\"lines\":$LINES}" -D /tmp/ro.hdr)
ID=$(echo "$ORD" | jq -r .id); ETAG=$(grep -i '^etag:' /tmp/ro.hdr | tail -1 | sed 's/^[^:]*: *//' | tr -d '\r')
[ "$ID" != null ] || { echo "$ORD" >&2; exit 1; }
c -X POST "$API/orders/$ID/send" "${A[@]}" -H 'Content-Type: application/json' -H "If-Match: $ETAG" -d '{}' | jq -c '{id,status,number:.number}' >&2
echo "$ID"
