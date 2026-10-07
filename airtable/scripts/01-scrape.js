// Field Notes, daily step 1: RSS scrape.
// Airtable automation script (Node 22). No inputs, no secrets.
// Reads Feeds (Active = store items; To validate / Suggested = validate only, never activated here),
// writes Items, updates Feeds.Last fetched / Last error, appends a Run log row.
const TZ = 'America/New_York';
const MAX_AGE_DAYS = 10;
const FETCH_MS = 12000;

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout after ' + ms + 'ms')), ms))]);
}
function weekMonday(d) {
  const [y, m, da] = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, da));
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
  return t.toISOString().slice(0, 10);
}
function decode(s) {
  return String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&amp;/g, '&');
}
function strip(s) { return decode(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }
function tag(block, name) {
  const m = block.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i'));
  return m ? m[1] : '';
}
function parseFeed(xml) {
  const items = [];
  const re = /<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const b = m[2];
    let link = strip(tag(b, 'link'));
    if (!/^https?:/i.test(link)) {
      const links = [...b.matchAll(/<link\b([^>]*)>/gi)].map(x => x[1]);
      const alt = links.find(a => /rel=["']alternate["']/i.test(a)) || links.find(a => !/rel=/i.test(a)) || links[0];
      const hm = alt && alt.match(/href=["']([^"']+)["']/i);
      link = hm ? decode(hm[1]) : '';
    }
    if (!/^https?:/i.test(link)) { const g = strip(tag(b, 'guid')); link = /^https?:/i.test(g) ? g : ''; }
    const cats = [...b.matchAll(/<category\b([^>]*?)(?:\/>|>([\s\S]*?)<\/category>)/gi)].map(x => {
      const t = x[1].match(/term=["']([^"']+)["']/i);
      return strip(t ? t[1] : (x[2] || ''));
    }).filter(Boolean);
    const dateRaw = strip(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date'));
    const d = dateRaw ? new Date(dateRaw) : null;
    items.push({
      title: strip(tag(b, 'title')),
      link,
      published: d && !isNaN(d) ? d.toISOString() : null,
      summary: strip(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content:encoded') || tag(b, 'content')).slice(0, 1500),
      cats,
    });
  }
  return items;
}
function normUrl(u) {
  try {
    const x = new URL(u);
    x.hash = '';
    [...x.searchParams.keys()].filter(k => /^(utm_|mc_|fbclid$|gclid$|ref_src$)/i.test(k)).forEach(k => x.searchParams.delete(k));
    return x.protocol + '//' + x.host.toLowerCase().replace(/^www\./, '') + x.pathname.replace(/\/+$/, '') + x.search;
  } catch (e) { return String(u || '').trim(); }
}

const feedsT = base.getTable('Feeds'), itemsT = base.getTable('Items'), logT = base.getTable('Run log');
const now = new Date(), nowISO = now.toISOString(), week = weekMonday(now);
const cutoff = now.getTime() - MAX_AGE_DAYS * 86400000;

const feeds = (await feedsT.selectRecordsAsync({ fields: ['Name', 'URL', 'Status', 'Notes'] })).records
  .filter(r => ['Active', 'To validate', 'Suggested'].includes(r.getCellValueAsString('Status')) && r.getCellValueAsString('URL'));
const seen = new Set((await itemsT.selectRecordsAsync({ fields: ['Dedupe key'] })).records.map(r => r.getCellValueAsString('Dedupe key')));

const results = await Promise.all(feeds.map(async rec => {
  const name = rec.getCellValueAsString('Name'), url = rec.getCellValueAsString('URL'), status = rec.getCellValueAsString('Status');
  try {
    const res = await withTimeout(fetch(url, { redirect: 'follow', headers: { 'user-agent': 'FieldNotesBot/0.1 (personal editorial column)', accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' } }), FETCH_MS);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const parsed = parseFeed(await res.text());
    if (!parsed.length) throw new Error('fetched but no items parsed (not an RSS/Atom feed?)');
    return { rec, name, status, ok: true, parsed };
  } catch (e) { return { rec, name, status, ok: false, err: String(e.message || e) }; }
}));

const toCreate = [], feedUpdates = [], srcLines = [], errLines = [];
for (const r of results) {
  const upd = { 'Last fetched': nowISO, 'Last error': r.ok ? '' : r.err };
  let added = 0;
  if (r.ok) {
    const newest = r.parsed.map(i => i.published).filter(Boolean).sort().pop() || 'n/a';
    if (r.status === 'Active') {
      for (const it of r.parsed) {
        if (!it.link || !it.title) continue;
        if (it.published && new Date(it.published).getTime() < cutoff) continue;
        const key = normUrl(it.link);
        if (seen.has(key)) continue;
        seen.add(key); added++;
        toCreate.push({ fields: {
          'Title': it.title, 'URL': it.link, 'Feed': [{ id: r.rec.id }], 'Published': it.published, 'Fetched': nowISO,
          'Summary': it.summary, 'Category tags': it.cats.join(', '), 'Dedupe key': key, 'Status': { name: 'New' }, 'Week of': week,
        } });
      }
      srcLines.push(r.name + ': ' + added + ' new of ' + r.parsed.length + ' in feed');
    } else {
      const prev = r.rec.getCellValueAsString('Notes').split('\n').filter(l => !l.startsWith('[validated')).join('\n');
      upd['Notes'] = (prev + '\n[validated ' + nowISO.slice(0, 10) + '] OK, ' + r.parsed.length + ' items, newest ' + newest + '. Not activated; Todd approves.').trim();
      srcLines.push(r.name + ' (' + r.status + ', validation only): OK, ' + r.parsed.length + ' items');
    }
  } else {
    errLines.push(r.name + ': ' + r.err);
    srcLines.push(r.name + ': FAILED');
  }
  feedUpdates.push({ id: r.rec.id, fields: upd });
}

for (let i = 0; i < toCreate.length; i += 50) await itemsT.createRecordsAsync(toCreate.slice(i, i + 50));
for (let i = 0; i < feedUpdates.length; i += 50) await feedsT.updateRecordsAsync(feedUpdates.slice(i, i + 50));
await logT.createRecordAsync({
  'Run': 'Scrape ' + nowISO.slice(0, 16), 'Step': { name: 'Scrape' }, 'Ran at': nowISO,
  'Sources used': srcLines.join('\n'), 'Model calls': 0, 'Errors': errLines.join('\n'),
});
output.set('newItems', toCreate.length);
output.set('feedErrors', errLines.length);
