export function jsonToCsv(data: Record<string, unknown>[]): string {
  if (data.length === 0) return '';

  // Flatten nested objects to dot notation
  function flatten(obj: Record<string, unknown>, prefix = ''): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(obj)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
        Object.assign(result, flatten(value as Record<string, unknown>, fullKey));
      } else {
        result[fullKey] = value === null || value === undefined ? '' : String(value);
      }
    }
    return result;
  }

  const flatRows = data.map((row) => flatten(row));
  const headers = [...new Set(flatRows.flatMap((r) => Object.keys(r)))];

  const csvLines = [
    headers.map((h) => `"${h.replace(/"/g, '""')}"`).join(','),
    ...flatRows.map((row) =>
      headers
        .map((h) => {
          const val = row[h] ?? '';
          return `"${String(val).replace(/"/g, '""')}"`;
        })
        .join(','),
    ),
  ];

  return csvLines.join('\n');
}
