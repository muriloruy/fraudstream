#!/usr/bin/env bash
# Postgres first-start hook: runs init-roles.sql with one password per service role.
# Passwords come from the DATABASE_URL_<SERVICE> variables in .env, so each service's
# connection string is the single source of truth for its credentials.
set -euo pipefail

password_from_url() {
  local var="DATABASE_URL_$1" url
  url="${!var:-}"
  if [[ -z "$url" ]]; then
    echo "initdb: $var is not set (copy .env.example to .env)" >&2
    exit 1
  fi
  # postgres://user:password@host:port/db -> password
  sed -E 's#^[a-z]+://[^:]+:([^@]*)@.*$#\1#' <<<"$url"
}

args=()
for service in PAYMENTS VAULT FRAUD_RULES ANOMALY DECISION LEDGER ALERTS; do
  args+=(-v "${service,,}_password=$(password_from_url "$service")")
done

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  "${args[@]}" -f /infra/postgres/init-roles.sql
