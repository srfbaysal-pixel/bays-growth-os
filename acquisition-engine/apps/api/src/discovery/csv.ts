import type { DiscoveredBusiness } from './types.js';

/** Basit CSV ayrıştırıcı (tırnaklı alan destekli). Başlıklar: name,website,phone,email,city,district,address,instagram */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  const header = (rows.shift() ?? []).map((h) => h.trim().toLowerCase());
  return rows.filter((r) => r.some((x) => x.trim())).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

export function csvToBusinesses(text: string): DiscoveredBusiness[] {
  return parseCsv(text).filter((r) => r.name).map((r) => ({
    source_key: 'csv_import',
    name: r.name,
    website: r.website || null,
    phone: r.phone || null,
    email: r.email || null,
    city: r.city || null,
    district: r.district || null,
    address: r.address || null,
    instagram_handle: r.instagram || null
  }));
}
