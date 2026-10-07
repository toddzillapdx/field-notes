# Setup: wiring the automations in Airtable

The Airtable connection used to build this had no automation-write permission, so the automations were not created
automatically. The tables, Charter and feeds are already in the base. Wiring the automations by hand takes about 20 minutes.
Create all of them **off**, test each step with Airtable's "Test" button, then turn them on.

## Before the first run

1. **Anthropic API key.** Create a key, then in each automation step that needs it add a secret named exactly
   `ANTHROPIC_API_KEY` (script action > Secrets). Needed on steps 2, 3, 5, 6 of the weekly automation (scripts 04, 05, 07, 08).
   The key never goes in the repo, the base, or chat.
2. **Confirm the Charter.** Open Charter > "Field Notes Charter v0.1". Lens, pillars, Thursday publishing, edition shape and the feed list are *Proposed*.
3. **Approve feeds.** Feeds with status To validate / Suggested are fetched nightly for validation only (see their Notes). Set Status = Active to include one.
4. **Script time limit.** Airtable documents a per-run limit for script actions (30 seconds as of the last docs I know of; this was not re-verified from here).
   Steps 3 and 5 run their model calls in parallel to stay under it. If a step times out, tell me which; the fallback in the PRD is GitHub Actions.

## Automation A: "Field Notes: daily scrape and score"

- Trigger: At a scheduled time, every day, 2:00 am, time zone America/New_York.
- Action 1: Run script, paste `airtable/scripts/01-scrape.js`. No inputs.
- Action 2: Run script, paste `airtable/scripts/02-process.js`. No inputs.

## Automation B: "Field Notes: weekly draft"

- Trigger: At a scheduled time, weekly on Thursday, 4:00 am (time zone America/New_York; if the picker only offers UTC use 8:00 am UTC, which is 4:00 am EDT / 3:00 am EST).
- Action 1: Run script `03-create-edition.js`. Outputs: `editionId`, `week`.
- Action 2: Run script `04-editor-select.js`. Input `editionId` = Action 1 > editionId. Secret ANTHROPIC_API_KEY. Outputs: `picks`, `count`.
- Action 3: Run script `05-editor-write.js`. Inputs `editionId` = Action 1 > editionId, `picks` = Action 2 > picks. Secret ANTHROPIC_API_KEY.
- Action 4: Run script `06-verify.js`. Input `editionId` = Action 1 > editionId.
- Action 5: Run script `07-columnist.js`. Input `editionId`. Secret ANTHROPIC_API_KEY.
- Action 6: Run script `08-hero-prompt.js`. Input `editionId`. Secret ANTHROPIC_API_KEY.

## Automation C: "Field Notes: approval check"

- Trigger: weekly, Friday, 9:00 am ET.
- Action 1: Run script `09-approval-check.js`. Outputs `alert`, `message`.
- Action 2: Conditional (alert is true) > Send email to Todd with `message`. The recipient is not set here on purpose; pick it in the UI.
  Shadow-mode editions never alert.

## Shadow mode (R9)

Every new Edition is created with Shadow mode ticked. For the first two editions Todd compares the Draft against `Raw RSS digest` on the same record.
Hero image: paste `Hero image prompt` into Gemini, then upload the result to `Hero image` yourself.

## Local check

`node test/harness.mjs` runs every script against a mock base, fake feeds and a fake model. It checks the logic, not real Airtable or real model output.
