// Field Notes, approval check (R8). Runs the morning after the draft is due. No model calls, no secrets.
// Nothing publishes unless Status = Approved. If the latest non-shadow edition is still Draft, write an Alert row and expose
// alert=true so a downstream email/Slack step can notify Todd. Shadow-mode editions never alert (they are private by design).
const eds = (await base.getTable('Editions').selectRecordsAsync({ fields: ['Title', 'Week of', 'Status', 'Shadow mode'] })).records
  .sort((a, b) => b.getCellValueAsString('Week of').localeCompare(a.getCellValueAsString('Week of')));
const latest = eds[0];
let alert = false, message = 'No editions yet';
if (latest) {
  const status = latest.getCellValueAsString('Status'), shadow = !!latest.getCellValue('Shadow mode');
  if (status === 'Draft' && !shadow) {
    alert = true;
    message = 'MISSED APPROVAL: "' + latest.getCellValueAsString('Title') + '" is still Draft. Nothing will publish until you set Status to Approved.';
  } else {
    message = '"' + latest.getCellValueAsString('Title') + '": ' + status + (shadow ? ' (shadow mode, private)' : '') + '. No alert.';
  }
}
if (alert) {
  await base.getTable('Run log').createRecordAsync({
    'Run': 'Approval check ' + new Date().toISOString().slice(0, 16), 'Step': { name: 'Alert' }, 'Edition': [{ id: latest.id }],
    'Ran at': new Date().toISOString(), 'Model calls': 0, 'Errors': message,
  });
}
output.set('alert', alert);
output.set('message', message);
