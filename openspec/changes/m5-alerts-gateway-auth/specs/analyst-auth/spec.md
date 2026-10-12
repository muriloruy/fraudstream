# Spec Delta

## Purpose

Authenticates analysts and admins with strong credential handling and short-lived sessions, and enforces role-based access to every gateway endpoint.

## ADDED Requirements

### Requirement: Login
`POST /auth/login` SHALL verify email and argon2id password hash and return an access token (15 min) in the body and a refresh token in an httpOnly, Secure, SameSite=Strict cookie; failures SHALL return a generic 401.

#### Scenario: Valid credentials
- **WHEN** an analyst logs in with correct credentials
- **THEN** the response has an access token and sets the refresh cookie with httpOnly, Secure and SameSite=Strict

#### Scenario: Unknown email
- **WHEN** a login uses an unknown email
- **THEN** the response is 401 with the same message as a wrong password

### Requirement: Account lockout
After 5 consecutive failed logins an account SHALL be locked for 15 minutes, and login SHALL be rate limited to 10 requests per minute.

#### Scenario: Sixth attempt locked
- **WHEN** 5 wrong passwords are submitted and then the correct one
- **THEN** the correct login is rejected with a lockout response until 15 minutes pass

### Requirement: Refresh rotation with reuse detection
`POST /auth/refresh` SHALL issue a new refresh token and revoke the old one; presenting an already-rotated token SHALL revoke the whole token family.

#### Scenario: Reuse detected
- **WHEN** a refresh token that was already rotated is presented again
- **THEN** the request returns 401 and the newest token of that family no longer works

### Requirement: Logout
`POST /auth/logout` SHALL revoke the current refresh token and clear the cookie.

#### Scenario: Refresh after logout
- **WHEN** a client refreshes after logging out
- **THEN** the response is 401

### Requirement: Role-based access
Every endpoint SHALL enforce the role from SPEC §6.8: analyst endpoints for `analyst` and `admin`, admin endpoints for `admin` only; missing or expired tokens SHALL return 401 and insufficient role 403.

#### Scenario: Analyst calls admin endpoint
- **WHEN** an analyst calls `POST /admin/dlq/replay`
- **THEN** the response is 403

#### Scenario: AuthZ matrix
- **WHEN** the automated matrix calls every endpoint as anonymous, analyst and admin
- **THEN** each response status matches the expected matrix

### Requirement: Login is audited
Successful and failed logins SHALL be written to the audit log with hashed IP.

#### Scenario: Failed login audited
- **WHEN** a login fails
- **THEN** an audit row with action `LOGIN_FAILED` and an `ip_hash` exists
