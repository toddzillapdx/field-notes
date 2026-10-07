// Field Notes, weekly step 6: HERO IMAGE PROMPT. One model call. Writes the prompt only; Todd generates the image by hand (Gemini)
// and uploads it to Editions.Hero image. Also compiles Editions.Sources from the verified signals.
// Secret: ANTHROPIC_API_KEY. Inputs: editionId.
const MODEL = 'claude-opus-5-5', RATE_IN = 4 / 1e6, RATE_OUT = 20 / 1e6; // $/token, Anthropic price list cached 2026-10-06
const CALL_MS = 24000;
// PROPOSED house style: not yet confirmed by Todd. Edit here (or move into the Charter) once decided.
const HOUSE_STYLE = 'Flat editorial illustration, restrained palette of 3-4 muted colors with one warm accent, generous negative space, subtle paper grain, 16:9 landscape.';
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

const editionId = input.config().editionId;
const edT = base.getTable('Editions');
const ed = await edT.selectRecordAsync(editionId, { fields: ['Opening note', 'Week of'] });
const sigs = (await base.getTable('Signals').selectRecordsAsync({ fields: ['Headline', 'Edition', 'Order', 'Pillar', 'Source URLs', 'Verified'] })).records
  .filter(r => (r.getCellValue('Edition') || []).some(x => x.id === editionId) && r.getCellValue('Verified'))
  .sort((a, b) => (a.getCellValue('Order') || 0) - (b.getCellValue('Order') || 0));

const sources = sigs.map(s => s.getCellValueAsString('Headline') + '\n' + s.getCellValueAsString('Source URLs').split('\n').filter(Boolean).map(u => '  ' + u).join('\n')).join('\n\n');
let err = '', promptText = '';
try {
  const system = `You write one image-generation prompt for the hero image of a weekly tech column. The prompt will be pasted into an image model by hand.
Rules: one clear visual subject that works as a metaphor for the week's through-line (an object, scene or abstract composition). NO real people or recognizable faces. NO logos, brand marks, product UIs or readable text. State the house style verbatim at the end. Keep it under 90 words, plain prose, no markdown.
Return ONLY JSON: {"prompt":""}`;
  const user = JSON.stringify({ house_style: HOUSE_STYLE, opening_note: ed.getCellValueAsString('Opening note'), headlines: sigs.map(s => s.getCellValueAsString('Headline')) });
  promptText = String(parseObj(await claude(system, user, 700, 'low')).prompt || '').trim();
  if (!promptText) throw new Error('empty prompt');
} catch (e) { err = String(e.message || e); }

const fields = { 'Sources': sources };
if (promptText) fields['Hero image prompt'] = promptText;
await edT.updateRecordAsync(editionId, fields);
await base.getTable('Run log').createRecordAsync({
  'Run': 'Hero prompt ' + new Date().toISOString().slice(0, 16), 'Step': { name: 'Hero prompt' }, 'Edition': [{ id: editionId }], 'Ran at': new Date().toISOString(),
  'Sources used': sigs.length + ' verified signals', 'Model calls': usage.calls, 'Input tokens': usage.inp, 'Output tokens': usage.out,
  'Cost USD': usage.inp * RATE_IN + usage.out * RATE_OUT, 'Errors': err,
});
if (err) throw new Error(err);
output.set('ok', true);
