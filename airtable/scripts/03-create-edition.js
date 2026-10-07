// Field Notes, weekly step 1: create (or reuse) this week's Draft Edition record. No secrets, no model calls.
const TZ = 'America/New_York';
const [y, m, da] = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).split('-').map(Number);
const t = new Date(Date.UTC(y, m - 1, da));
t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
const week = t.toISOString().slice(0, 10);

const editionsT = base.getTable('Editions');
const existing = (await editionsT.selectRecordsAsync({ fields: ['Week of'] })).records.find(r => r.getCellValueAsString('Week of') === week);
let id = existing ? existing.id : null;
if (!id) {
  id = await editionsT.createRecordAsync({
    'Title': 'Field Notes: week of ' + week, 'Week of': week, 'Status': { name: 'Draft' },
    'Shadow mode': true, // first two editions stay private to Todd (R9). Untick once he lifts shadow mode.
  });
}
output.set('editionId', id);
output.set('week', week);
output.set('reused', !!existing);
