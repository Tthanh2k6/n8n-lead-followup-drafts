# n8n-lead-followup-drafts

An n8n workflow template and zero-dependency JavaScript helper module for the pattern **"AI writes the follow-up, a human sends it"**.

Leads live in a Google Sheet. The workflow generates plain-text follow-up emails from each lead's `context` notes and creates **Gmail drafts only** (it never sends emails automatically). It is designed to be safe to re-run: sequential runs do not create a second draft for the same lead (see Limitations for overlapping runs), and a crash between "Gmail draft created" and "Google Sheet updated" is surfaced as `stuck` rather than silently retried.

## What It Does

1. **Reads rows** from a Google Sheet (`Leads` tab).
2. **Filters and deduplicates leads** in `Select leads` (`src/followup.js` / `snippets/select-leads.js`):
   - Normalizes and validates single email addresses (`normalizeEmail`).
   - Skips opted-out rows (`do_not_contact` is `yes`, `true`, `1`, or `x`, case-insensitive).
   - Skips rows that already have a `draft_id` or `status` of `drafted` or `sent`.
   - Skips rows with `status = error` (`error_needs_review`) until a human clears the status.
   - Deduplicates emails within the batch (keeping the lowest `row_number`) and against emails that already have a draft in other rows.
   - Detects rows with `status = drafting`:
     - If `claimed_at` is newer than `staleMinutes` (default `30`), skips as `in_progress`.
     - If `claimed_at` is older than `staleMinutes` (or missing), routes the row to the `stuck` branch for manual inspection.
   - Caps new drafts per execution at `maxPerRun` (default `10`).
3. **Claims each row before calling the LLM** by updating Google Sheets (`status = drafting`, `claimed_at`, `run_id`).
4. **Generates and validates the draft** via `@n8n/n8n-nodes-langchain.chainLlm` (connected to `@n8n/n8n-nodes-langchain.lmChatOpenAi`) and `Parse draft` (`snippets/parse-draft.js`), rejecting malformed JSON, empty fields, subjects over 120 characters, bodies over 2,000 characters, or unfilled placeholders (`[Name]`, `{{...}}`, `<company>`).
5. **Creates a Gmail draft** (`resource: draft`, `operation: create`) and records `status = drafted`, `draft_id`, and `drafted_at` back to the row—or records `status = error` and `last_error` if validation failed.

## Google Sheet Columns

Create a sheet tab named **`Leads`** with the following columns in row 1:

| Column | Used By | Description |
| :--- | :--- | :--- |
| `email` | Input | Lead email address (e.g. `dana@example.com`). Normalized to lowercase; invalid addresses are skipped (`invalid_email`). |
| `name` | Input | Lead name used in the prompt greeting. |
| `company` | Input | Lead company name passed to the prompt. |
| `context` | Input | Factual notes from your interaction. The prompt instructs the LLM to use **only** these notes and not invent facts. |
| `do_not_contact` | Input | Set to `yes`, `true`, `1`, or `x` (case-insensitive) to skip the row (`do_not_contact`). |
| `status` | Workflow / Human | Lifecycle state: empty (ready to draft), `drafting`, `drafted`, `sent`, or `error`. |
| `claimed_at` | Workflow | ISO-8601 timestamp written when the workflow claims the row (`status = drafting`). |
| `run_id` | Workflow | n8n `$execution.id` that claimed the row. |
| `draft_id` | Workflow | Gmail draft ID returned when the draft is created. Non-empty value prevents re-drafting. |
| `drafted_at` | Workflow | ISO-8601 timestamp written after the Gmail draft is created. |
| `last_error` | Workflow | Error reason (truncated to 200 characters) when `status = error`. |

> **Note:** n8n's Google Sheets node (v4.5) automatically exposes `row_number` on read items and uses `columnToMatchOn: "row_number"` on update operations.

## Import & Setup Steps

1. **Import the workflow:** In n8n, open **Workflows → Import from File** and select `workflows/lead-followup-drafts.json`.
2. **Configure Google Sheets:**
   - Replace `YOUR_SHEET_ID` in all four Google Sheets nodes (`Get rows`, `Update row (claim)`, `Update row (drafted)`, `Update row (error)`).
   - Attach your Google Sheets OAuth2 credential.
3. **Configure the LLM & Gmail nodes:**
   - Attach your OpenAI credential on **OpenAI Chat Model** (or replace the model node with another LangChain chat model).
   - Attach your Gmail OAuth2 credential on **Gmail**.
4. **Set your sender details:**
   - Open the **Config** node and set `senderName`, `offer`, `staleMinutes` (default `30`), and `maxPerRun` (default `10`).
5. **Test manually first:**
   - Click **Test workflow** (via **Manual Trigger**) with 1–2 test rows using `@example.com` addresses and verify the drafts appear in Gmail Drafts and the sheet rows update to `drafted`.
   - Keep **Schedule Trigger** disabled until you are satisfied with your prompt and sheet setup.

## Re-Run Guarantees & Failure States

Every failure point leaves an explicit state in the sheet so re-running the workflow never silently creates a second Gmail draft for the same lead:

| Failure / Scenario | Sheet Status Left Behind | What Happens on Next Run | How to Recover |
| :--- | :--- | :--- | :--- |
| Row is opted out (`do_not_contact = yes/true/1/x`) | Unchanged | Skipped (`do_not_contact`) | No action needed |
| Email is missing or malformed | Unchanged | Skipped (`invalid_email`) | Fix `email` in the sheet |
| Duplicate email in the same sheet | Lowest `row_number` drafted; others unchanged | Other rows skipped (`duplicate_email`) | Remove duplicate rows if desired |
| Failure **before** `Update row (claim)` completes | Empty (`""`) | Drafted normally on the next run | Automatic on next run |
| LLM returns invalid JSON, over-length text, or placeholders (`[Name]`, `{{`, `<company>`) | `status = error`, `last_error` populated (before Gmail node is reached) | Skipped (`error_needs_review`) | Inspect `last_error` and `context`, then clear `status` and `last_error` to retry |
| Crash **after** `Update row (claim)` (`status = drafting`) — either during LLM call, during Gmail draft creation, or before `Update row (drafted)` | `status = drafting`, `claimed_at` set, `draft_id` empty | Within `staleMinutes`: skipped (`in_progress`). After `staleMinutes`: routed to `Stuck — check Gmail drafts by hand` (`stuck`), **not** auto-retried | Check Gmail Drafts for the lead's email. If a draft exists, set `status = drafted` (and optionally `draft_id`); if no draft exists, clear `status` and `claimed_at` so the next run drafts it |
| Normal completion | `status = drafted`, `draft_id` set, `drafted_at` set | Skipped (`already_drafted`) | Human reviews and sends the draft in Gmail |

## Repository Structure

- `src/followup.js` — Pure CommonJS functions (`normalizeEmail`, `selectLeads`, `buildPrompt`, `parseDraft`, `claimUpdate`, `doneUpdate`, `failUpdate`).
- `snippets/select-leads.js` & `snippets/parse-draft.js` — Self-contained n8n Code node bodies generated from `src/followup.js`.
- `scripts/build-snippets.js` — Generator that builds `snippets/*.js` from `src/followup.js`.
- `workflows/lead-followup-drafts.json` — Importable n8n workflow JSON.
- `test/followup.test.js` — `node:test` suite verifying all selection rules, boundary conditions, prompt/parser rules, snippet consistency, and workflow structure.

## Running Tests

Requires Node.js 18+ (uses built-in `node:test` and `node:assert/strict`, zero npm dependencies):

```bash
npm test
# or directly:
node --test
```

To regenerate the n8n Code node snippets after editing `src/followup.js`:

```bash
npm run build:snippets
```

## Limitations

- **Verification scope:** The JavaScript logic (`src/followup.js` and `snippets/*.js`) is tested with `node:test` and the n8n workflow JSON structure is validated by tests, and the workflow passed n8n-mcp `validate_workflow` with 0 errors and 0 warnings (11 Nov 2026). The author has not yet run it end-to-end against live Gmail and Google Sheets accounts; treat the first run as a test on a copy of your sheet.
- **LLM output quality:** Even with strict prompt rules and placeholder checks, an LLM can still phrase things awkwardly or misinterpret terse `context` notes. Always review every Gmail draft before sending.
- **No row-level locking in Google Sheets:** Google Sheets does not provide atomic compare-and-set or row locks. If two workflow executions overlap in time, both could read the same unclaimed rows before either writes `status = drafting`. Keep the schedule interval longer than the worst-case execution time (e.g., 30 minutes for a batch of 10 rows) and do not run overlapping executions concurrently.

## License

MIT © 2026 Trung Thanh Tran
