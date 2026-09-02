#!/usr/bin/env bash
#
# Drain the ShopCh analysis backlog from an EC2 instance in ap-northeast-2.
#
# WHY THIS RUNS ON EC2 AND NOT A LAPTOP
#
# Extracting audio pulls the whole archived MP4, and a ShopCh programme is
# ~1.16 GB for ~57 minutes — 3.1 TB across the backlog, of which about 99.5% is
# discarded once ffmpeg has the 32 kbps mono track. Pulled over the internet
# that is ~$345 of egress against ~$12 of Gemini. The bucket lives in
# ap-northeast-2 and S3 reads are free to a reader in the same region, so the
# same work costs nothing in transfer from a Seoul instance. The whole point of
# this script is to be in the right place; running it anywhere else defeats it.
#
# PREREQUISITES
#
#   1. EC2 instance in ap-northeast-2. Anything else and you pay the egress
#      this script exists to avoid — the guard below refuses to run.
#   2. An instance role (or credentials) with s3:GetObject on the archive
#      bucket. A role is better than copied keys: nothing to rotate or leak.
#   3. .env.local present in the repo root. It holds Supabase and Gemini
#      secrets and is not in git, so copy it up:
#        scp .env.local ec2-user@<host>:~/mediaworks/.env.local
#      Or put the values in SSM Parameter Store and render the file on boot.
#   4. Restores complete. Bulk takes ~48h; check before starting:
#        npm run restore:archives -- --channel=shopch --category=コスメ --status
#      A slot whose restore has not landed is skipped as cold_storage, and the
#      skip is recorded — so starting early quietly burns through the backlog
#      without analysing it.
#
# USAGE
#   bash scripts/drain-shopch-ec2.sh              # all ten categories
#   bash scripts/drain-shopch-ec2.sh コスメ        # one category
#
set -euo pipefail

REGION_EXPECTED="ap-northeast-2"
LOG="${LOG:-$HOME/shopch-drain.log}"

# ShopCh archives ~1-hour programmes, so one slot is far more work than a QVC
# clip. Concurrency is bounded by ffmpeg CPU, not by network: on a c6i.2xlarge
# (8 vCPU) six at a time leaves headroom. Raise only if `top` shows idle cores.
export BROADCAST_INTEL_BATCH_CONCURRENCY="${BROADCAST_INTEL_BATCH_CONCURRENCY:-6}"

# Read from S3 rather than CloudFront. This is the line that makes transfer
# free, and it is only correct in-region — see lib/broadcast-intel/audio-extract.ts.
export BROADCAST_INTEL_READ_VIA=s3

# One slot's ffmpeg leg and Gemini leg share this budget. A 57-minute programme
# needs more of it than a 3-minute QVC clip, and a timeout costs the slot's
# retry rather than its transfer, so give it room.
export BROADCAST_INTEL_SLOT_TIMEOUT_MS="${BROADCAST_INTEL_SLOT_TIMEOUT_MS:-280000}"

CATEGORIES=(
  "ホーム・インテリア"
  "コスメ"
  "美容・ダイエット・フィットネス"
  "ファッション"
  "グルメ・お酒"
  "靴・バッグ・小物・インナー"
  "ジュエリー"
  "ミックス"
  "家電"
  "旅・趣味・暮らし・コレクターズ"
)
if [[ $# -gt 0 ]]; then CATEGORIES=("$@"); fi

log() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG"; }

# --- guard: being in the wrong region is the one mistake that costs money ----
region=""
if command -v ec2-metadata >/dev/null 2>&1; then
  region="$(ec2-metadata --availability-zone 2>/dev/null | sed 's/.*: //; s/[a-z]$//' || true)"
fi
if [[ -z "$region" ]]; then
  token="$(curl -sS -X PUT 'http://169.254.169.254/latest/api/token' \
    -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' --max-time 3 2>/dev/null || true)"
  if [[ -n "$token" ]]; then
    region="$(curl -sS -H "X-aws-ec2-metadata-token: $token" --max-time 3 \
      http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null || true)"
  fi
fi

if [[ "$region" != "$REGION_EXPECTED" ]]; then
  echo "REFUSING TO RUN."
  echo "  detected region : ${region:-none (not an EC2 instance?)}"
  echo "  required region : $REGION_EXPECTED"
  echo
  echo "S3 reads are free only inside the bucket's region. Outside it this"
  echo "drain would pull 3.1 TB over the internet — about \$345 — which is the"
  echo "cost this script exists to avoid. Run it on a Seoul instance, or drop"
  echo "BROADCAST_INTEL_READ_VIA and accept the CloudFront bill deliberately."
  exit 1
fi
log "region $region confirmed; reading via S3"

command -v node >/dev/null || { echo "node is not installed"; exit 1; }
log "node $(node --version)"
[[ -f .env.local ]] || { echo ".env.local missing in $(pwd) — see PREREQUISITES"; exit 1; }
[[ -d node_modules ]] || { log "installing dependencies"; npm ci; }

# --- drain --------------------------------------------------------------------
# 100 per batch is the drain script's own CEILING, a guard against a typo
# draining a whole category at once. Looping is the intended way past it, so the
# guard stays where it is.
for category in "${CATEGORIES[@]}"; do
  log "########## $category ##########"
  for i in $(seq 1 40); do
    log "----- batch $i -----"
    out="$(npm run --silent drain:broadcast-analysis -- \
      --channel=shopch --category="$category" --limit=100 2>&1 || true)"
    echo "$out" | grep -E '^\[drain\]|"model"|"usage"' | tee -a "$LOG" || true
    if grep -q "processed=0" <<<"$out"; then log "$category exhausted"; break; fi
    if grep -q "seeded 0 slot" <<<"$out"; then log "$category nothing left to seed"; break; fi
  done
done

log "########## DRAIN COMPLETE ##########"
log "Price this run from its own log:"
log "  grep -o 'usage {.*}' $LOG | ..."
log "Then STOP OR TERMINATE THE INSTANCE — it bills by the second while idle."
