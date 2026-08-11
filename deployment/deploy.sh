#!/usr/bin/env bash
set -Eeuo pipefail

app_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
compose_file="$app_dir/deployment/docker-compose.prod.yml"
queue_paused=false
secret_files=(
  /opt/studymed/secrets/backend.env
  /opt/studymed/secrets/gateway.env
)

compose() {
  docker compose -f "$compose_file" "$@"
}

resume_on_failure() {
  status=$?
  if [ "$status" -ne 0 ] && [ "$queue_paused" = true ]; then
    set +e
    compose exec -T backend node scripts/deploy-maintenance.mjs resume
  fi
  exit "$status"
}
trap resume_on_failure EXIT

cd "$app_dir"

for secret_file in "${secret_files[@]}"; do
  if [ ! -f "$secret_file" ] || [ "$(stat -c '%a' "$secret_file")" != "600" ]; then
    echo "Deployment refused: $secret_file must be a regular mode-0600 secret file." >&2
    exit 1
  fi
done

if [ -n "$(compose ps --status running -q backend)" ]; then
  compose exec -T backend node scripts/deploy-maintenance.mjs pause
  queue_paused=true
fi

git pull --ff-only origin main
compose build
compose up -d --remove-orphans
compose exec -T backend node scripts/deploy-healthcheck.mjs

queue_paused=false
echo "Deployment completed."
