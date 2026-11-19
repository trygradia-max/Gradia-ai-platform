# Gradia investor demo runbook

Use this for a protected preview or local environment. Do not use a real customer shop, real phone numbers, or production provider credentials.

## Prepare once

1. Create or select a clearly labeled demo shop through normal onboarding.
2. Point `.env.local` at local Supabase. For a protected hosted preview, verify the project and shop ID twice.
3. Seed the synthetic shop:

   ```bash
   npm run seed:smoke -- --shop <SHOP_ID>
   ```

   A hosted preview also requires the deliberate `--allow-remote` flag. The script refuses remote writes without it.
4. Sign in as the demo-shop owner and keep the app in a private browser window. Never expose keys, provider dashboards, or internal logs on screen.

## Twelve-minute story

### 1. The operating picture — 90 seconds

Open the dashboard. Show one system of record for leads, work awaiting approval, active work, and recent customer activity. The point is not another chatbot; Gradia sees operational state and knows what needs attention.

### 2. CRM through completed work — 2 minutes

Open the seeded customers, vehicles, quote, and calendar jobs. Show that the same customer context follows the work from inquiry to quote to scheduled service and payment status.

### 3. Human-governed action — 90 seconds

Open `/approvals`. Review the `SMOKE: Pat Walk-in` proposal and approve it. Confirm that the lead appears in the CRM only after approval. Explain that high-impact actions are proposed, reviewed, and audited rather than silently executed.

### 4. Build a governed agent — 4 minutes

Open `/agents/build` and create **Ceramic quote recovery** through the actual seven steps:

- Job: recover quoted ceramic-coating leads who never booked.
- Schedule: daily during shop hours.
- Tools: CRM read plus draft SMS; do not grant unrestricted sending.
- Knowledge: select only owner-reviewed shop knowledge.
- Limits: small recipient cap, cooldown, monthly budget, approval required.
- Test: run the deterministic governance checks against the exact saved revision. Point out that these checks validate policy, limits, tools, and stop-condition structure; they do not inspect a live audience or score model writing quality.
- Activate: explain that activation is bound to the immutable revision, evaluation evidence, memory pins, connector state, and commercial entitlement.

Open Cy's recorded `STOP` interaction separately as the business evidence behind the stop condition. Do not claim that the Test screen itself queried or excluded Cy.

Do not imply that a blocked activation is a failure. The block is the product proving it will not run without its required evidence.

### 5. Close the loop — 2 minutes

Show the revision history, reviewed memory, activity evidence, and billing/usage surfaces. Explain the loop: observe work, reason over approved context, propose or execute within policy, record the outcome, and improve the next workflow without losing human control.

## Demo claims that are safe to make

- Gradia has tenant-scoped CRM, quoting, scheduling, approvals, reviewed memory, immutable agent revisions, evaluation gates, and usage-led commercial controls in the product architecture.
- The demo uses synthetic records and real product paths.
- The current Test step is an offline governance-contract evaluation, not an answer-quality score or live-audience simulation.
- Provider delivery and payments should be described as live only after their sandbox acceptance has passed in the environment being shown.
- Never claim an integration, autonomous action, or production deployment that has not been verified in that environment.

## Reset

Run the same seed command to replace prior marked demo rows, or remove them with:

```bash
npm run seed:smoke -- --shop <SHOP_ID> --clean-only
```

For a hosted preview, include `--allow-remote`. Settings → Developer → **Clear demo data** can also remove the marked rows.
