#!/usr/bin/env bash
# Dev-only: create a view-only KDS user on the LOCAL node's dev DB (no seeded role has prep_ticket.view
# without prep_ticket.transition). Creates role KDS_VIEWER (prep_ticket.view) via SQL, then staff
# `kdsview1` (S-9001, PIN 1234, NFC card 04AABB01) via the API with the role granted on MAIN_KITCHEN,
# RESTAURANT. Re-runnable. Needs mysql client, curl, jq.
set -euo pipefail
export PATH="/opt/homebrew/opt/mysql@8.4/bin:$PATH"
DB="${R007_DB:-r007_local}"; API="${R007_API_BASE_URL:-http://127.0.0.1:8080}/api/v1"
mysql -u root "$DB" -e "
INSERT IGNORE INTO role (public_id, code, name, description) VALUES (UNHEX(REPLACE(UUID(),'-','')), 'KDS_VIEWER', 'KDS viewer', 'Dev-only: can watch a KDS board, cannot move tickets');
INSERT IGNORE INTO role_permission (role_id, permission_id, requires_approval)
  SELECT r.id, p.id, 0 FROM role r JOIN permission p ON p.code='prep_ticket.view' WHERE r.code='KDS_VIEWER';"
KT=r7d_dev_pos_reception_1
c() { curl -sS -H 'Accept: application/json' -H "X-Device-Token: $KT" -H "Idempotency-Key: rv-$RANDOM-$(date +%s%N)" -H 'Content-Type: application/json' "$@"; }
TOK=$(c -X POST "$API/auth/staff/login" -d '{"credentialType":"PIN","identifier":"owner1","secret":"1234"}' | jq -r .accessToken)
A=(-H "Authorization: Bearer $TOK")
SID=$(c "$API/staff?q=S-9001" "${A[@]}" | jq -r '.items[0].id // empty')
if [ -z "$SID" ]; then
  SID=$(c -X POST "$API/staff" "${A[@]}" -d '{"staffNumber":"S-9001","firstName":"Kds","lastName":"Viewer","username":"kdsview1"}' | jq -r .id)
  c -X PUT "$API/staff/$SID/credentials/pin" "${A[@]}" -d '{"pin":"1234"}' -o /dev/null
  c -X PUT "$API/staff/$SID/credentials/nfc-card" "${A[@]}" -d '{"cardUid":"04AABB01"}' -o /dev/null
  ROLE=$(c "$API/roles?limit=100" "${A[@]}" | jq -r '.items[]|select(.code=="KDS_VIEWER")|.id')
  for F in 84ea0412-4610-5afe-95a3-98242a14ce96 a206b41c-f916-5185-b405-db8a5b67b4db; do
    c -X POST "$API/staff/$SID/role-assignments" "${A[@]}" -d "{\"roleId\":\"$ROLE\",\"scopeType\":\"FACILITY\",\"scopeId\":\"$F\"}" -o /dev/null
  done
fi
echo "kdsview1 staff id: $SID"
curl -sS -X POST "$API/auth/staff/login" -H 'Content-Type: application/json' -H "X-Device-Token: r7d_dev_kds_main_kitchen" -d '{"credentialType":"PIN","identifier":"kdsview1","secret":"1234"}' | jq -c '.staff|{displayName,permissions,facilityIds}'
