// Field Notes, weekly step 5: COLUMNIST. Parallel model calls: one voice pass per verified signal, plus the opening note.
// Data fields (pillar, sources, verified, order) are never touched. If a rewrite drops a link or adds a long quote, the editor's text is kept.
// Secret: ANTHROPIC_API_KEY. Inputs: editionId.
const MODEL = 'claude-opus-5-5', RATE_IN = 4 / 1e6, RATE_OUT = 20 / 1e6; // $/token, Anthropic price list cached 2026-10-06
const CALL_MS = 24000;
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
const urlsIn = s => (s.match(/https?:\/\/[^\s)\]>"']+/g) || []).map(u => u.replace(/[.,;]+$/, ''));
const longQuote = s => (s.match(/"[^"]{1,400}"/g) || []).some(q => q.split(/\s+/).length >= 15);

const editionId = input.config().editionId;
const charterRec = (await base.getTable('Charter').selectRecordsAsync()).records.find(r => r.getCellValue('Active'));
const charter = ['Lens', 'Voice', 'Exclusions', 'Technical point of view']
  .map(n => n.toUpperCase() + ':\n' + charterRec.getCellValueAsString(n)).join('\n\n');
const signalsT = base.getTable('Signals');
const sigs = (await signalsT.selectRecordsAsync({ fields: ['Headline', 'Edition', 'Order', 'Pillar', 'What happened', 'Why it matters', 'What to do next', 'Verified'] })).records
  .filter(r => (r.getCellValue('Edition') || []).some(x => x.id === editionId) && r.getCellValue('Verified'))
  .sort((a, b) => (a.getCellValue('Order') || 0) - (b.getCellValue('Order') || 0));

const sysSignal = charter + `\n\nYOU ARE THE COLUMNIST. Rewrite one signal in the charter voice: first person, direct, New Jersey register, curious and stoic, a definite point of view that stays open to changing.
Rules:
- Keep every fact, number and name exactly as given. Add no new facts, claims or quotes.
- Keep every markdown link and URL that appears in the input, unchanged.
- Keep the three-part structure: what_happened (2-4 sentences, still tight), why_it_matters, what_to_do_next (still specific, still names a move and a timeframe).
- Quotes stay under 15 words. No hype, no funding talk, no filler.
Return ONLY JSON: {"what_happened":"","why_it_matters":"","what_to_do_next":""}`;
const sysOpen = charter + `\n\nYOU ARE THE COLUMNIST. Write the opening note for this week's Field Notes: 3-5 sentences in the charter voice on the week's through-line connecting the signals. First person, direct, no hype. Do not add facts beyond the signals given and do not include links.
Return ONLY JSON: {"opening_note":""}`;

const problems = [];
const [openRes, ...sigRes] = await Promise.all([
  (async () => {
    try { return parseObj(await claude(sysOpen, JSON.stringify({ signals: sigs.map(s => ({ headline: s.getCellValueAsString('Headline'), pillar: s.getCellValueAsString('Pillar'), what_happened: s.getCellValueAsString('What happened'), why_it_matters: s.getCellValueAsString('Why it matters') })) }), 900, 'low')).opening_note; }
    catch (e) { problems.push('Opening note: ' + e.message); return null; }
  })(),
  ...sigs.map(async s => {
    const orig = { what_happened: s.getCellValueAsString('What happened'), why_it_matters: s.getCellValueAsString('Why it matters'), what_to_do_next: s.getCellValueAsString('What to do next') };
    try {
      const out = parseObj(await claude(sysSignal, JSON.stringify({ headline: s.getCellValueAsString('Headline'), ...orig }), 1500, 'low'));
      for (const k of Object.keys(orig)) if (!out[k] || typeof out[k] !== 'string') throw new Error('missing ' + k);
      const before = urlsIn(Object.values(orig).join(' ')), after = new Set(urlsIn(Object.values(out).join(' ')));
      if (before.some(u => !after.has(u))) throw new Error('rewrite dropped a link; kept editor text');
      if (urlsIn(Object.values(out).join(' ')).some(u => !before.includes(u))) throw new Error('rewrite added a link; kept editor text');
      if (longQuote(Object.values(out).join(' '))) throw new Error('rewrite has a 15+ word quote; kept editor text');
      await signalsT.updateRecordAsync(s.id, { 'What happened': out.what_happened.trim(), 'Why it matters': out.why_it_matters.trim(), 'What to do next': out.what_to_do_next.trim() });
      return true;
    } catch (e) { problems.push(s.getCellValueAsString('Headline') + ': ' + e.message); return false; }
  }),
]);
if (openRes) await base.getTable('Editions').updateRecordAsync(editionId, { 'Opening note': openRes.trim() });

await base.getTable('Run log').createRecordAsync({
  'Run': 'Columnist ' + new Date().toISOString().slice(0, 16), 'Step': { name: 'Columnist' }, 'Edition': [{ id: editionId }], 'Ran at': new Date().toISOString(),
  'Sources used': sigs.map(s => s.getCellValueAsString('Headline')).join('\n'),
  'Model calls': usage.calls, 'Input tokens': usage.inp, 'Output tokens': usage.out, 'Cost USD': usage.inp * RATE_IN + usage.out * RATE_OUT,
  'Errors': problems.join('\n'),
});
output.set('voiced', sigRes.filter(Boolean).length);
