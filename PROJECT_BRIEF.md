# Gradia AI Platform — Project Brief

## What We're Building
Gradia is a **SaaS agentic AI platform built for the auto detailing industry**.
It is not a chatbot. It is a fully agentic digital office — handling voice, SMS, email, and social media through one unified brain with shared memory.

**Price:** $20/month per user
**Target customer:** Independent auto detailers and detailing shop owners

---

## The Core Idea
Gradia acts as an **executive assistant and business partner** — not just an answering machine.
It speaks as *us/we*, not *you*. Example:
> "We made $3,200 today. You did the in-person work, I handled the backend. Let's beat last week!"

Gradia knows everything about the detailing and auto world. It remembers every customer across every channel and acts on its own after human approval.

---

## Key Features

### 1. Unified Memory & Identity
- One master database linking a customer's phone, email, Instagram, Facebook
- If John emails then calls, Gradia flags: "Note: John also emailed 2 hours ago about Ceramic Coating"
- RAG system + vector embeddings (Supabase pgvector) for all transcripts and conversations
- Gradia remembers specific details: vehicle type, past services, preferences, notes

### 2. Voice, Email & SMS Agents (All Sharing One Brain)
- **Inbound receptionist:** Answers calls, handles FAQs, books appointments
- **Email lead capture:** Reads leads from Yelp/Gmail/website, drafts replies
- **SMS agent:** Outbound follow-ups and confirmations
- All agents share the same memory — no siloed conversations
- Outbound messages always include Gradia's name and role in the signature

### 3. Gradia Whisper (Voice-to-Action)
Branded voice command feature. User speaks naturally, Gradia takes action.
> "Just finished the Smith job, charge her $450 and schedule a follow-up in 6 months."

Gradia then:
1. Looks up the appointment
2. Processes the Stripe charge
3. Books the follow-up on the calendar
4. Pushes details to the CRM
5. If anything is unclear (e.g. no time given), sends a Slack notification asking for clarification

### 4. Human-in-the-Loop (HITL)
- No task executes without user approval
- Gradia pings a Slack channel with a card showing the proposed action
- User sees [Approve] or [Edit] buttons before anything is finalized

### 5. Business Intelligence Chat
Users ask questions in plain English and get live answers from the database:
> "How many leads did we capture today?"
> "How much did we make on Teslas this month?"
> "What was our top-selling package this week?"

Powered by RAG + Text-to-SQL via Vercel AI SDK

### 6. Agent Builder (Co-Pilot Mode)
- Users describe their business problem
- Gradia recommends an agent type and walks them through building it step by step
- Checklist-style UI similar to Claude Cowork
- Simple, Lovable-style interface — clean and easy to use

### 7. Onboarding Wizard
- Detailer inputs their Service Menu (prices, durations, descriptions)
- This becomes the "Business Brain" — the AI's source of truth for quotes and FAQs

---

## Tech Stack
| Layer | Tool |
|---|---|
| Frontend | Next.js (Lovable-style UI) |
| Database | Supabase (pgvector for embeddings) |
| AI / LLM | Claude (Anthropic) |
| Agentic Logic | LangGraph.js |
| Voice | Vapi |
| Email | Aurinko |
| Data Extraction | Instructor (structured JSON from AI) |
| Payments | Stripe |
| CRM Integrations | Make.com / Pipedream (Jobber, HubSpot, Pipedrive) |
| Notifications | Slack |
| Dashboard Chat | Vercel AI SDK |

---

## Roadmap

### Phase 1 — MVP ($20/mo launch)
- [ ] Onboarding wizard (service menu input)
- [ ] Unified customer identity database
- [ ] Inbound voice receptionist (Vapi)
- [ ] Email lead capture agent (Aurinko)
- [ ] Slack HITL command center (Approve/Edit cards)
- [ ] Basic Gradia Whisper (voice note → task in Slack)
- [ ] Cross-channel sync (flag when same customer contacts via multiple channels)

### Phase 2 — Scale
- [ ] Predictive lead scoring (Heat Score 🔥)
- [ ] Advanced Gradia Whisper (voice-to-billing + calendar)
- [ ] Perplexity-style analytics chat
- [ ] Deep CRM push with structured note summaries

### Phase 3 — Unicorn
- [ ] Gradia Pay (BNPL for high-ticket services like PPF/Ceramic)
- [ ] Omniscient cross-platform memory (Instagram, Facebook, Web)
- [ ] Gradia Vision (computer vision car appraisal via camera)

---

## Important Rules for Claude Code
- **Never commit `.env.local`** — it is gitignored and contains Anthropic, Supabase, and Stripe keys
- `.env.example` is committed as a placeholder template only
- Main branch = production
- Always maintain HITL — no agent should execute a billable or irreversible action without user approval
- Gradia always speaks as *we/us* in user-facing responses, never *you and I*
- All outbound messages (email/SMS) must include Gradia's name and role in the signature

---

## Current Status
- Git repo: https://github.com/trygradia-max/Gradia-ai-platform.git
- Next.js app running, Supabase connected
- Dashboard routes live
- Model deprecation warning: migrate away from `claude-3-5-haiku-latest`
