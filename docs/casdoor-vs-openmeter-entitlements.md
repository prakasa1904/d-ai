# Casdoor Pricing vs OpenMeter Entitlements

This document explains how to use Casdoor and OpenMeter together when D-AI needs paid plans, usage limits, and AI token quotas.

## Short Version

Use Casdoor for identity and commercial plan ownership.
Use OpenMeter for metered usage and entitlement enforcement.
Use D-AI as the gateway that connects both decisions before calling Casibase.

```text
Casdoor
  -> who the user is
  -> which organization the user belongs to
  -> which application the user can access
  -> optional product, plan, pricing, subscription, payment, and role mapping

OpenMeter
  -> how much usage the customer has consumed
  -> how much quota remains
  -> whether a metered entitlement is still allowed
  -> usage and quota reporting

D-AI
  -> validates D-AI API token identity
  -> maps token/account to OpenMeter customer and subject
  -> checks customer entitlement or quota before forwarding to Casibase
  -> emits usage events after success or failure
```

## Casdoor Responsibility

Casdoor is the identity and application access system.

Use Casdoor for:

- Login, registration, password, and user profile.
- Organization membership, such as `ifm`.
- Application access, such as the `casibase` application.
- Optional commercial objects such as product, plan, pricing, subscription, payment, and transaction.
- Optional role mapping, for example mapping a paid plan to a Casdoor role.

Casdoor answers questions like:

- Is this user authenticated?
- Is this user allowed to access this application?
- Which organization owns this user?
- Is this user or organization subscribed to a product plan?
- Which coarse feature tier does this account belong to, such as Free, Pro, or Enterprise?

Casdoor is not the best source of truth for LLM token quota. It should not be asked to calculate live counters such as `510 / 500` total AI tokens, daily token usage, per-token request success rate, or per-token failure metrics.

## OpenMeter Responsibility

OpenMeter is the metering, quota, and entitlement system.

Use OpenMeter for:

- Metered token usage.
- Request totals.
- Success and failure counters.
- Monthly, annual, daily, or prepaid usage limits.
- Prepaid credits or balance-style quota.
- Entitlement checks for metered resources.
- Billing and usage reports.

OpenMeter answers questions like:

- Has this token already consumed its active quota period?
- How many AI tokens did this user consume today?
- How many requests failed in the selected period?
- Does this account still have access to a metered feature?
- Should the next request be allowed or rejected?

This is the better home for AI usage limits because the decision depends on metered usage events, not only on identity or plan membership.

## How They Work Together

A common production flow is:

```text
1. User signs in through Casdoor.
2. D-AI resolves the Casdoor user, organization, and plan.
3. D-AI maps the user, organization, or D-AI token to an OpenMeter customer and usage-attribution subject.
4. D-AI checks OpenMeter customer entitlement or quota before calling Casibase.
5. If allowed, D-AI forwards the request to Casibase.
6. Casibase executes the configured model provider.
7. D-AI emits usage and request events to OpenMeter.
8. D-AI emits detailed request audit logs to ClickHouse.
```

Example mapping:

```text
Casdoor plan: Pro

OpenMeter entitlements:
  ai_tokens_monthly = 500000
  requests_per_day = 1000
  allowed_models = ["d-ai-casibase"]
  file_upload = true
```

The Casdoor plan tells D-AI which product tier the account owns.
The OpenMeter entitlement tells D-AI whether the next metered AI request is still allowed.

## What Happens On Quota Exhaustion

When the user sees an error like:

```text
Token entitlement quota limit reached (510/500)
```

the responsibility split is:

```text
500 -> OpenMeter customer entitlement limit configured for the D-AI token/account
510 -> usage total queried from the OpenMeter entitlement value
429 -> response returned by D-AI before Casibase is called
```

Casibase is not responsible for this response because the request is blocked before model execution.
Casdoor is not responsible for this response because the user is already authenticated.

## Current Local Stack

In the current local prototype:

- D-AI stores token identity and token status in `d-ai/.d-ai-state/tokens.json`.
- OpenMeter stores usage counters, request metrics, and customer entitlement values.
- ClickHouse stores detailed request logs.
- Casdoor stores users, organizations, login, profile, application config, and optional pricing/subscription data.
- Casibase stores chats, messages, files, stores, and model-provider configuration.

This means quota enforcement is OpenMeter customer-entitlement-backed for token quota, request quotas, and daily token quota. The local D-AI state file keeps token identity and status only; OpenMeter remains the quota source of truth in both local development and production.

## Production Direction

For production, prefer this split:

- Casdoor: identity, organization, application access, and optional paid subscription state.
- D-AI database: product API tokens, hashed token secrets, token ownership, token status, and token-to-OpenMeter-customer mapping.
- OpenMeter: customer entitlement definitions, quota values, usage totals, request totals, and billing or usage reports.
- ClickHouse: detailed request audit logs.
- Casibase: AI workspace, chat history, files, stores, and model execution.

Use the customer-scoped entitlement APIs, for example `/api/v2/customers/{customerIdOrKey}/entitlements/{entitlementIdOrFeatureKey}/value`. Do not build new integrations on deprecated subject entitlement APIs such as `/api/v1/subjects/{subjectIdOrKey}/entitlements`.

## What Not To Do

- Do not use Casdoor OAuth access tokens as public product API tokens for `/api/v1/chat/completions`.
- Do not store durable usage counters in D-AI token metadata.
- Do not use Casdoor pricing alone to enforce LLM token quotas.
- Do not treat ClickHouse request logs as the quota source of truth.
- Do not call Casibase first and then reject the request after model execution.

## References

- Casdoor pricing overview: https://casdoor.org/docs/pricing/overview
- Casdoor subscription: https://casdoor.org/docs/pricing/subscription
- OpenMeter entitlements overview: https://openmeter.io/docs/billing/entitlements/overview
- OpenMeter metered entitlement: https://openmeter.io/docs/billing/entitlements/entitlement
