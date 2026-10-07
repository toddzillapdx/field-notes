// Field Notes, weekly step 4: VERIFICATION. No model calls, no secrets.
// Fetches every source URL, checks controlled vocabulary, blocks invented links and vague next steps.
// Unverified signals are flagged "DROPPED:" in Verification note and skipped by later steps (never deleted, so Todd can restore one).
const FETCH_MS = 8000;
const VAGUE = /keep an eye|stay tuned|watch this space|monitor the situation|keep watching|time will tell/i;
function withTimeout(p, ms) { return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout after ' + ms + 'ms')), ms))]); }

async function check(url, fromFeed) {
  try {
    const res = await withTimeout(fetch(url, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (compatible; FieldNotesBot/0.1)', accept: 'text/html,*/*' } }), FETCH_MS);
    if (res.status < 400) return { url, ok: true, note: 'HTTP ' + res.status };
    // Bot-blocked responses on a URL that came straight from the feed are real pages; any other 4xx/5xx is a dead link.
    if (fromFeed && [401, 403, 429, 999].includes(res.status)) return { url, ok: true, note: 'HTTP ' + res.status + ' (blocks bots; URL came from the feed itself)' };
    return { url, ok: false, note: 'HTTP ' + res.status };
  } catch (e) { return { url, ok: false, note: String(e.message || e) }; }
}

const cfg = input.config(), editionId = cfg.editionId;
const charterRec = (await base.getTable('Charter').selectRecordsAsync()).records.find(r => r.getCellValue('Active'));
const PILLARS = charterRec.getCellValueAsString('Pillars').split('\n').map(l => l.replace(/^\d+\.\s*/, '').split(' (')[0].trim()).filter(Boolean);

const signalsT = base.getTable('Signals');
const sigs = (await signalsT.selectRecordsAsync({ fields: ['Headline', 'Edition', 'Pillar', 'What happened', 'Why it matters', 'What to do next', 'Source URLs', 'Source items'] })).records
  .filter(r => (r.getCellValue('Edition') || []).some(x => x.id === editionId));
const itemUrl = {};
(await base.getTable('Items').selectRecordsAsync({ fields: ['URL'] })).records.forEach(r => { itemUrl[r.id] = r.getCellValueAsString('URL'); });

const reports = await Promise.all(sigs.map(async s => {
  const problems = [], notes = [];
  const urls = s.getCellValueAsString('Source URLs').split('\n').map(u => u.trim()).filter(Boolean);
  const feedUrls = new Set((s.getCellValue('Source items') || []).map(x => itemUrl[x.id]).filter(Boolean));
  const allowed = new Set([...urls, ...feedUrls]);
  if (!PILLARS.includes(s.getCellValueAsString('Pillar'))) problems.push('pillar not in controlled vocabulary');
  for (const f of ['What happened', 'Why it matters', 'What to do next']) if (!s.getCellValueAsString(f).trim()) problems.push(f + ' is empty');
  if (VAGUE.test(s.getCellValueAsString('What to do next'))) problems.push('What to do next is vague');
  const prose = s.getCellValueAsString('What happened') + ' ' + s.getCellValueAsString('Why it matters') + ' ' + s.getCellValueAsString('What to do next');
  const proseUrls = (prose.match(/https?:\/\/[^\s)\]>"']+/g) || []).map(u => u.replace(/[.,;]+$/, ''));
  const unknown = proseUrls.filter(u => ![...allowed].some(a => a === u || a.replace(/\/$/, '') === u.replace(/\/$/, '')));
  if (unknown.length) problems.push('link(s) not in source list: ' + unknown.slice(0, 3).join(', '));
  const sentences = (s.getCellValueAsString('What happened').match(/[.!?](\s|$)/g) || []).length;
  if (sentences < 2 || sentences > 4) notes.push('What happened has ' + sentences + ' sentences (target 2-4)');
  if ((prose.match(/"[^"]{1,400}"/g) || []).some(q => q.split(/\s+/).length >= 15)) notes.push('has a quote of 15+ words');
  if (!urls.length) problems.push('no source URLs');
  const checks = await Promise.all(urls.map(u => check(u, feedUrls.has(u))));
  const working = checks.filter(c => c.ok);
  if (urls.length && !working.length) problems.push('no working source URL (' + checks.map(c => c.note).join('; ') + ')');
  notes.push(checks.map(c => (c.ok ? 'OK ' : 'FAIL ') + c.url + ' [' + c.note + ']').join('\n'));
  return { s, ok: problems.length === 0, problems, notes };
}));

for (const r of reports) {
  await signalsT.updateRecordAsync(r.s.id, {
    'Verified': r.ok,
    'Verification note': (r.ok ? '' : 'DROPPED: ' + r.problems.join('; ') + '\n') + r.notes.join('\n'),
  });
}
const verified = reports.filter(r => r.ok).length, dropped = reports.length - verified;
await base.getTable('Run log').createRecordAsync({
  'Run': 'Verify ' + new Date().toISOString().slice(0, 16), 'Step': { name: 'Verify' }, 'Edition': [{ id: editionId }], 'Ran at': new Date().toISOString(),
  'Sources used': reports.map(r => r.s.getCellValueAsString('Headline') + ': ' + (r.ok ? 'verified' : 'DROPPED')).join('\n'), 'Model calls': 0,
  'Errors': [...reports.filter(r => !r.ok).map(r => 'DROPPED "' + r.s.getCellValueAsString('Headline') + '": ' + r.problems.join('; ')),
    verified < 3 ? 'Only ' + verified + ' verified signals (target 3-5). Edition is short; no backfill.' : ''].filter(Boolean).join('\n'),
});
output.set('verified', verified);
output.set('dropped', dropped);
