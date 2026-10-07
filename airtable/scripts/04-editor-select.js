// Field Notes, weekly step 2: EDITOR (select). One model call.
// Picks 3-5 signals from the week's scored items, checked against the last 4 published editions.
// Secret: ANTHROPIC_API_KEY. Inputs: editionId. Outputs: picks (JSON string), count.
const MODEL = 'claude-opus-5-5', RATE_IN = 4 / 1e6, RATE_OUT = 20 / 1e6; // $/token, Anthropic price list cached 2026-10-06
const CALL_MS = 24000, DAYS = 8;
const usage = { calls: 0, inp: 0, out: 0 };

function withTimeout(p, ms) { return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout after ' + ms + 'ms')), ms))]); }
async function claude(system, user, maxTokens, effort) {
  const key = input.secret('ANTHROPIC_API_KEY');
  const call = fb => {
    const headers = { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' };
    const body = { model: MODEL, max_tokens: maxTokens, system, output_config: { effort: effort || 'low' }, messages: [{ role: 'user', content: user }] };
    if (fb) { headers['anthropic-beta'] = 'server-side-fallback-2026-07-01'; body.fallbacks = 'default'; }
    return withTimeout(fetch('https://api.anthropic.com/v1/messages' + (fb ? '?beta=true' : ''), { method: 'POST', headers, body: JSON.stringify(body) }), CALL_MS);
  };
  let r = await call(true), j = await r.json();
  if (r.status === 400 && /fallback/i.test(JSON.stringify(j))) { r = await call(false); j = await r.json(); }
  if (!r.ok) throw new Error('Claude HTTP ' + r.status + ': ' + JSON.stringify(j).slice(0, 300));
  usage.calls++; usage.inp += (j.usage && j.usage.input_tokens) || 0; usage.out += (j.usage && j.usage.output_tokens) || 0;
  if (j.stop_reason === 'refusal') throw new Error('Claude refused: ' + JSON.stringify(j.stop_details || {}));
  if (j.stop_reason === 'max_tokens') throw new Error('Claude output hit max_tokens');
  return (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}
function parseObj(t) { const a = t.indexOf('{'), b = t.lastIndexOf('}'); if (a < 0 || b < a) throw new Error('no JSON object in model output'); return JSON.parse(t.slice(a, b + 1)); }

const cfg = input.config();
const editionId = cfg.editionId;
const charterRec = (await base.getTable('Charter').selectRecordsAsync()).records.find(r => r.getCellValue('Active'));
if (!charterRec) throw new Error('No active Charter record');
const charter = ['Lens', 'Pillars', 'Voice', 'Exclusions', 'Technical point of view', 'Signal format']
  .map(n => n.toUpperCase() + ':\n' + charterRec.getCellValueAsString(n)).join('\n\n');
const PILLARS = charterRec.getCellValueAsString('Pillars').split('\n').map(l => l.replace(/^\d+\.\s*/, '').split(' (')[0].trim()).filter(Boolean);

const now = Date.now(), cutoff = now - DAYS * 86400000;
const items = (await base.getTable('Items').selectRecordsAsync({ fields: ['Title', 'URL', 'Feed', 'Published', 'Fetched', 'Summary', 'Pillar', 'Final score', 'Status', 'Funding/VC downweight'] })).records;
const when = r => new Date(r.getCellValue('Published') || r.getCellValue('Fetched') || 0).getTime();

// Shadow-mode comparison: plain digest of the week's newest items, unfiltered.
const digest = items.filter(r => when(r) >= cutoff).sort((a, b) => when(b) - when(a)).slice(0, 20)
  .map(r => '- ' + r.getCellValueAsString('Title') + ' (' + r.getCellValueAsString('Feed') + ') ' + r.getCellValueAsString('URL')).join('\n');
await base.getTable('Editions').updateRecordAsync(editionId, { 'Raw RSS digest': digest });

const cands = items.filter(r => r.getCellValueAsString('Status') === 'Scored' && when(r) >= cutoff && (r.getCellValue('Final score') || 0) > 0)
  .sort((a, b) => (b.getCellValue('Final score') || 0) - (a.getCellValue('Final score') || 0)).slice(0, 25);
const candMap = {};
cands.forEach(r => { candMap[r.id] = r; });
const candidates = cands.map(r => ({
  item_id: r.id, title: r.getCellValueAsString('Title'), feed: r.getCellValueAsString('Feed'), pillar: r.getCellValueAsString('Pillar'),
  score: r.getCellValue('Final score'), funding_flag: !!r.getCellValue('Funding/VC downweight'),
  published: r.getCellValueAsString('Published'), summary: r.getCellValueAsString('Summary').slice(0, 350),
}));

// Last 4 published editions (Approved or Published), with their signals.
const edRecs = (await base.getTable('Editions').selectRecordsAsync({ fields: ['Week of', 'Status'] })).records
  .filter(r => r.id !== editionId && ['Approved', 'Published'].includes(r.getCellValueAsString('Status')))
  .sort((a, b) => b.getCellValueAsString('Week of').localeCompare(a.getCellValueAsString('Week of'))).slice(0, 4);
const sigs = (await base.getTable('Signals').selectRecordsAsync({ fields: ['Headline', 'Edition', 'What to do next'] })).records;
const previous = edRecs.map(e => ({
  week_of: e.getCellValueAsString('Week of'),
  signals: sigs.filter(s => (s.getCellValue('Edition') || []).some(x => x.id === e.id)).map(s => ({ headline: s.getCellValueAsString('Headline'), next: s.getCellValueAsString('What to do next').slice(0, 160) })),
}));

const system = charter + `\n\nYOU ARE THE EDITOR of Field Notes. Pick the 3 to 5 signals worth a column this week.
Rules:
- Choose only from the candidate list; every item_id must come from it.
- A signal is a development that changes how AI and software get built or used. Not funding news, not launch hype, not press-release reprints.
- A theme that continues from a previous edition is only allowed if something changed; say what changed in "what_changed". Otherwise skip it.
- Every signal needs a credible "next_step": a specific move a builder can make this week, with a timeframe. "Keep an eye on this" fails. If you cannot write one, cut the signal.
- Do not pad. If fewer than 3 candidates qualify, return fewer and explain in "note". Never fill with older or weaker items.
- Cover more than one pillar when the material allows, but do not force it.
Return ONLY a JSON object, no prose:
{"signals":[{"headline":"","pillar":"one of: ${PILLARS.join(' | ')}","item_ids":["recXXXX"],"continues_theme":false,"what_changed":"","angle":"one line on the point of view","next_step":"specific move + timeframe"}],"cut":[{"item_id":"","reason":""}],"note":""}`;
const user = JSON.stringify({ today: new Date().toISOString().slice(0, 10), candidates, previous_editions: previous });

let picks = [], note = '', err = '';
try {
  const parsed = parseObj(await claude(system, user, 3500, 'low'));
  note = parsed.note || '';
  const used = new Set();
  for (const s of (parsed.signals || [])) {
    const ids = (s.item_ids || []).filter(id => candMap[id] && !used.has(id));
    if (!ids.length || !s.headline || !s.next_step) continue;
    if (!PILLARS.includes(s.pillar)) s.pillar = candMap[ids[0]].getCellValueAsString('Pillar');
    ids.forEach(id => used.add(id));
    picks.push({ headline: s.headline, pillar: s.pillar, item_ids: ids, continues_theme: !!s.continues_theme, what_changed: s.what_changed || '', angle: s.angle || '', next_step: s.next_step });
  }
  picks = picks.slice(0, 5);
} catch (e) { err = String(e.message || e); }

await base.getTable('Run log').createRecordAsync({
  'Run': 'Editor select ' + new Date().toISOString().slice(0, 16), 'Step': { name: 'Editor' }, 'Edition': [{ id: editionId }], 'Ran at': new Date().toISOString(),
  'Sources used': candidates.length + ' candidates; ' + previous.length + ' previous editions compared\n' + candidates.map(c => c.title).join('\n'),
  'Model calls': usage.calls, 'Input tokens': usage.inp, 'Output tokens': usage.out, 'Cost USD': usage.inp * RATE_IN + usage.out * RATE_OUT,
  'Errors': [err, picks.length < 3 ? 'Only ' + picks.length + ' qualified signals (target 3-5); no backfill. ' + note : ''].filter(Boolean).join('\n'),
});
if (err) throw new Error(err);
output.set('picks', JSON.stringify(picks));
output.set('count', picks.length);
