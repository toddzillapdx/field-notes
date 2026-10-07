// Field Notes, daily step 2: processing. Scores New items against the Charter pillars.
// Pure JS, no model calls, no secrets. Weights are code defaults; keywords and downweight tags live in the Charter.
const TITLE_W = 3, SUMMARY_W = 1, FUNDING_PENALTY = 6;
const FUND = /\b(raises?|raised|raising)\b[^.]{0,40}\$\s?\d|\bseries [a-f]\b|\bseed (round|funding)\b|\bfunding round\b|\bvaluation\b|\bvaluing\b|\bunicorn\b|\bventure (capital|firm|round)\b|\bipo\b|\bacquires?\b|\bacquisition\b|\bsecures? \$\d/i;

const charterT = base.getTable('Charter'), itemsT = base.getTable('Items'), logT = base.getTable('Run log');
const charter = (await charterT.selectRecordsAsync({ fields: ['Pillar keywords', 'Downweight category tags', 'Active'] })).records
  .find(r => r.getCellValue('Active'));
if (!charter) throw new Error('No active Charter record');

const pillars = charter.getCellValueAsString('Pillar keywords').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
  const i = l.indexOf(':');
  return { name: l.slice(0, i).trim(), kws: l.slice(i + 1).split(',').map(k => k.trim().toLowerCase()).filter(Boolean) };
});
const downTags = charter.getCellValueAsString('Downweight category tags').split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
for (const p of pillars) p.res = p.kws.map(k => new RegExp('(^|[^a-z0-9])' + esc(k) + '([^a-z0-9]|$)'));
const hits = (text, p) => p.res.filter(re => re.test(text)).length;

const now = Date.now();
const recs = (await itemsT.selectRecordsAsync({ fields: ['Title', 'Summary', 'Category tags', 'Published', 'Status'] })).records
  .filter(r => r.getCellValueAsString('Status') === 'New');

const updates = [];
for (const r of recs) {
  const title = r.getCellValueAsString('Title').toLowerCase(), summary = r.getCellValueAsString('Summary').toLowerCase();
  let best = { name: 'None', score: 0 };
  for (const p of pillars) {
    const s = hits(title, p) * TITLE_W + hits(summary, p) * SUMMARY_W;
    if (s > best.score) best = { name: p.name, score: s };
  }
  const tags = r.getCellValueAsString('Category tags').split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
  const down = tags.some(t => downTags.includes(t)) || FUND.test(title) || FUND.test(summary.slice(0, 400));
  const pub = r.getCellValue('Published');
  const ageDays = pub ? (now - new Date(pub).getTime()) / 86400000 : 99;
  const recency = ageDays <= 2 ? 2 : ageDays <= 4 ? 1 : 0;
  const final = Math.round((best.score + (best.score > 0 ? recency : 0) - (down ? FUNDING_PENALTY : 0)) * 10) / 10;
  updates.push({ id: r.id, fields: {
    'Pillar': { name: best.name }, 'Pillar score': best.score, 'Funding/VC downweight': down, 'Final score': final,
    'Status': { name: best.score > 0 && final > 0 ? 'Scored' : 'Rejected' },
  } });
}
for (let i = 0; i < updates.length; i += 50) await itemsT.updateRecordsAsync(updates.slice(i, i + 50));
const kept = updates.filter(u => u.fields.Status.name === 'Scored').length;
await logT.createRecordAsync({
  'Run': 'Process ' + new Date().toISOString().slice(0, 16), 'Step': { name: 'Process' }, 'Ran at': new Date().toISOString(),
  'Sources used': 'Charter: ' + pillars.length + ' pillars, ' + downTags.length + ' downweight tags', 'Model calls': 0,
  'Errors': updates.length ? '' : 'No new items to process',
});
output.set('scored', kept);
output.set('rejected', updates.length - kept);
