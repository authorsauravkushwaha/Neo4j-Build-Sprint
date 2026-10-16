# Privacy policy and terms — templates

This document is a **starting point**, not legal advice. Fill in the bracketed fields, publish it wherever
your deployment can link to it, and have someone qualified review it if you run this for other people or in
a jurisdiction with specific requirements (GDPR, DPDP Act, CCPA, FERPA, and similar).

The app's in-app pages (`/privacy` in the running build) mirror the structure below and describe the
default configuration. If you change what your deployment collects, change both.

---

## PRIVACY POLICY (template)

**Last updated: [DATE]**

### Who we are

GraphMentor AI is operated by **[YOUR NAME OR ORGANISATION]**, contactable at **[CONTACT EMAIL]**. It is a
free study-planning tool for engineering students and early-career engineers. It is not affiliated with any
university, employer, or the education providers it links to.

### What we collect

We collect as little as possible, and only in the two situations below.

**1. Always (no account required).** Data your own browser stores on your device:

| Data | Where it lives | Why |
| --- | --- | --- |
| Onboarding answers (education level, branch, interests, weekly study hours, pace, learning style) | your device's local storage | to size and order your study plan |
| Self-reported skill levels and quiz scores | local storage | to compute your skill gaps |
| Roadmap task statuses, logged hours and short notes | local storage | so your progress survives a refresh |
| Bookmarks and display preferences (theme, reduced motion) | local storage | so the app looks and behaves the way you set it |
| Feedback drafts written in browser demo mode, when no backend is configured | local storage | so a report is not lost; it is never sent anywhere automatically |

This data does not leave your device unless you sign in and explicitly save a plan to your account. It
contains no passwords, no tokens and no chat transcripts.

One detection worth stating plainly: turning on the theme or reduced-motion preference writes a cookie-free
localStorage key, nothing more. There is no analytics identifier of any kind.

**2. If you sign in (optional).** Data stored on our servers, tied to your user id:

| Data | Why | Kept until |
| --- | --- | --- |
| Your email address | to identify your account and to send sign-in or reset links | you ask for it to be removed (see below) |
| A password **hash**, if you sign in with a password | to authenticate you. The app itself never receives or stores the password — the identity provider hashes it | you change or remove it |
| Session tokens (access + refresh) in your browser's local storage under `gm.auth` | to keep you signed in. They are credentials: signing out clears them, and "sign out everywhere" revokes them server-side | sign-out, revocation, or expiry |
| Saved roadmaps and their task progress | so your plan follows you to another device | you delete them |
| Self-reported skill ratings you choose to sync | so the analyzer works across devices | you delete them |
| Bookmarks | so they follow you between devices | you delete them |
| Profile preferences (goal career, weekly hours, pace, learning style) | plan generation | you delete them |
| Feedback you submit, and the contact email if you provide one | to fix what you reported | **[RETENTION PERIOD, e.g. 12 months]** |
| A **hashed** form of your email during sign-in attempts, used only to count attempts per address | to slow down password guessing. The plain address is hashed in the browser before it is sent, and hashed again before it is stored as a counter key — the counter cannot be read back as an address | the rate-limit window ends (minutes) |
| A **hashed** form of the requesting network address, used to count attempts per network | same purpose, at the network level | the rate-limit window ends (minutes) |

**3. What we never collect.** No name, no phone number, no address, no date of birth, no government
identifier, no résumé or document upload, no payment details (the tool is free), no location data, no
contacts, no camera or microphone access, no advertising identifier.

### What we do not do

- **No advertising, no ad networks, no affiliate links, no sponsored placement.** The resource list has no
  monetisation path.
- **No password or token is ever placed in a link, an email or a log.** Sign-in failures, reset requests and
  registration conflicts are worded so they do not reveal whether an address has an account here.
- **No third-party analytics and no telemetry** in the shipped code. We do not use session recording,
  heatmaps, or tracking pixels. If your deployment adds any, this policy must say so, and the app should ask
  first.
- **No selling, renting or sharing** personal data with anyone, for any purpose.
- **No profiling, scoring or automated decisions** about you. The recommendation engine orders study topics;
  it does not evaluate you as a person and does not produce a score that anyone else can see.
- **No emails other than the ones you ask for** (sign-in links, and replies if you wrote to us).

### Who processes data on our behalf

Depending on your deployment's configuration, the following processors may be involved. Each receives only
what is strictly necessary:

| Provider | Purpose | Notes |
| --- | --- | --- |
| Supabase | authentication, database, API (Edge Functions) | stores your account email and the synced rows listed above |
| Neo4j AuraDB | the curriculum knowledge graph | contains **only** public curriculum content, never personal data |
| **[AI PROVIDER, if configured]** | rewording mentor answers | receives your question and the relevant **graph context**; see the note below |
| **[HOST, e.g. GitHub Pages / Netlify]** | serves the static app | sees standard request logs (IP, user agent) under their own policy |

**If an AI provider is enabled**, your question — and the graph facts related to it — are sent to that
provider to be phrased as an answer. Do not type personal or sensitive information into the mentor. With
`AI_PROVIDER=none` (the default), nothing is sent to any AI provider and answers come from a local rules
engine, which the interface states in the answer itself.

### Two account actions that are easy to confuse

- **Delete account data** (Settings → Your data) deletes your saved roadmaps, task progress, skill ratings,
  bookmarks, profile and feedback rows. Your login stays active, because deleting an identity-provider user
  requires a server-side key this app never holds. The screen says exactly that.
- **Delete the login itself** removes the email address as well. This is a manual step: ask the operator
  through the feedback form, or — if you run your own deployment — delete the user in the Supabase
  dashboard. The template below makes that a commitment rather than a footnote: **[RESPONSE TIME, e.g.
  within 30 days]**.

Before either, **Export** gives you a JSON file with both copies: this device's data and the account's.

### Your rights

You do not need to contact anyone to exercise these — **Settings** implements them:

- **Access and portability:** "Export device data" and the account export produce JSON files containing
  everything held about you, with the device and server copies clearly separated.
- **Erasure:** "Delete account data" removes your server-side rows; "Erase local data" clears everything in
  this browser.
- **Correction:** edit your profile, ratings and progress at any time; nothing is hidden or write-only.
- **Objection / restriction:** sign out and use the app as a guest; no account is required for any feature.

If you believe your data has been mishandled, contact **[CONTACT EMAIL]**. **[ADD THE APPLICABLE
REGULATORY CONTACT FOR YOUR JURISDICTION IF YOU NEED ONE.]**

### Children

The app is intended for learners at university level and above. It is not directed at children under
**[13 / 16 / the age in your jurisdiction]**, and we do not knowingly collect data from them.

### Security

See [security.md](security.md) for the implemented controls: row-level security scoping every private row
to its owner, parameterised queries only, rate limiting, replay protection, no secrets in the client, and
error responses that never leak internals. No system is perfectly secure, and this one has not had an
external security review.

### Changes

If this policy changes materially (a new processor, a new category of data), we will note it in the
repository's changelog and update the date above. Continued use after a change means you accept it.

---

## TERMS OF USE (template)

### What this service is

A free tool that helps you plan the order in which to study engineering topics, based on a curated
knowledge graph. It is an educational aid.

### What it is not

- **Not a guarantee of anything.** Using it does not guarantee employment, an internship, a promotion, a
  salary level, admission, or mastery. It does not create any legal or professional relationship.
- **Not professional advice.** No legal, medical, immigration, tax or financial advice is offered or implied.
- **Not an accredited course.** No credits, certificates or qualifications are issued.
- **Not a substitute for supervision.** Where a project involves mains voltage, soldering, machinery,
  chemicals or cloud spending, the safety notes are reminders, not instructions — follow your institution's
  rules and do not work alone on anything hazardous.

### Accuracy

The curriculum is curated by hand and the resource links are checked periodically, with the check date
shown in the app. Content still goes stale: providers move or paywall things, syllabi change, and local job
markets differ. Verify anything you rely on. If you find an error, report it from Settings → *Report a
problem*.

### Acceptable use

Do not use the service to break the law, to attack or overload the infrastructure, to scrape it at volume,
to upload malicious content, to attempt to access other users' data, or to resell it as your own product.
Rate limits exist and are enforced. Access may be limited if a deployment is being abused.

### Your content

You keep ownership of what you write (notes, feedback, profile text). You grant the operator only the
permission needed to store it and show it back to you. Feedback you submit may be used to fix the problem
you reported.

### Availability and changes

The service is provided as-is, without warranty, on free infrastructure with no uptime guarantee. Features
may change or be removed, and a deployment may be shut down. Keep your own copy of anything you care about —
the export button exists for exactly that reason.

### Limitation of liability

To the extent permitted by law, the operator is not liable for indirect or consequential losses arising from
use of the service, including lost study time, missed opportunities, or decisions made from the
information shown. Nothing here excludes liability that cannot be excluded by law.

### Governing law

**[YOUR JURISDICTION]**.

---

## Deployment checklist for these documents

- [ ] Replace every `[BRACKETED]` field.
- [ ] Set the retention period for feedback you actually plan to keep.
- [ ] If you enable an AI provider, name it in the processors table **and** in the app's `/privacy` page.
- [ ] If you add analytics or a CDN with logging, disclose it and update the in-app copy.
- [ ] Publish the policy at a stable URL and link it from the site footer, the app's Settings screen, and the
      Android store listing (a privacy-policy URL is required for a Play Store release).
- [ ] Review it again if you start collecting anything new. The app's data-export screen is the fastest way
      to check what is actually being stored.


