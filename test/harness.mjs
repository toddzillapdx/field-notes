// Local harness: runs the Airtable scripts against an in-memory mock base, fake RSS feeds and a fake Claude API.
// Verifies parsing, dedupe, scoring, hand-offs and verification logic. It does NOT test real Airtable or real model output.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.join(here, '..', 'airtable', 'scripts');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// ---------- mock base ----------
const PRIMARY = { Feeds: 'Name', Editions: 'Title', Items: 'Title', Signals: 'Headline', Charter: 'Name', 'Run log': 'Run' };
const LINK_TARGET = { Feed: 'Feeds', Edition: 'Editions', 'Source items': 'Items' };
const tables = {};
let seq = 0;
const T = n => (tables[n] ||= []);
const nid = () => 'rec' + String(++seq).padStart(14, '0');
function mkRecord(tableName, row) {
  return {
    id: row.id,
    getCellValue: f => {
      const v = row.fields[f];
      if (v === undefined) return null;
      if (v && typeof v === 'object' && !Array.isArray(v) && v.name) return { id: 'sel' + v.name, name: v.name };
      if (Array.isArray(v)) return v.map(x => ({ id: x.id, name: nameOf(LINK_TARGET[f], x.id) }));
      return v;
    },
    getCellValueAsString: f => {
      const v = row.fields[f];
      if (v === undefined || v === null) return '';
      if (Array.isArray(v)) return v.map(x => nameOf(LINK_TARGET[f], x.id)).join(', ');
      if (typeof v === 'object') return v.name;
      return String(v);
    },
  };
}
function nameOf(tn, id) { const r = (tables[tn] || []).find(x => x.id === id); return r ? String(r.fields[PRIMARY[tn]] ?? '') : id; }
const base = {
  getTable: n => ({
    selectRecordsAsync: async () => ({ records: T(n).map(r => mkRecord(n, r)) }),
    selectRecordAsync: async id => { const r = T(n).find(x => x.id === id); return r ? mkRecord(n, r) : null; },
    createRecordAsync: async f => { const id = nid(); T(n).push({ id, fields: { ...f } }); return id; },
    createRecordsAsync: async arr => arr.map(a => { const id = nid(); T(n).push({ id, fields: { ...a.fields } }); return id; }),
    updateRecordAsync: async (id, f) => { Object.assign(T(n).find(x => x.id === id).fields, f); },
    updateRecordsAsync: async arr => { arr.forEach(a => Object.assign(T(n).find(x => x.id === a.id).fields, a.fields)); },
  }),
};

// ---------- fake network ----------
const hoursAgo = h => new Date(Date.now() - h * 3600e3);
const rss = (items) => `<?xml version="1.0"?><rss version="2.0"><channel><title>x</title>${items.map(i => `<item><title>${i.t}</title><link>${i.l}</link><pubDate>${hoursAgo(i.h).toUTCString()}</pubDate><description><![CDATA[<p>${i.d}</p>]]></description>${(i.c || []).map(c => `<category>${c}</category>`).join('')}</item>`).join('')}</channel></rss>`;
const atom = (items) => `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>y</title>${items.map(i => `<entry><title>${i.t}</title><link rel="alternate" href="${i.l}?utm_source=feed"/><link rel="self" href="${i.l}.json"/><published>${hoursAgo(i.h).toISOString()}</published><summary>${i.d}</summary></entry>`).join('')}</feed>`;
const FEEDS = {
  'https://tc.test/feed': rss([
    { t: 'Startup raises $50M Series B for agent platform', l: 'https://tc.test/a1', h: 5, d: 'Funding round led by a venture firm for an AI agent startup.', c: ['Fundraising', 'Venture'] },
    { t: 'Open-weight model runs locally on a laptop with llama.cpp', l: 'https://tc.test/a2', h: 8, d: 'A new open source model with a permissive license and gguf quantization.' },
    { t: 'Celebrity gossip roundup', l: 'https://tc.test/a3', h: 3, d: 'Nothing about technology.' },
  ]),
  'https://sw.test/atom': atom([
    { t: 'Prompt injection in coding agents: sandbox your MCP tools', l: 'https://sw.test/p1', h: 10, d: 'Security research on agent sandbox escapes and guardrails.' },
    { t: 'Old post', l: 'https://sw.test/old', h: 24 * 30, d: 'agent harness' },
  ]),
  'https://dead.test/feed': null,
  'https://notrss.test/page': '<html><body>hello</body></html>',
};
const claudeCalls = [];
function claudeReply(system, userStr) {
  const u = JSON.parse(userStr);
  let obj;
  if (system.includes('YOU ARE THE EDITOR. Pick') || system.includes('Pick the 3 to 5 signals')) {
    obj = { signals: u.candidates.slice(0, 3).map((c, i) => ({ headline: 'Signal ' + (i + 1) + ': ' + c.title.slice(0, 40), pillar: c.pillar, item_ids: [c.item_id], continues_theme: false, what_changed: '', angle: 'a', next_step: 'Try it by Friday' })), cut: [], note: '' };
  } else if (system.includes('writing one signal')) {
    if (u.headline.includes('Signal 3')) obj = { drop: true, reason: 'no credible next step' };
    else obj = { drop: false, what_happened: `It happened. Details are here [source](${u.allowed_urls[0]}). More follows.`, why_it_matters: 'It changes how builders ship.', what_to_do_next: 'Test it on one repo by Friday.' };
  } else if (system.includes('Rewrite one signal')) {
    obj = { what_happened: 'Here is what I saw. ' + u.what_happened, why_it_matters: 'I think ' + u.why_it_matters, what_to_do_next: u.what_to_do_next };
  } else if (system.includes('opening note')) obj = { opening_note: 'This week I kept thinking about agents.' };
  else if (system.includes('image-generation prompt')) obj = { prompt: 'A lighthouse on a grid of circuit traces. ' + u.house_style };
  else throw new Error('unrecognized system prompt');
  return obj;
}
async function fakeFetch(url, opts = {}) {
  if (url.startsWith('https://api.anthropic.com/')) {
    assert.equal(opts.headers['x-api-key'], 'sk-test'); // secret wired
    const body = JSON.parse(opts.body);
    claudeCalls.push({ model: body.model, effort: body.output_config.effort, fallbacks: body.fallbacks });
    const obj = claudeReply(body.system, body.messages[0].content);
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: '```json\n' + JSON.stringify(obj) + '\n```' }], stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 200 } }) };
  }
  if (url in FEEDS) {
    if (FEEDS[url] === null) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => FEEDS[url] };
  }
  if (url.includes('blocked.test')) return { ok: false, status: 403, text: async () => '' };
  if (url.includes('gone.test')) return { ok: false, status: 404, text: async () => '' };
  return { ok: true, status: 200, text: async () => '<html><body><script>x</script><p>Article body text about the topic.</p></body></html>' };
}

// ---------- runner ----------
async function run(file, cfg = {}) {
  const out = {};
  const code = fs.readFileSync(path.join(scriptsDir, file), 'utf8');
  const input = { config: () => cfg, get: k => cfg[k], secret: n => { assert.equal(n, 'ANTHROPIC_API_KEY'); return 'sk-test'; } };
  const output = { set: (k, v) => { out[k] = v; } };
  await new AsyncFunction('base', 'input', 'output', 'fetch', 'console', code)(base, input, output, fakeFetch, console);
  return out;
}
const rows = n => T(n).map(r => r.fields);
const get = (tn, id) => T(tn).find(r => r.id === id).fields;

// ---------- seed (mirrors the real base seed) ----------
const charterId = nid();
T('Charter').push({ id: charterId, fields: {
  Name: 'Charter', Active: true,
  Lens: 'lens', Voice: 'voice', Exclusions: 'excl', 'Technical point of view': 'tech', 'Signal format': 'fmt',
  Pillars: '1. Builder tools and agents (x)\n2. Open source and local models (y)\n3. Trust and security (z)\n4. Products and people (w)',
  'Pillar keywords': 'Builder tools and agents: coding agent, agent, mcp, harness\nOpen source and local models: open source, open weights, local model, llama.cpp, gguf, license\nTrust and security: security, sandbox, prompt injection, guardrail\nProducts and people: retail, consumer',
  'Downweight category tags': 'Fundraising, Venture, Funding',
} });
const feedIds = {};
for (const [name, url, status] of [['TechCrunch', 'https://tc.test/feed', 'Active'], ['Willison', 'https://sw.test/atom', 'Active'], ['Dead', 'https://dead.test/feed', 'Active'], ['NotRSS', 'https://notrss.test/page', 'To validate'], ['Suggested1', 'https://tc.test/feed', 'Suggested']]) {
  const id = nid(); feedIds[name] = id; T('Feeds').push({ id, fields: { Name: name, URL: url, Status: { name: status }, Notes: 'orig note' } });
}

// ---------- daily ----------
let o = await run('01-scrape.js');
assert.equal(o.newItems, 4, 'scrape: 3 TC + 1 Willison recent (old post skipped)'); // tc has 3, sw has 1 within 10d
assert.equal(o.feedErrors, 2, 'scrape: dead feed 404 + NotRSS parse failure');
const items = rows('Items');
assert.ok(items.every(i => i['Dedupe key'] && !i['Dedupe key'].includes('utm_')));
assert.ok(items.some(i => i['Dedupe key'] === 'https://sw.test/p1'), 'atom alternate link + utm stripped');
assert.equal(get('Feeds', feedIds.Suggested1)['Status'].name, 'Suggested', 'never activates feeds');
assert.match(get('Feeds', feedIds.Suggested1)['Notes'], /validated .* OK, 3 items/);
assert.equal(get('Feeds', feedIds.Dead)['Last error'], 'HTTP 404');
o = await run('01-scrape.js');
assert.equal(o.newItems, 0, 'dedupe: second run adds nothing');

o = await run('02-process.js');
const byTitle = t => rows('Items').find(i => i.Title.startsWith(t));
assert.equal(byTitle('Startup raises')['Funding/VC downweight'], true);
assert.equal(byTitle('Startup raises')['Status'].name, 'Rejected', 'funding item downweighted out');
assert.equal(byTitle('Open-weight')['Pillar'].name, 'Open source and local models');
assert.equal(byTitle('Open-weight')['Status'].name, 'Scored');
assert.equal(byTitle('Prompt injection')['Pillar'].name, 'Trust and security');
assert.equal(byTitle('Celebrity')['Status'].name, 'Rejected');
assert.equal(o.scored, 2);
console.log('daily OK:', rows('Items').map(i => `${i.Status.name} ${i['Final score']} ${i.Pillar.name}: ${i.Title.slice(0, 40)}`));

// ---------- weekly ----------
o = await run('03-create-edition.js');
const editionId = o.editionId;
assert.equal(get('Editions', editionId).Status.name, 'Draft');
assert.equal(get('Editions', editionId)['Shadow mode'], true);
assert.equal((await run('03-create-edition.js')).editionId, editionId, 'idempotent per week');

o = await run('04-editor-select.js', { editionId });
const picks = o.picks;
assert.equal(o.count, 2, 'only 2 candidates scored; no backfill');
assert.match(get('Editions', editionId)['Raw RSS digest'], /Celebrity gossip/, 'digest is unfiltered');

// force 3 picks for the downstream test by adding a third scored item
const extra = nid();
T('Items').push({ id: extra, fields: { Title: 'Coding agent harness ships MCP support', URL: 'https://tc.test/a9', Feed: [{ id: feedIds.TechCrunch }], Published: hoursAgo(2).toISOString(), Fetched: new Date().toISOString(), Summary: 'agent harness mcp', Pillar: { name: 'Builder tools and agents' }, 'Final score': 9, Status: { name: 'Scored' } } });
const dead = nid();
T('Items').push({ id: dead, fields: { Title: 'Coding agent source that is dead', URL: 'https://gone.test/x', Feed: [{ id: feedIds.Willison }], Published: hoursAgo(1).toISOString(), Fetched: new Date().toISOString(), Summary: 'agent', Pillar: { name: 'Builder tools and agents' }, 'Final score': 8, Status: { name: 'Scored' } } });
o = await run('04-editor-select.js', { editionId });
assert.equal(o.count, 3);

o = await run('05-editor-write.js', { editionId, picks: o.picks });
assert.equal(o.created, 2, 'one signal dropped by editor for no credible next step');
const sigRows = rows('Signals');
assert.ok(sigRows.every(s => s['Source URLs'] && s['Verified'] === false));

// make one signal fabricate a link and one point at a dead URL to exercise verification
T('Signals')[0].fields['Why it matters'] += ' See https://invented.test/nope for more.';
o = await run('06-verify.js', { editionId });
assert.equal(o.verified, 1);
assert.equal(o.dropped, 1);
assert.match(T('Signals')[0].fields['Verification note'], /DROPPED: link\(s\) not in source list/);
T('Signals')[0].fields['Why it matters'] = T('Signals')[0].fields['Why it matters'].replace(' See https://invented.test/nope for more.', '');
// re-verify as a clean set
o = await run('06-verify.js', { editionId });
const verifiedNow = rows('Signals').filter(s => s.Verified).length;
assert.ok(verifiedNow >= 1);

o = await run('07-columnist.js', { editionId });
assert.equal(o.voiced, verifiedNow);
assert.equal(get('Editions', editionId)['Opening note'], 'This week I kept thinking about agents.');
assert.match(rows('Signals').find(s => s.Verified)['What happened'], /^Here is what I saw\./);

o = await run('08-hero-prompt.js', { editionId });
const ed = get('Editions', editionId);
assert.match(ed['Hero image prompt'], /lighthouse/);
assert.match(ed['Sources'], /https?:\/\//);
assert.equal(ed.Status.name, 'Draft', 'nothing flips to Approved automatically');

// approval check: shadow edition does not alert; non-shadow does
assert.equal((await run('09-approval-check.js')).alert, false);
ed['Shadow mode'] = false;
assert.equal((await run('09-approval-check.js')).alert, true);
ed.Status = { name: 'Approved' };
assert.equal((await run('09-approval-check.js')).alert, false);

// run log
const logs = rows('Run log');
const modelRows = logs.filter(l => l['Model calls'] > 0);
assert.ok(modelRows.length >= 4 && modelRows.every(l => l['Cost USD'] > 0 && l['Input tokens'] > 0));
assert.ok(claudeCalls.every(c => c.model === 'claude-opus-5-5' && c.effort === 'low' && c.fallbacks === 'default'));
console.log('weekly OK. model calls:', claudeCalls.length, '| log rows:', logs.length, '| steps:', [...new Set(logs.map(l => l.Step.name))].join(', '));
console.log('ALL HARNESS CHECKS PASSED');
