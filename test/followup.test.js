'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  normalizeEmail,
  selectLeads,
  buildPrompt,
  parseDraft,
  claimUpdate,
  doneUpdate,
  failUpdate,
} = require('../src/followup');

const { buildSnippets } = require('../scripts/build-snippets');

const NOW_MS = Date.parse('2026-05-01T12:00:00.000Z');
const NOW_ISO = '2026-05-01T12:00:00.000Z';

test('normalizeEmail trims and lowercases valid single email addresses', () => {
  assert.equal(normalizeEmail('  Alice.Smith+tag@Example.COM  '), 'alice.smith+tag@example.com');
  assert.equal(normalizeEmail('bob@sub.example.com'), 'bob@sub.example.com');
});

test('normalizeEmail rejects non-strings, empty strings, spaces, commas, and malformed addresses', () => {
  assert.equal(normalizeEmail(null), null);
  assert.equal(normalizeEmail(undefined), null);
  assert.equal(normalizeEmail(42), null);
  assert.equal(normalizeEmail(''), null);
  assert.equal(normalizeEmail('   '), null);
  assert.equal(normalizeEmail('aliceexample.com'), null);
  assert.equal(normalizeEmail('alice@@example.com'), null);
  assert.equal(normalizeEmail('alice@localhost'), null);
  assert.equal(normalizeEmail('alice@.example.com'), null);
  assert.equal(normalizeEmail('alice@example.com.'), null);
  assert.equal(normalizeEmail('alice@example..com'), null);
  assert.equal(normalizeEmail('.alice@example.com'), null);
  assert.equal(normalizeEmail('alice.@example.com'), null);
  assert.equal(normalizeEmail('alice..bob@example.com'), null);
  assert.equal(normalizeEmail('alice@example.c'), null);
  assert.equal(normalizeEmail('alice@-example.com'), null);
  assert.equal(normalizeEmail('alice smith@example.com'), null);
  assert.equal(normalizeEmail('alice@example.com, bob@example.com'), null);
  assert.equal(normalizeEmail('<alice@example.com>'), null);
});

test('selectLeads skips rows with truthy do_not_contact values (case-insensitive)', () => {
  const rows = [
    { row_number: 2, email: 'a@example.com', do_not_contact: 'yes' },
    { row_number: 3, email: 'b@example.com', do_not_contact: 'TRUE' },
    { row_number: 4, email: 'c@example.com', do_not_contact: '1' },
    { row_number: 5, email: 'd@example.com', do_not_contact: 'X' },
    { row_number: 6, email: 'e@example.com', do_not_contact: '' },
  ];

  const result = selectLeads(rows, { nowMs: NOW_MS });
  assert.equal(result.toDraft.length, 1);
  assert.equal(result.toDraft[0].email, 'e@example.com');
  assert.equal(result.skipped.length, 4);
  for (const item of result.skipped) {
    assert.equal(item.reason, 'do_not_contact');
  }
});

test('selectLeads skips rows with invalid email addresses', () => {
  const rows = [
    { row_number: 2, email: '' },
    { row_number: 3, email: 'not-an-email' },
    { row_number: 4, email: 'two@example.com, three@example.com' },
    { row_number: 5, email: 'valid@example.com' },
  ];

  const result = selectLeads(rows, { nowMs: NOW_MS });
  assert.equal(result.toDraft.length, 1);
  assert.equal(result.toDraft[0].row_number, 5);
  assert.deepEqual(
    result.skipped.map((r) => [r.row_number, r.reason]),
    [
      [2, 'invalid_email'],
      [3, 'invalid_email'],
      [4, 'invalid_email'],
    ]
  );
});

test('selectLeads skips rows that already have draft_id or status drafted/sent', () => {
  const rows = [
    { row_number: 2, email: 'a@example.com', draft_id: 'draft-123', status: '' },
    { row_number: 3, email: 'b@example.com', draft_id: '', status: 'drafted' },
    { row_number: 4, email: 'c@example.com', draft_id: '', status: 'SENT' },
    { row_number: 5, email: 'd@example.com', draft_id: '', status: '' },
  ];

  const result = selectLeads(rows, { nowMs: NOW_MS });
  assert.equal(result.toDraft.length, 1);
  assert.equal(result.toDraft[0].email, 'd@example.com');
  assert.deepEqual(
    result.skipped.map((r) => [r.row_number, r.reason]),
    [
      [2, 'already_drafted'],
      [3, 'already_drafted'],
      [4, 'already_drafted'],
    ]
  );
});

test('selectLeads skips rows with status error with reason error_needs_review', () => {
  const rows = [
    { row_number: 2, email: 'err@example.com', status: 'error', last_error: 'Bad JSON' },
    { row_number: 3, email: 'ok@example.com', status: '' },
  ];

  const result = selectLeads(rows, { nowMs: NOW_MS });
  assert.equal(result.toDraft.length, 1);
  assert.equal(result.toDraft[0].email, 'ok@example.com');
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].row_number, 2);
  assert.equal(result.skipped[0].reason, 'error_needs_review');
});

test('selectLeads separates stuck vs in_progress at the exact staleMinutes boundary', () => {
  const exactly30MinAgo = new Date(NOW_MS - 30 * 60 * 1000).toISOString();
  const justOver30MinAgo = new Date(NOW_MS - 30 * 60 * 1000 - 1).toISOString();
  const tenMinAgo = new Date(NOW_MS - 10 * 60 * 1000).toISOString();
  const fortyFiveMinAgo = new Date(NOW_MS - 45 * 60 * 1000).toISOString();

  const rows = [
    { row_number: 2, email: 'recent@example.com', status: 'drafting', claimed_at: tenMinAgo },
    { row_number: 3, email: 'boundary@example.com', status: 'drafting', claimed_at: exactly30MinAgo },
    { row_number: 4, email: 'just-stale@example.com', status: 'drafting', claimed_at: justOver30MinAgo },
    { row_number: 5, email: 'old-stale@example.com', status: 'drafting', claimed_at: fortyFiveMinAgo },
    { row_number: 6, email: 'missing-ts@example.com', status: 'drafting', claimed_at: '' },
  ];

  const result = selectLeads(rows, { nowMs: NOW_MS, staleMinutes: 30 });
  assert.equal(result.toDraft.length, 0);
  assert.deepEqual(
    result.skipped.map((r) => [r.row_number, r.reason]),
    [
      [2, 'in_progress'],
      [3, 'in_progress'],
    ]
  );
  assert.deepEqual(
    result.stuck.map((r) => [r.row_number, r.reason]),
    [
      [4, 'stuck'],
      [5, 'stuck'],
      [6, 'stuck'],
    ]
  );
});

test('selectLeads deduplicates duplicate emails within batch and picks lowest row_number', () => {
  const rows = [
    { row_number: 10, email: 'DUP@example.com', name: 'Later Row' },
    { row_number: 3, email: 'dup@example.com', name: 'Earliest Row' },
    { row_number: 7, email: '  dup@EXAMPLE.com ', name: 'Middle Row' },
  ];

  const result = selectLeads(rows, { nowMs: NOW_MS });
  assert.equal(result.toDraft.length, 1);
  assert.equal(result.toDraft[0].row_number, 3);
  assert.equal(result.toDraft[0].name, 'Earliest Row');
  assert.deepEqual(
    result.skipped.map((r) => [r.row_number, r.reason]),
    [
      [7, 'duplicate_email'],
      [10, 'duplicate_email'],
    ]
  );
});

test('selectLeads deduplicates candidate rows against emails that already have a draft in other rows', () => {
  const rows = [
    { row_number: 2, email: 'already@example.com', status: '' },
    { row_number: 9, email: 'ALREADY@example.com', status: 'drafted', draft_id: 'r-99' },
    { row_number: 12, email: 'sentlead@example.com', status: 'sent' },
    { row_number: 15, email: 'sentlead@example.com', status: '' },
  ];

  const result = selectLeads(rows, { nowMs: NOW_MS });
  assert.equal(result.toDraft.length, 0);
  assert.deepEqual(
    result.skipped.map((r) => [r.row_number, r.reason]),
    [
      [2, 'duplicate_email'],
      [9, 'already_drafted'],
      [12, 'already_drafted'],
      [15, 'duplicate_email'],
    ]
  );
});

test('selectLeads skips a later duplicate row when an earlier row for the same email is drafting', () => {
  const tenMinAgo = new Date(NOW_MS - 10 * 60 * 1000).toISOString();
  const rows = [
    { row_number: 2, email: 'active@example.com', status: 'drafting', claimed_at: tenMinAgo },
    { row_number: 5, email: 'active@example.com', status: '' },
  ];

  const result = selectLeads(rows, { nowMs: NOW_MS, staleMinutes: 30 });
  assert.equal(result.toDraft.length, 0);
  assert.deepEqual(
    result.skipped.map((r) => [r.row_number, r.reason]),
    [
      [2, 'in_progress'],
      [5, 'duplicate_email'],
    ]
  );
});

test('selectLeads handles empty or non-array input gracefully', () => {
  assert.deepEqual(selectLeads([]), { toDraft: [], stuck: [], skipped: [] });
  assert.deepEqual(selectLeads(null), { toDraft: [], stuck: [], skipped: [] });
});

test('selectLeads caps drafted leads at maxPerRun and marks the rest over_limit', () => {
  const rows = [
    { row_number: 2, email: 'one@example.com' },
    { row_number: 3, email: 'one@example.com' },
    { row_number: 4, email: 'two@example.com' },
    { row_number: 5, email: 'three@example.com' },
    { row_number: 6, email: 'four@example.com' },
  ];

  const result = selectLeads(rows, { nowMs: NOW_MS, maxPerRun: 2 });
  assert.deepEqual(
    result.toDraft.map((r) => r.row_number),
    [2, 4]
  );
  assert.deepEqual(
    result.skipped.map((r) => [r.row_number, r.reason]),
    [
      [3, 'duplicate_email'],
      [5, 'over_limit'],
      [6, 'over_limit'],
    ]
  );
});

test('buildPrompt includes context, senderName, offer, and strict JSON/word-limit instructions', () => {
  const prompt = buildPrompt(
    {
      name: 'Dana',
      company: 'Acme Corp',
      context: 'Met at booth 12; asked about Q3 onboarding timeline.',
    },
    {
      senderName: 'Alex',
      offer: '15-minute architecture walkthrough',
    }
  );

  assert.match(prompt, /\{"subject": "\.\.\.", "body": "\.\.\."\}/);
  assert.match(prompt, /120 words/);
  assert.match(prompt, /Plain text/i);
  assert.match(prompt, /Do NOT invent facts/);
  assert.match(prompt, /Dana/);
  assert.match(prompt, /Acme Corp/);
  assert.match(prompt, /Met at booth 12; asked about Q3 onboarding timeline\./);
  assert.match(prompt, /Alex/);
  assert.match(prompt, /15-minute architecture walkthrough/);
});

test('parseDraft accepts valid raw JSON', () => {
  const raw = JSON.stringify({
    subject: 'Following up on Q3 onboarding timeline',
    body: 'Hi Dana,\n\nGreat speaking with you at booth 12 about your Q3 onboarding timeline.\n\nBest,\nAlex',
  });

  const res = parseDraft(raw);
  assert.equal(res.ok, true);
  assert.equal(res.subject, 'Following up on Q3 onboarding timeline');
  assert.match(res.body, /Great speaking with you/);
});

test('parseDraft accepts JSON wrapped in ```json or ``` markdown fences', () => {
  const fenced = [
    'Here is the draft you requested:',
    '```json',
    '{',
    '  "subject": "Quick follow-up from our chat",',
    '  "body": "Hi Dana, following up on your Q3 onboarding note. Best, Alex"',
    '}',
    '```',
  ].join('\n');

  const res = parseDraft(fenced);
  assert.deepEqual(res, {
    ok: true,
    subject: 'Quick follow-up from our chat',
    body: 'Hi Dana, following up on your Q3 onboarding note. Best, Alex',
  });
});

test('parseDraft accepts JSON wrapped in plain ``` code fences without language tag', () => {
  const plainFence = '```\n{"subject": "Hello Dana", "body": "Checking in on the Q3 timeline."}\n```';
  const res = parseDraft(plainFence);
  assert.equal(res.ok, true);
  assert.equal(res.subject, 'Hello Dana');
  assert.equal(res.body, 'Checking in on the Q3 timeline.');
});

test('parseDraft rejects empty, non-JSON, or non-object LLM outputs', () => {
  assert.equal(parseDraft('').ok, false);
  assert.equal(parseDraft('   ').ok, false);
  assert.equal(parseDraft(null).ok, false);
  assert.equal(parseDraft('not valid json {').ok, false);
  assert.equal(parseDraft('["array", "not", "object"]').ok, false);
});

test('parseDraft rejects empty subject or empty body', () => {
  assert.equal(parseDraft(JSON.stringify({ subject: '   ', body: 'Valid body' })).ok, false);
  assert.equal(parseDraft(JSON.stringify({ subject: 'Valid subject', body: '' })).ok, false);
  assert.equal(parseDraft(JSON.stringify({ subject: 'Valid subject' })).ok, false);
});

test('parseDraft enforces subject <= 120 chars and body <= 2000 chars', () => {
  const exact120 = 'S'.repeat(120);
  const over120 = 'S'.repeat(121);
  const exact2000 = 'B'.repeat(2000);
  const over2000 = 'B'.repeat(2001);

  assert.equal(parseDraft(JSON.stringify({ subject: exact120, body: 'Hello Dana' })).ok, true);
  assert.equal(parseDraft(JSON.stringify({ subject: over120, body: 'Hello Dana' })).ok, false);
  assert.equal(parseDraft(JSON.stringify({ subject: 'Hi', body: exact2000 })).ok, true);
  assert.equal(parseDraft(JSON.stringify({ subject: 'Hi', body: over2000 })).ok, false);
});

test('parseDraft rejects unfilled placeholders like [Name], {{name}}, and <company>', () => {
  const bracket = JSON.stringify({
    subject: 'Quick follow-up',
    body: 'Hi [Name], wanted to check in on your timeline.',
  });
  const mustache = JSON.stringify({
    subject: 'Quick follow-up',
    body: 'Hi Dana, how are things at {{company}}?',
  });
  const angle = JSON.stringify({
    subject: 'Quick follow-up for <company>',
    body: 'Hi Dana, let me know if this week works.',
  });

  assert.equal(parseDraft(bracket).ok, false);
  assert.equal(parseDraft(mustache).ok, false);
  assert.equal(parseDraft(angle).ok, false);
});

test('claimUpdate returns exact columns needed before drafting', () => {
  const update = claimUpdate({ row_number: 7, email: 'a@example.com' }, 'exec-42', NOW_ISO);
  assert.deepEqual(update, {
    row_number: 7,
    status: 'drafting',
    claimed_at: NOW_ISO,
    run_id: 'exec-42',
  });
});

test('doneUpdate returns exact columns needed after Gmail draft is created', () => {
  const update = doneUpdate({ row_number: 7, email: 'a@example.com' }, 'r-888', NOW_ISO);
  assert.deepEqual(update, {
    row_number: 7,
    status: 'drafted',
    draft_id: 'r-888',
    drafted_at: NOW_ISO,
  });
});

test('failUpdate returns status error and truncates last_error to 200 chars', () => {
  const longError = 'E'.repeat(260);
  const update = failUpdate({ row_number: 9 }, longError);
  assert.equal(update.row_number, 9);
  assert.equal(update.status, 'error');
  assert.equal(update.last_error.length, 200);
  assert.equal(update.last_error, 'E'.repeat(200));

  const fromErrObj = failUpdate({ row_number: 10 }, new Error('LLM timeout'));
  assert.equal(fromErrObj.last_error, 'LLM timeout');
});

test('committed snippets match scripts/build-snippets.js output and inline src functions without require', () => {
  const snippetsDir = path.join(__dirname, '..', 'snippets');
  const selectLeadsDisk = fs.readFileSync(path.join(snippetsDir, 'select-leads.js'), 'utf8');
  const parseDraftDisk = fs.readFileSync(path.join(snippetsDir, 'parse-draft.js'), 'utf8');

  const eol = selectLeadsDisk.includes('\r\n') ? '\r\n' : '\n';
  const generated = buildSnippets(eol);

  assert.equal(selectLeadsDisk, generated['select-leads.js']);
  assert.equal(parseDraftDisk, generated['parse-draft.js']);

  const norm = (s) => s.replace(/\r\n/g, '\n');
  assert.ok(norm(selectLeadsDisk).includes(norm(normalizeEmail.toString())));
  assert.ok(norm(selectLeadsDisk).includes(norm(selectLeads.toString())));
  assert.ok(norm(selectLeadsDisk).includes(norm(buildPrompt.toString())));
  assert.ok(norm(selectLeadsDisk).includes(norm(claimUpdate.toString())));

  assert.ok(norm(parseDraftDisk).includes(norm(parseDraft.toString())));
  assert.ok(norm(parseDraftDisk).includes(norm(doneUpdate.toString())));
  assert.ok(norm(parseDraftDisk).includes(norm(failUpdate.toString())));

  assert.doesNotMatch(selectLeadsDisk, /\brequire\s*\(/);
  assert.doesNotMatch(parseDraftDisk, /\brequire\s*\(/);
});

test('snippets execute accurately inside simulated n8n Code node globals', () => {
  const snippetsDir = path.join(__dirname, '..', 'snippets');
  const selectCode = fs.readFileSync(path.join(snippetsDir, 'select-leads.js'), 'utf8');
  const parseCode = fs.readFileSync(path.join(snippetsDir, 'parse-draft.js'), 'utf8');

  const runSelect = new Function('$input', '$', '$execution', selectCode);
  const staleIso = new Date(Date.now() - 120 * 60 * 1000).toISOString();
  const routed = runSelect(
    {
      all: () => [
        { json: { row_number: 2, email: 'lead1@example.com', name: 'Ava', context: 'Asked for pricing' } },
        { json: { row_number: 3, email: 'stuck@example.com', status: 'drafting', claimed_at: staleIso } },
      ],
    },
    () => ({
      first: () => ({
        json: { senderName: 'Alex', offer: 'Pricing guide', staleMinutes: 30, maxPerRun: 10 },
      }),
    }),
    { id: 'exec-99' }
  );

  assert.equal(routed.length, 2);
  assert.equal(routed[0].json._route, 'draft');
  assert.equal(routed[0].json.status, 'drafting');
  assert.equal(routed[0].json.run_id, 'exec-99');
  assert.match(routed[0].json.prompt, /Pricing guide/);
  assert.equal(routed[1].json._route, 'stuck');

  const runParse = new Function('$input', '$', parseCode);
  const parsedOk = runParse(
    {
      item: {
        json: {
          text: '```json\n{"subject": "Pricing guide follow-up", "body": "Hi Ava, sharing the pricing guide you asked for. Best, Alex"}\n```',
        },
      },
    },
    () => ({
      item: { json: routed[0].json },
    })
  );

  assert.equal(parsedOk.json.ok, true);
  assert.equal(parsedOk.json.subject, 'Pricing guide follow-up');
  assert.equal(parsedOk.json.row_number, 2);

  const parsedFail = runParse(
    {
      item: {
        json: {
          text: '{"subject": "Follow-up", "body": "Hi [Name], checking in."}',
        },
      },
    },
    () => ({
      item: { json: routed[0].json },
    })
  );

  assert.equal(parsedFail.json.ok, false);
  assert.equal(parsedFail.json.status, 'error');
  assert.match(parsedFail.json.last_error, /placeholder/i);
});

test('workflow JSON is valid and uses the exact required n8n node types and versions', () => {
  const workflowPath = path.join(__dirname, '..', 'workflows', 'lead-followup-drafts.json');
  const raw = fs.readFileSync(workflowPath, 'utf8');
  const wf = JSON.parse(raw);

  assert.ok(Array.isArray(wf.nodes));
  assert.ok(wf.connections && typeof wf.connections === 'object');

  const byType = (type) => wf.nodes.filter((n) => n.type === type);

  assert.equal(byType('n8n-nodes-base.manualTrigger').length, 1);

  const schedules = byType('n8n-nodes-base.scheduleTrigger');
  assert.equal(schedules.length, 1);
  assert.equal(schedules[0].disabled, true);

  const sets = byType('n8n-nodes-base.set');
  assert.equal(sets.length, 1);
  assert.equal(sets[0].typeVersion, 3.4);

  const sheets = byType('n8n-nodes-base.googleSheets');
  assert.equal(sheets.length, 4);
  for (const node of sheets) {
    assert.equal(node.typeVersion, 4.5);
    assert.equal(node.parameters.documentId.value, 'YOUR_SHEET_ID');
    assert.equal(node.parameters.sheetName.value, 'Leads');
  }
  const updateSheets = sheets.filter((n) => n.parameters.operation === 'update');
  assert.equal(updateSheets.length, 3);
  for (const node of updateSheets) {
    assert.equal(node.parameters.columnToMatchOn, 'row_number');
  }

  const codes = byType('n8n-nodes-base.code');
  assert.equal(codes.length, 2);
  for (const node of codes) {
    assert.equal(node.typeVersion, 2);
  }

  const switches = byType('n8n-nodes-base.switch');
  assert.equal(switches.length, 1);
  assert.equal(switches[0].typeVersion, 3.2);

  const ifs = byType('n8n-nodes-base.if');
  assert.equal(ifs.length, 1);
  assert.equal(ifs[0].typeVersion, 2.2);

  const chains = byType('@n8n/n8n-nodes-langchain.chainLlm');
  assert.equal(chains.length, 1);
  assert.equal(chains[0].typeVersion, 1.5);

  const models = byType('@n8n/n8n-nodes-langchain.lmChatOpenAi');
  assert.equal(models.length, 1);
  const modelConn = wf.connections[models[0].name];
  assert.ok(modelConn && Array.isArray(modelConn.ai_languageModel));
  assert.equal(modelConn.ai_languageModel[0][0].node, chains[0].name);
  assert.equal(modelConn.ai_languageModel[0][0].type, 'ai_languageModel');

  const gmails = byType('n8n-nodes-base.gmail');
  assert.equal(gmails.length, 1);
  assert.equal(gmails[0].typeVersion, 2.2);
  assert.equal(gmails[0].parameters.resource, 'draft');
  assert.equal(gmails[0].parameters.operation, 'create');
  assert.ok(gmails[0].parameters.options && gmails[0].parameters.options.sendTo);

  assert.equal(byType('n8n-nodes-base.noOp').length, 1);
  assert.ok(byType('n8n-nodes-base.stickyNote').length >= 3);
});
