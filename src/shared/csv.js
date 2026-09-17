// RFC 4180 호환 CSV 파서 (plan 4-5, T5.0)

export const MAX_FIELD_LEN = 10_000;
export const MAX_ROWS = 200_000;

/**
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const pushField = () => {
    if (field.length > MAX_FIELD_LEN) {
      throw new RangeError('field too long');
    }
    row.push(field);
    field = '';
  };

  const pushRow = () => {
    if (row.length > 0 || field.length > 0) {
      pushField();
      rows.push(row);
      row = [];
    }
    if (rows.length > MAX_ROWS) {
      throw new RangeError('too many rows');
    }
  };

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      pushField();
      i++;
      continue;
    }
    if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      pushRow();
      i++;
      continue;
    }
    if (ch === '\n') {
      pushRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }

  if (field.length > 0 || row.length > 0 || inQuotes) {
    if (inQuotes) throw new SyntaxError('unclosed quote');
    pushRow();
  }

  return rows;
}

/**
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
export function decodeCsvUtf8(buffer) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = decoder.decode(buffer);
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  return text;
}

/**
 * @param {string[][]} rows
 */
export function rowsToObjects(rows) {
  if (!rows.length) return { headers: [], records: [] };
  const headers = rows[0].map((h) => h.trim());
  const records = [];
  for (let r = 1; r < rows.length; r++) {
    const line = rows[r];
    if (!line.some((c) => c.trim())) continue;
    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = line[c] ?? '';
    }
    records.push(obj);
  }
  return { headers, records };
}
