#!/bin/bash
# Upgrade test for the October 15 migrations (#83, #87, #88, #93) on the
# DISPOSABLE gradia-record-fresh stack only. Never point this at a shared database.
#   1. reset to main's last migration (20261014120000)
#   2. seed the risky pre-existing data: two shops sharing a subaccount SID,
#      byo_sms_verified=true with and without the shop's own credentials,
#      A2P registrations in draft and rejected
#   3. preflight must report: 1 block, 2 decide
#   4. `migration up` must stop at #87 with the shops and index unchanged
#   5. reconcile the duplicate, preflight clean of blocks, `migration up` completes
#   6. post-checks on the upgraded data
# Synthetic data only. Usage: bash scripts/verify-oct17-upgrade.sh (from the repo root,
# with .local-tools/record-fresh and .local-tools/record-fresh-db.json set up).
set -euo pipefail
WORKDIR=.local-tools/record-fresh
DB=supabase_db_gradia-record-fresh
CFG=.local-tools/record-fresh-db.json
grep -q 'project_id = "gradia-record-fresh"' $WORKDIR/supabase/config.toml || { echo "not the disposable stack"; exit 2; }
API=$(python3 -c "import json;print(json.load(open('$CFG'))['API_URL'])")
[ "$API" = "http://127.0.0.1:56731" ] || { echo "not the disposable stack"; exit 2; }
KEY=$(python3 -c "import json;print(json.load(open('$CFG'))['SERVICE_ROLE_KEY'])")
sql() { docker exec -i $DB psql -U postgres -d postgres -v ON_ERROR_STOP=1 -qtAX "$@"; }
fail() { echo "FAIL: $*"; exit 1; }

echo "== 1. reset to main (20261014120000)"
supabase --workdir $WORKDIR db reset --local --no-seed --version 20261014120000 >/dev/null 2>&1
[ "$(sql -c "select max(version) from supabase_migrations.schema_migrations")" = "20261014120000" ] || fail "baseline"

echo "== 2. seed synthetic pre-existing data"
uids=()
for i in 1 2 3 4; do
  uids+=($(curl -sf -X POST "$API/auth/v1/admin/users" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" \
    -H "Content-Type: application/json" -d "{\"email\":\"upgrade-$i-$RANDOM@example.test\",\"email_confirm\":true}" \
    | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])"))
done
sql <<SQL
insert into public.shops(id,name,owner_id,twilio_subaccount_sid) values
 ('00000000-0000-4000-8000-0000000000a1','Upgrade Shared A','${uids[0]}','ACfixturesharedsubaccount0000001'),
 ('00000000-0000-4000-8000-0000000000a2','Upgrade Shared B','${uids[1]}','ACfixturesharedsubaccount0000001');
insert into public.shops(id,name,owner_id,twilio_phone_number,byo_sms_verified) values
 ('00000000-0000-4000-8000-0000000000b1','Upgrade BYO No Creds','${uids[2]}','+15555550161',true);
insert into public.shops(id,name,owner_id,twilio_phone_number,byo_sms_verified,twilio_account_sid_enc,twilio_auth_token_enc) values
 ('00000000-0000-4000-8000-0000000000b2','Upgrade BYO Own Creds','${uids[3]}','+15555550162',true,'fixture-sid-enc','fixture-token-enc');
insert into public.a2p_registrations(shop_id,status,business,failure_reason) values
 ('00000000-0000-4000-8000-0000000000a1','draft','{}',null),
 ('00000000-0000-4000-8000-0000000000a2','rejected','{}','Fictional rejection');
SQL

echo "== 3. preflight before"
pre=$(sql -F'|' < scripts/preflight-oct17-migrations.sql)
echo "$pre" | sed 's/^/   /'
[ "$(echo "$pre" | grep -c '|block|')" = 1 ] || fail "expected exactly 1 block"
echo "$pre" | grep -q '#87: subaccount SID shared by 2 shops' || fail "duplicate not reported"
[ "$(echo "$pre" | grep -c '|decide|')" = 2 ] || fail "expected 2 decide"

echo "== 4. migration up must stop at #87, changing nothing there"
if supabase --workdir $WORKDIR migration up --local >/tmp/oct17-up1.log 2>&1; then fail "migration up succeeded over a duplicate SID"; fi
grep -q "shops_twilio_subaccount_sid_unique\|could not create unique index" /tmp/oct17-up1.log || { cat /tmp/oct17-up1.log; fail "unexpected failure"; }
[ "$(sql -c "select count(*) from pg_indexes where indexname='shops_twilio_subaccount_sid_unique'")" = 0 ] || fail "index left behind"
[ "$(sql -c "select count(*) from public.shops where twilio_subaccount_sid='ACfixturesharedsubaccount0000001'")" = 2 ] || fail "shops changed"
echo "   ledger after the refusal: $(sql -c "select string_agg(version,',' order by version) from supabase_migrations.schema_migrations where version>'20261014120000'")"

echo "== 5. reconcile, preflight, finish"
# Synthetic reconciliation: the second shop never owned that subaccount.
sql -c "update public.shops set twilio_subaccount_sid=null where id='00000000-0000-4000-8000-0000000000a2'"
pre2=$(sql -F'|' < scripts/preflight-oct17-migrations.sql)
echo "$pre2" | grep '|block|' && fail "blocks remain" || true
echo "$pre2" | grep -q 'already applied 20261015120000|info' || fail "resume not recognised"
supabase --workdir $WORKDIR migration up --local >/tmp/oct17-up2.log 2>&1 || { cat /tmp/oct17-up2.log; fail "migration up"; }
[ "$(sql -c "select max(version) from supabase_migrations.schema_migrations")" = "20261015150000" ] || fail "not at head"

echo "== 6. post-checks"
[ "$(sql -c "select count(*) from pg_indexes where indexname='shops_twilio_subaccount_sid_unique'")" = 1 ] || fail "index"
[ "$(sql -c "select attempts||coalesce(failed_step,'-')||coalesce(retryable::text,'-') from public.a2p_registrations where shop_id='00000000-0000-4000-8000-0000000000a2'")" = "0--" ] || fail "a2p backfill"
[ "$(sql -c "select string_agg(byo_sms_verified::text,',' order by id) from public.shops where id::text like '%0000b%'")" = "true,true" ] || fail "byo flags (expected unchanged)"
[ "$(sql -c "select public.byo_sms_attestation_state('00000000-0000-4000-8000-0000000000b1')->>'state'")" = "not_own_account" ] || fail "state b1"
[ "$(sql -c "select public.byo_sms_attestation_state('00000000-0000-4000-8000-0000000000b2')->>'state'")" = "confirmed" ] || fail "state b2"
[ "$(sql -c "select count(*) from public.byo_sms_attestations")" = 0 ] || fail "history"
if sql -c "insert into public.shops(name,owner_id,twilio_subaccount_sid) values ('Dup','${uids[0]}','ACfixturesharedsubaccount0000001')" 2>/dev/null; then fail "duplicate SID accepted"; fi
echo "PASS: upgrade path verified (b1 = open flag without own credentials: the 'decide' finding is real)"
