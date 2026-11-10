'use strict';

function normalizeEmail(s) {
  if (typeof s !== 'string') {
    return null;
  }
  const trimmed = s.trim().toLowerCase();
  if (!trimmed || /[\s,;<>()]/.test(trimmed)) {
    return null;
  }
  const parts = trimmed.split('@');
  if (parts.length !== 2) {
    return null;
  }
  const [local, domain] = parts;
  if (
    !local ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    local.includes('..')
  ) {
    return null;
  }
  if (
    !domain ||
    !domain.includes('.') ||
    domain.startsWith('.') ||
    domain.endsWith('.') ||
    domain.includes('..')
  ) {
    return null;
  }
  const labels = domain.split('.');
  if (labels.some((label) => !label || label.startsWith('-') || label.endsWith('-'))) {
    return null;
  }
  if (labels[labels.length - 1].length < 2) {
    return null;
  }
  return trimmed;
}

function selectLeads(rows, options = {}) {
  const {
    nowMs = Date.now(),
    staleMinutes = 30,
    maxPerRun = 10,
  } = options || {};

  const inputRows = Array.isArray(rows) ? rows : [];
  const staleThresholdMs = Number(staleMinutes) * 60 * 1000;
  const limit = Math.max(0, Number(maxPerRun));

  const isDoNotContact = (val) => {
    if (val === true || val === 1) {
      return true;
    }
    const norm = String(val ?? '').trim().toLowerCase();
    return norm === 'yes' || norm === 'true' || norm === '1' || norm === 'x';
  };

  const hasExistingDraft = (row) => {
    const draftId = String(row.draft_id ?? '').trim();
    const status = String(row.status ?? '').trim().toLowerCase();
    return draftId !== '' || status === 'drafted' || status === 'sent';
  };

  const indexed = inputRows.map((row, index) => ({
    row: row || {},
    index,
    rowNum: Number(row && row.row_number),
  }));

  indexed.sort((a, b) => {
    const aValid = Number.isFinite(a.rowNum);
    const bValid = Number.isFinite(b.rowNum);
    if (aValid && bValid && a.rowNum !== b.rowNum) {
      return a.rowNum - b.rowNum;
    }
    if (aValid !== bValid) {
      return aValid ? -1 : 1;
    }
    return a.index - b.index;
  });

  const seenEmails = new Set();
  for (const { row } of indexed) {
    const email = normalizeEmail(row.email);
    if (email && hasExistingDraft(row)) {
      seenEmails.add(email);
    }
  }

  const toDraft = [];
  const stuck = [];
  const skipped = [];

  for (const { row } of indexed) {
    const email = normalizeEmail(row.email);
    const status = String(row.status ?? '').trim().toLowerCase();
    const claimedAt = String(row.claimed_at ?? '').trim();
    const normalizedRow = {
      ...row,
      row_number: row.row_number,
      email: email ?? String(row.email ?? '').trim(),
      name: String(row.name ?? '').trim(),
      company: String(row.company ?? '').trim(),
      context: String(row.context ?? '').trim(),
      status: String(row.status ?? '').trim(),
      claimed_at: claimedAt,
      draft_id: String(row.draft_id ?? '').trim(),
      do_not_contact: String(row.do_not_contact ?? '').trim(),
    };

    if (isDoNotContact(row.do_not_contact)) {
      skipped.push({ ...normalizedRow, reason: 'do_not_contact' });
      continue;
    }

    if (!email) {
      skipped.push({ ...normalizedRow, reason: 'invalid_email' });
      continue;
    }

    if (hasExistingDraft(row)) {
      skipped.push({ ...normalizedRow, reason: 'already_drafted' });
      continue;
    }

    if (status === 'error') {
      skipped.push({ ...normalizedRow, reason: 'error_needs_review' });
      seenEmails.add(email);
      continue;
    }

    if (status === 'drafting') {
      const claimedMs = Date.parse(claimedAt);
      const isStale =
        !Number.isFinite(claimedMs) || nowMs - claimedMs > staleThresholdMs;
      if (isStale) {
        stuck.push({ ...normalizedRow, reason: 'stuck' });
      } else {
        skipped.push({ ...normalizedRow, reason: 'in_progress' });
      }
      seenEmails.add(email);
      continue;
    }

    if (seenEmails.has(email)) {
      skipped.push({ ...normalizedRow, reason: 'duplicate_email' });
      continue;
    }

    seenEmails.add(email);

    if (toDraft.length >= limit) {
      skipped.push({ ...normalizedRow, reason: 'over_limit' });
      continue;
    }

    toDraft.push(normalizedRow);
  }

  return { toDraft, stuck, skipped };
}

function buildPrompt(lead, options = {}) {
  const safeLead = lead || {};
  const { senderName = '', offer = '' } = options || {};
  const name = String(safeLead.name ?? '').trim() || 'there';
  const company = String(safeLead.company ?? '').trim();
  const context = String(safeLead.context ?? '').trim();
  const sender = String(senderName ?? '').trim() || 'Sender';
  const offerText = String(offer ?? '').trim();

  return [
    'Write a short, plain-text follow-up email based strictly on the provided lead context.',
    'Rules:',
    '- Return ONLY valid JSON with exact keys: {"subject": "...", "body": "..."}',
    '- Plain text only (no HTML, no markdown formatting inside subject or body).',
    '- Maximum 120 words in the body; subject must be 120 characters or fewer.',
    '- Do NOT invent facts, metrics, prior meetings, or claims. Use ONLY the context below.',
    '- Do NOT leave any unfilled placeholders such as [Name], {{name}}, or <company>.',
    '',
    `Recipient name: ${name}`,
    `Company: ${company || 'N/A'}`,
    `Context: ${context || 'No additional context provided.'}`,
    `Offer / CTA: ${offerText || 'Reply if you would like to continue the conversation.'}`,
    `Sign-off sender name: ${sender}`,
  ].join('\n');
}

function parseDraft(llmText) {
  if (typeof llmText !== 'string' || !llmText.trim()) {
    return { ok: false, error: 'Empty LLM response' };
  }

  const trimmed = llmText.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch ? fenceMatch[1].trim() : trimmed;

  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch (_err) {
    return { ok: false, error: 'Invalid JSON in LLM response' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'LLM JSON response must be an object' };
  }

  const subject = typeof parsed.subject === 'string' ? parsed.subject.trim() : '';
  const body = typeof parsed.body === 'string' ? parsed.body.trim() : '';

  if (!subject) {
    return { ok: false, error: 'Draft subject is empty' };
  }

  if (!body) {
    return { ok: false, error: 'Draft body is empty' };
  }

  if (subject.length > 120) {
    return { ok: false, error: 'Draft subject exceeds 120 characters' };
  }

  if (body.length > 2000) {
    return { ok: false, error: 'Draft body exceeds 2000 characters' };
  }

  const placeholderPattern = /\[[^\[\]\n]{1,60}\]|\{\{|\}\}|<[a-zA-Z][^>\n]{0,60}>/;
  if (placeholderPattern.test(subject) || placeholderPattern.test(body)) {
    return { ok: false, error: 'Draft contains unfilled placeholder' };
  }

  return { ok: true, subject, body };
}

function claimUpdate(lead, runId, nowIso) {
  return {
    row_number: lead.row_number,
    status: 'drafting',
    claimed_at: String(nowIso ?? ''),
    run_id: String(runId ?? ''),
  };
}

function doneUpdate(lead, draftId, nowIso) {
  return {
    row_number: lead.row_number,
    status: 'drafted',
    draft_id: String(draftId ?? ''),
    drafted_at: String(nowIso ?? ''),
  };
}

function failUpdate(lead, error) {
  const message =
    error instanceof Error ? error.message : String(error ?? 'Unknown error');
  return {
    row_number: lead.row_number,
    status: 'error',
    last_error: message.slice(0, 200),
  };
}

module.exports = {
  normalizeEmail,
  selectLeads,
  buildPrompt,
  parseDraft,
  claimUpdate,
  doneUpdate,
  failUpdate,
};
