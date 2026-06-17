/**
 * Golden fixtures for the Customer Recovery extraction worker (P8 / NEXT-3,
 * GRADIA_CUSTOMER_RECOVERY_SPEC §2.1 — "Eval fixtures FIRST").
 *
 * Each fixture is a real-shaped email thread (or contact) an auto-detailing
 * shop would have in their inbox, paired with the structured extraction we
 * expect. The worker doesn't ship until it passes against these.
 *
 * Categories deliberately span the spec's hard cases: quote request, booking
 * confirmation, completed job, ghosted lead, multi-vehicle, email-only,
 * referral with multiple numbers, reschedule, AND vendor spam that slipped the
 * pre-filter (which must come back low-confidence so code drops it).
 *
 * This is the foundation set; the spec calls for 30+. Grow it as real imports
 * surface new shapes — never shrink the bar.
 *
 * `direction` mirrors the customer's furthest progress in the thread:
 *   inquiry  — asked a question, no price given
 *   quote    — a price was quoted, not yet booked
 *   booked   — an appointment was agreed/confirmed
 *   completed— the job was done (and/or paid)
 */

import type { RecoveryExtraction } from "@/lib/recovery/extract"

export type RecoveryFixture = {
  id: string
  category: string
  /** Raw thread as it would arrive from the .mbox parse (headers + body text). */
  thread: string
  golden: RecoveryExtraction
}

export const RECOVERY_FIXTURES: RecoveryFixture[] = [
  {
    id: "quote-ceramic",
    category: "quote request",
    thread: `From: Marcus Webb <marcus.webb88@gmail.com>
To: Pristine Detailing <hello@pristinedetail.com>
Subject: Ceramic coating quote — Model 3
Date: Tue, 4 Mar 2026 14:22:00 -0800

Hey, saw your work on Instagram. I've got a 2021 Tesla Model 3 (white) and
I'm interested in a ceramic coating. What would that run me? My cell is
(415) 555-0142 if it's easier to text.

Thanks,
Marcus

From: Pristine Detailing <hello@pristinedetail.com>
To: Marcus Webb <marcus.webb88@gmail.com>
Subject: Re: Ceramic coating quote — Model 3
Date: Tue, 4 Mar 2026 16:05:00 -0800

Hi Marcus — for a Model 3, our 2-year ceramic package is $1,200 including a
full paint decon and one-step polish. Want me to get you on the calendar?`,
    golden: {
      name: "Marcus Webb",
      phones: ["(415) 555-0142"],
      emails: ["marcus.webb88@gmail.com"],
      vehicle: "2021 Tesla Model 3, white",
      services_mentioned: ["ceramic coating", "paint decon", "polish"],
      last_interaction_at: "2026-03-04",
      direction: "quote",
      confidence: 0.95,
    },
  },
  {
    id: "booking-confirmed",
    category: "booking confirmation",
    thread: `From: Dana Reyes <dana.reyes@outlook.com>
To: Pristine Detailing <hello@pristinedetail.com>
Subject: Re: Saturday detail
Date: Thu, 12 Feb 2026 09:10:00 -0800

Perfect, Saturday at 9am works. See you then. It's the silver Audi Q5.
Address is fine, I'll come to the shop.

From: Pristine Detailing
To: Dana Reyes <dana.reyes@outlook.com>
Subject: Re: Saturday detail
Date: Wed, 11 Feb 2026 18:40:00 -0800

Great — you're booked for a full interior + exterior detail, Sat 9am. $250.`,
    golden: {
      name: "Dana Reyes",
      phones: [],
      emails: ["dana.reyes@outlook.com"],
      vehicle: "silver Audi Q5",
      services_mentioned: ["full interior detail", "exterior detail"],
      last_interaction_at: "2026-02-12",
      direction: "booked",
      confidence: 0.93,
    },
  },
  {
    id: "completed-paid",
    category: "completed job",
    thread: `From: Tariq Nelson <tariq.n@gmail.com>
To: Pristine Detailing <hello@pristinedetail.com>
Subject: Re: Your invoice from Pristine Detailing
Date: Mon, 6 Jan 2026 11:02:00 -0800

Paid — thanks again, the truck looks unreal. Will definitely be back for the
ceramic in spring. Text me at 628-555-0199 when you run any specials.

From: Pristine Detailing
To: Tariq Nelson <tariq.n@gmail.com>
Subject: Your invoice from Pristine Detailing
Date: Sat, 4 Jan 2026 15:20:00 -0800

Thanks for coming in, Tariq! Attached is your paid receipt for the paint
correction on the F-150. — Gradia at Pristine Detailing`,
    golden: {
      name: "Tariq Nelson",
      phones: ["628-555-0199"],
      emails: ["tariq.n@gmail.com"],
      vehicle: "Ford F-150",
      services_mentioned: ["paint correction", "ceramic coating"],
      last_interaction_at: "2026-01-06",
      direction: "completed",
      confidence: 0.96,
    },
  },
  {
    id: "ghosted-lead",
    category: "ghosted lead",
    thread: `From: Priya Shah <priya.shah212@gmail.com>
To: Pristine Detailing <hello@pristinedetail.com>
Subject: PPF for a new car
Date: Fri, 19 Sep 2025 13:45:00 -0700

Hi! Do you do paint protection film? Just picked up a 2025 BMW X5 and want the
front end protected. Roughly what does that cost?

From: Pristine Detailing
To: Priya Shah <priya.shah212@gmail.com>
Subject: Re: PPF for a new car
Date: Fri, 19 Sep 2025 14:30:00 -0700

Hi Priya! Yes — a front-end PPF package on the X5 runs about $1,500. Happy to
book you in. (No reply received.)`,
    golden: {
      name: "Priya Shah",
      phones: [],
      emails: ["priya.shah212@gmail.com"],
      vehicle: "2025 BMW X5",
      services_mentioned: ["paint protection film"],
      last_interaction_at: "2025-09-19",
      direction: "quote",
      confidence: 0.9,
    },
  },
  {
    id: "multi-vehicle",
    category: "multi-vehicle household",
    thread: `From: Greg Olsen <golsen.home@gmail.com>
To: Pristine Detailing <hello@pristinedetail.com>
Subject: Two cars
Date: Sat, 22 Nov 2025 08:15:00 -0800

Morning — looking to get both our cars done before the holidays. A 2019 Honda
Pilot (kids destroyed the interior) and my 2022 Corvette (just exterior, be
gentle). Cell is 415.555.0177.`,
    golden: {
      name: "Greg Olsen",
      phones: ["415.555.0177"],
      emails: ["golsen.home@gmail.com"],
      vehicle: "2019 Honda Pilot; 2022 Chevrolet Corvette",
      services_mentioned: ["interior detail", "exterior detail"],
      last_interaction_at: "2025-11-22",
      direction: "inquiry",
      confidence: 0.88,
    },
  },
  {
    id: "email-only-no-phone",
    category: "email-only",
    thread: `From: l.tran.sf@gmail.com
To: Pristine Detailing <hello@pristinedetail.com>
Subject: interior detail availability
Date: Wed, 8 Oct 2025 19:55:00 -0700

Do you have any openings next week for an interior-only detail? Honda Civic,
nothing crazy, just need it freshened up. Thanks - Linh`,
    golden: {
      // The body only supports the first name; the surname lives in the email
      // local-part and inferring it would be a guess (the worker won't, rightly).
      name: "Linh",
      phones: [],
      emails: ["l.tran.sf@gmail.com"],
      vehicle: "Honda Civic",
      services_mentioned: ["interior detail"],
      last_interaction_at: "2025-10-08",
      direction: "inquiry",
      confidence: 0.82,
    },
  },
  {
    id: "referral-two-numbers",
    category: "referral / multiple numbers",
    thread: `From: Sofia Mendez <sofia.mendez.realtor@gmail.com>
To: Pristine Detailing <hello@pristinedetail.com>
Subject: Referral + my own car
Date: Mon, 15 Dec 2025 10:30:00 -0800

Hi! My colleague raved about you. I'd love to book my own car (2020 Lexus RX,
full detail) and my work line is 415-555-0188, personal is 415-555-0190 if you
can't reach me at the office.`,
    golden: {
      name: "Sofia Mendez",
      phones: ["415-555-0188", "415-555-0190"],
      emails: ["sofia.mendez.realtor@gmail.com"],
      vehicle: "2020 Lexus RX",
      services_mentioned: ["full detail"],
      last_interaction_at: "2025-12-15",
      direction: "inquiry",
      confidence: 0.9,
    },
  },
  {
    id: "reschedule",
    category: "reschedule",
    thread: `From: Aaron Cole <acole.work@gmail.com>
To: Pristine Detailing <hello@pristinedetail.com>
Subject: Re: Appt confirmation
Date: Thu, 30 Oct 2025 07:40:00 -0700

Something came up — can we move my Thursday ceramic appointment to next
Monday? Same car, the black Tahoe. 510-555-0123.`,
    golden: {
      name: "Aaron Cole",
      phones: ["510-555-0123"],
      emails: ["acole.work@gmail.com"],
      vehicle: "black Chevrolet Tahoe",
      services_mentioned: ["ceramic coating"],
      last_interaction_at: "2025-10-30",
      direction: "booked",
      confidence: 0.91,
    },
  },
  {
    id: "spam-newsletter-slipped",
    category: "vendor spam (slipped filter)",
    thread: `From: Deals <promotions@autopartswholesale.com>
To: hello@pristinedetail.com
Subject: 🔥 30% off detailing chemicals this week only!
Date: Tue, 2 Dec 2025 06:00:00 -0800

Stock up and save! Use code DETAIL30 at checkout. Free shipping over $99.
Call our sales team at 1-800-555-0100. Unsubscribe any time.`,
    golden: {
      name: null,
      phones: [],
      emails: [],
      vehicle: null,
      services_mentioned: [],
      last_interaction_at: "2025-12-02",
      direction: "inquiry",
      confidence: 0.05,
    },
  },
  {
    id: "spam-cold-saas",
    category: "vendor spam (cold outreach)",
    thread: `From: Jordan @ BookFlow <jordan@bookflowapp.io>
To: hello@pristinedetail.com
Subject: Quick question about Pristine Detailing's scheduling
Date: Wed, 14 Jan 2026 09:12:00 -0800

Hi there — I help detailing shops cut no-shows by 40% with automated booking.
Open to a 15-min call this week? Happy to send a Calendly link.`,
    golden: {
      name: null,
      phones: [],
      emails: [],
      vehicle: null,
      services_mentioned: [],
      last_interaction_at: "2026-01-14",
      direction: "inquiry",
      confidence: 0.05,
    },
  },
  {
    id: "old-customer-2024",
    category: "old customer (EBR boundary)",
    thread: `From: Bianca Rossi <bianca.rossi@gmail.com>
To: Pristine Detailing <hello@pristinedetail.com>
Subject: Re: Thanks!
Date: Sun, 11 Aug 2024 16:20:00 -0700

The Macan looks brand new, thank you! Worth every penny of the $450. I'll
spread the word. Reach me at 415-555-0166 anytime.`,
    golden: {
      name: "Bianca Rossi",
      phones: ["415-555-0166"],
      emails: ["bianca.rossi@gmail.com"],
      vehicle: "Porsche Macan",
      services_mentioned: ["full detail"],
      last_interaction_at: "2024-08-11",
      direction: "completed",
      confidence: 0.94,
    },
  },
  {
    id: "contact-card-vcf",
    category: "contact card (no thread)",
    thread: `Source: contacts.vcf
FN: Mike "Detailing" Sandoval
TEL;TYPE=CELL: +1 (650) 555-0133
EMAIL: mike.sandoval.cars@gmail.com
NOTE: Did his GTI ceramic Jan 2025, wants the wife's Tahoe next`,
    golden: {
      name: "Mike Sandoval",
      phones: ["+1 (650) 555-0133"],
      emails: ["mike.sandoval.cars@gmail.com"],
      vehicle: "Volkswagen GTI",
      services_mentioned: ["ceramic coating"],
      last_interaction_at: "2025-01-01",
      direction: "completed",
      confidence: 0.8,
    },
  },
]
