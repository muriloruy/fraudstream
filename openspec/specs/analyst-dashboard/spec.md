# analyst-dashboard Specification

## Purpose
The web application analysts use to monitor the platform in real time, triage fraud alerts and investigate accounts, built on shared design tokens.

## Requirements

### Requirement: Login screen
The app SHALL provide a login form with field validation, error states and a lockout message, and SHALL keep the access token only in memory, renewing it via the refresh cookie.

#### Scenario: Lockout message
- **WHEN** the gateway reports the account is locked
- **THEN** the login screen shows the lockout message instead of a generic error

#### Scenario: No token in storage
- **WHEN** a user is logged in
- **THEN** `localStorage` and `sessionStorage` contain no access or refresh token

#### Scenario: Page reload keeps session
- **WHEN** a logged-in user reloads the page
- **THEN** the app obtains a new access token via refresh and stays logged in

### Requirement: Live Monitor
The `/` screen SHALL show KPI cards (tx/s, approve %, review %, decline %, p95 latency, and consumer lag for admins only), a live 15-minute chart of tx/s and decline rate, and a virtualized feed of at most 200 recent decisions with colored badges.

#### Scenario: Metrics tick updates chart
- **WHEN** a `metrics.tick` event arrives
- **THEN** the KPI cards and chart update without a page reload

#### Scenario: Lag hidden for analysts
- **WHEN** an analyst opens the Live Monitor
- **THEN** the consumer lag card is not shown

### Requirement: Alert Queue
The `/alerts` screen SHALL list alerts with score bar, decision, account, amount, merchant, country, fired-rule chips, age, status and assignee; support filters (status, min score, account), sorting and keyset "load more"; and insert new alerts at the top in real time, showing an "N new alerts" counter when scrolled down.

#### Scenario: New alert while scrolled
- **WHEN** an alert is created while the user is scrolled down
- **THEN** a counter "1 new alert" appears and clicking it scrolls to the top showing the alert highlighted

### Requirement: Alert Detail and resolution
The `/alerts/:id` screen SHALL show the transaction (masked PAN only), merchant, geo, device hash, score breakdown (rule points, anomaly features, weights, final score vs thresholds), account mini-timeline, and actions Assign to me, Confirm fraud and Mark legitimate with a required note, applied optimistically with rollback on error.

#### Scenario: Optimistic resolve rollback
- **WHEN** an analyst resolves an alert and the server returns an error
- **THEN** the status reverts to its previous value and an error toast is shown

#### Scenario: Note required
- **WHEN** the analyst submits a resolution with an empty note
- **THEN** the form shows a validation error and no request is sent

### Requirement: Account Timeline
The `/accounts/:id` screen SHALL show the profile, baseline stats, full history with decisions and ledger postings, and balance.

#### Scenario: Timeline entries
- **WHEN** an account with decisions and ledger postings is opened
- **THEN** both entry types are listed newest first

### Requirement: Accessibility and theming
All interactive components SHALL be keyboard operable with visible focus and ARIA labels, layouts SHALL be responsive, and a dark mode SHALL be available.

#### Scenario: Keyboard-only triage
- **WHEN** a user navigates the alert queue and resolves an alert using only the keyboard
- **THEN** every step is reachable and focus is always visible

### Requirement: Client-side security headers
The app SHALL be served with a Content Security Policy and SHALL not render untrusted HTML.

#### Scenario: CSP present
- **WHEN** the app's HTML is fetched
- **THEN** the response includes a `Content-Security-Policy` header disallowing inline scripts

### Requirement: Performance
The Alert Queue route SHALL achieve a Lighthouse performance score of at least 90, with route-level code splitting.

#### Scenario: Lighthouse run
- **WHEN** Lighthouse is run against the production build of `/alerts`
- **THEN** the performance score is ≥ 90
