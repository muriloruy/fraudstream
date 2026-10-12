-- One schema and one least-privilege login role per service (SPEC §5, §7 Req. 7).
-- Each role owns only its own schema(s) and cannot read any other service's data.
-- Run once by the postgres image on first start (see initdb.sh, which supplies the
-- passwords as psql variables parsed from the DATABASE_URL_* entries of .env).
\set ON_ERROR_STOP on

-- Nobody gets implicit access: connect and the public schema are granted explicitly.
REVOKE ALL ON DATABASE fraudstream FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM PUBLIC;

CREATE ROLE payments_svc    LOGIN PASSWORD :'payments_password';    -- transaction-api, outbox-relay
CREATE ROLE vault_svc       LOGIN PASSWORD :'vault_password';       -- card-vault
CREATE ROLE fraud_rules_svc LOGIN PASSWORD :'fraud_rules_password'; -- fraud-rules
CREATE ROLE anomaly_svc     LOGIN PASSWORD :'anomaly_password';     -- anomaly-scorer
CREATE ROLE decision_svc    LOGIN PASSWORD :'decision_password';    -- decision-engine
CREATE ROLE ledger_svc      LOGIN PASSWORD :'ledger_password';      -- ledger
CREATE ROLE alerts_svc      LOGIN PASSWORD :'alerts_password';      -- alerts-gateway
-- Read-only auditor for `pnpm ledger:reconcile`; owners grant it SELECT in their migrations.
CREATE ROLE reconciler      LOGIN PASSWORD :'reconciler_password';

GRANT CONNECT ON DATABASE fraudstream TO
  payments_svc, vault_svc, fraud_rules_svc, anomaly_svc, decision_svc, ledger_svc, alerts_svc,
  reconciler;

CREATE SCHEMA payments    AUTHORIZATION payments_svc;
CREATE SCHEMA vault       AUTHORIZATION vault_svc;
CREATE SCHEMA fraud_rules AUTHORIZATION fraud_rules_svc;
CREATE SCHEMA anomaly     AUTHORIZATION anomaly_svc;
CREATE SCHEMA decision    AUTHORIZATION decision_svc;
CREATE SCHEMA ledger      AUTHORIZATION ledger_svc;
CREATE SCHEMA alerts      AUTHORIZATION alerts_svc;
CREATE SCHEMA auth        AUTHORIZATION alerts_svc;

-- auth.users.email is citext (SPEC §5.7); install it where its only user can see it.
CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA auth;

-- Unqualified names resolve to the service's own schema.
ALTER ROLE payments_svc    SET search_path = payments;
ALTER ROLE vault_svc       SET search_path = vault;
ALTER ROLE fraud_rules_svc SET search_path = fraud_rules;
ALTER ROLE anomaly_svc     SET search_path = anomaly;
ALTER ROLE decision_svc    SET search_path = decision;
ALTER ROLE ledger_svc      SET search_path = ledger;
ALTER ROLE alerts_svc      SET search_path = alerts, auth;
ALTER ROLE reconciler      SET search_path = ledger, decision;
-- Defence in depth on top of SELECT-only grants: the reconciler cannot write even by mistake.
ALTER ROLE reconciler      SET default_transaction_read_only = on;
