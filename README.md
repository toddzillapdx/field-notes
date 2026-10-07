# Field Notes

A weekly innovation / tech / AI column for Todd Ames (Serious Business, Wyckoff NJ). First person, three-part signals
(What happened / Why it matters / What to do next), drafted in Airtable, approved by Todd, nothing publishes without him.

Spec: the "PRD: Field Notes" doc (source of truth). This repo holds the prototype build for PRD phases 1-2 (R1-R9, R11).
Not built yet by design: website publish (R10), Gemini image automation (R12), ratings (R14).

## What lives where

| Thing | Where |
|---|---|
| Data model, Charter, feeds, logs | Airtable base `appQs2Kv7iVOg6fcW` (tables below) |
| Pipeline logic | `airtable/scripts/*.js`, pasted into Airtable "Run script" actions (see `docs/SETUP.md`) |
| Local checks of the script logic | `node test/harness.mjs` (mock base + fake feeds + fake model) |

### Airtable tables

- **Charter**: one Active record (lens, pillars, pillar keywords, voice, exclusions, downweight tags, format). Every script reads it at run time; edit it, output changes, no code change. `Decision status` says what is Decided vs Proposed.
- **Feeds**: URL, Status (Active / To validate / Suggested / Broken / Paused), Last fetched, Last error. Only Active feeds feed the column. Validation never activates a feed; Todd flips the status.
- **Items**: scraped items, dedupe key, pillar, pillar score, funding/VC downweight flag, final score.
- **Editions**: week, Status (Draft / Approved / Published), Shadow mode, opening note, hero image prompt, hero image attachment, sources, raw RSS digest (for the side-by-side).
- **Signals**: linked to Edition. The three fields, pillar, source URLs, Verified, Verification note.
- **Run log**: per step, per edition: sources used, model calls, tokens, cost, errors.

## Pipeline

Daily, 2:00 am ET (no model calls): `01-scrape` then `02-process`.
Weekly, Thursday 4:00 am ET (drafts land before Todd's morning): each stage is its own automation step so a script never hits the time limit.

| Step | Script | Model call |
|---|---|---|
| 1 Create Draft edition | `03-create-edition.js` | none |
| 2 Editor: select 3-5 signals vs last 4 published editions | `04-editor-select.js` | 1 |
| 3 Editor: write the three fields (parallel, one per signal) | `05-editor-write.js` | 1 per signal |
| 4 Verification: fetch every source, vocabulary check, block invented links | `06-verify.js` | none |
| 5 Columnist: opening note + voice pass (parallel) | `07-columnist.js` | 1 + 1 per signal |
| 6 Hero image prompt + compile Sources | `08-hero-prompt.js` | 1 |
| Friday 9 am ET approval check | `09-approval-check.js` | none |

Guard rails in code: no signal ships without a working source; links in the prose must come from the sources the signal carries
(no invented URLs); vague next steps ("keep an eye on this") fail; unverified signals are flagged `DROPPED:` and skipped (never deleted);
the columnist's rewrite is rejected (editor text kept) if it drops a link, adds a link, or quotes 15+ words.
Editions are created with `Shadow mode` ticked and status Draft. Nothing sets Approved but Todd.

Models: `claude-opus-5-5` at `effort: low`, server-side refusal fallback on (`fallbacks: "default"`; the scripts retry once without it if the API rejects the field).
Rates in the scripts ($4 / $20 per MTok) come from the Anthropic price list cached 2026-10-06; update the `RATE_*` constants if pricing changes.

## Open items

See `docs/SETUP.md` ("Before the first run").
