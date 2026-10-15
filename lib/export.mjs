export async function fetchWaitlistRows(store) {
  const records = [];
  for (let offset = 0; offset < 100000; offset += 500) {
    const response = await store.request(`?select=email,interest,use_case,created_at&order=created_at.asc,id.asc&limit=500&offset=${offset}`);
    if (!response.ok) throw new Error('Export could not read storage.');
    const rows = await response.json();
    if (!Array.isArray(rows) || rows.length > 500 || rows.some(row => typeof row.email !== 'string')) throw new Error('Unexpected export data.');
    records.push(...rows);
    if (rows.length < 500) return records;
  }
  throw new Error('Export size exceeded the demo export limit.');
}

export function waitlistCsv(records) {
  const fields = ['email', 'interest', 'use_case', 'created_at'];
  const cell = value => {
    let text = String(value ?? '');
    // Keep submitted use-case text from becoming a spreadsheet formula.
    if (/^[\s]*[=+\-@]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  return [fields.map(cell).join(','), ...records.map(record => fields.map(field => cell(record[field])).join(','))].join('\r\n') + '\r\n';
}
