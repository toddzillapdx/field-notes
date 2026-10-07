// Field Notes, weekly step 3: EDITOR (write). One model call per picked signal, run in parallel.
// Writes What happened / Why it matters / What to do next into Signals (status: unverified).
// Secret: ANTHROPIC_API_KEY. Inputs: editionId, picks (JSON string from step 2).
const MODEL = 'claude-opus-5-5', RATE_IN = 4 / 1e6, RATE_OUT = 20 / 1e6; // $/token, Anthropic price list cached 2026-10-06
const CALL_MS = 24000, PAGE_MS = 6000;
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
async function pageText(url) {
  try {
    const res = await withTimeout(fetch(url, { redirect: 'follow', headers: { 'user-agent': 'FieldNotesBot/0.1 (personal editorial column)' } }), PAGE_MS);
    if (!res.ok) return '';
    return (await res.text()).replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().slice(0, 5000);
  } catch (e) { return ''; }
}

const cfg = input.config();
const editionId = cfg.editionId, picks = JSON.parse(cfg.picks || '[]');
const charterRec = (await base.getTable('Charter').selectRecordsAsync()).records.find(r => r.getCellValue('Active'));
const charter = ['Lens', 'Voice', 'Exclusions', 'Technical point of view', 'Signal format']
  .map(n => n.toUpperCase() + ':\n' + charterRec.getCellValueAsString(n)).join('\n\n');
const itemRecs = (await base.getTable('Items').selectRecordsAsync({ fields: ['Title', 'URL', 'Feed', 'Summary', 'Published'] })).records;
const byId = {}; itemRecs.forEach(r => { byId[r.id] = r; });

const system = charter + `\n\nYOU ARE THE EDITOR writing one signal for Field Notes. Write plain, accurate, direct copy; the columnist adds voice later.
Rules:
- Use ONLY the source material provided. Do not add facts, numbers, names or quotes that are not in it. If a fact cannot be supported, leave it out.
- "what_happened": 2-4 sentences, the facts, tight. Link sources inline as markdown [text](url) using ONLY URLs from allowed_urls. Direct quotes must be under 15 words; paraphrase everything else.
- "why_it_matters": must go beyond restating the news: what changed, who it affects, how it connects to the trend line. If continues_theme is true, say what changed since the last edition.
- "what_to_do_next": a specific move a builder can do this week, naming the move and a timeframe or decision date. "Keep an eye on this" fails.
- If you cannot write a credible what_to_do_next from the material, return {"drop":true,"reason":"..."}.
Return ONLY JSON: {"drop":false,"what_happened":"","why_it_matters":"","what_to_do_next":""}`;

const outcomes = await Promise.all(picks.map(async (p, idx) => {
  try {
    const recs = p.item_ids.map(id => byId[id]).filter(Boolean);
    if (!recs.length) throw new Error('picked item_ids not found');
    const sources = await Promise.all(recs.map(async r => ({
      title: r.getCellValueAsString('Title'), url: r.getCellValueAsString('URL'), feed: r.getCellValueAsString('Feed'),
      published: r.getCellValueAsString('Published'), rss_summary: r.getCellValueAsString('Summary'),
      page_text: await pageText(r.getCellValueAsString('URL')),
    })));
    const user = JSON.stringify({ today: new Date().toISOString().slice(0, 10), headline: p.headline, pillar: p.pillar, angle: p.angle,
      continues_theme: p.continues_theme, what_changed: p.what_changed, next_step_seed: p.next_step, allowed_urls: sources.map(s => s.url), sources });
    const out = parseObj(await claude(system, user, 1800, 'low'));
    if (out.drop) return { idx, dropped: p.headline + ': ' + (out.reason || 'no credible next step') };
    for (const k of ['what_happened', 'why_it_matters', 'what_to_do_next']) if (!out[k] || typeof out[k] !== 'string') throw new Error('missing ' + k);
    await base.getTable('Signals').createRecordAsync({
      'Headline': p.headline, 'Edition': [{ id: editionId }], 'Order': idx + 1, 'Pillar': { name: p.pillar },
      'What happened': out.what_happened.trim(), 'Why it matters': out.why_it_matters.trim(), 'What to do next': out.what_to_do_next.trim(),
      'Source URLs': sources.map(s => s.url).join('\n'), 'Source items': recs.map(r => ({ id: r.id })), 'Verified': false,
    });
    return { idx, ok: true };
  } catch (e) { return { idx, error: p.headline + ': ' + String(e.message || e) }; }
}));

const created = outcomes.filter(o => o.ok).length;
const problems = outcomes.filter(o => !o.ok).map(o => o.error || ('DROPPED ' + o.dropped));
await base.getTable('Run log').createRecordAsync({
  'Run': 'Editor write ' + new Date().toISOString().slice(0, 16), 'Step': { name: 'Editor' }, 'Edition': [{ id: editionId }], 'Ran at': new Date().toISOString(),
  'Sources used': picks.map(p => p.headline + ' <- ' + p.item_ids.map(id => (byId[id] ? byId[id].getCellValueAsString('URL') : id)).join(', ')).join('\n'),
  'Model calls': usage.calls, 'Input tokens': usage.inp, 'Output tokens': usage.out, 'Cost USD': usage.inp * RATE_IN + usage.out * RATE_OUT,
  'Errors': problems.join('\n'),
});
output.set('created', created);
