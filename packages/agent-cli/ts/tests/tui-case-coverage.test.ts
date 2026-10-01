import fs from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const CASE_IDS = [
  'TUI-001', 'TUI-001A', 'TUI-002', 'TUI-003', 'TUI-004', 'TUI-005', 'TUI-006',
  'TUI-010', 'TUI-011', 'TUI-012', 'TUI-013', 'TUI-014', 'TUI-015', 'TUI-016',
  'TUI-020', 'TUI-021', 'TUI-022', 'TUI-023', 'TUI-024', 'TUI-025', 'TUI-026',
  'TUI-027', 'TUI-028',
  'TUI-030', 'TUI-031', 'TUI-032', 'TUI-033', 'TUI-034', 'TUI-035', 'TUI-036',
  'TUI-037',
  'TUI-040', 'TUI-041', 'TUI-042', 'TUI-043', 'TUI-044', 'TUI-045', 'TUI-046',
  'TUI-050', 'TUI-051', 'TUI-052', 'TUI-053', 'TUI-054', 'TUI-055', 'TUI-056',
  'TUI-060', 'TUI-061A', 'TUI-061B', 'TUI-061C',
  'TUI-062A', 'TUI-062B', 'TUI-062C', 'TUI-062D', 'TUI-062E',
  'TUI-063A', 'TUI-063B', 'TUI-064A', 'TUI-065',
  'TUI-066A', 'TUI-066B', 'TUI-066C', 'TUI-067', 'TUI-068', 'TUI-069',
  'TUI-070', 'TUI-071', 'TUI-072A', 'TUI-072B', 'TUI-073', 'TUI-074', 'TUI-075',
  'TUI-076', 'TUI-078',
  'TUI-080', 'TUI-081', 'TUI-082', 'TUI-083', 'TUI-084', 'TUI-085',
  'TUI-090', 'TUI-091', 'TUI-092', 'TUI-093', 'TUI-094', 'TUI-095', 'TUI-096',
  'TUI-120', 'TUI-121', 'TUI-122', 'TUI-123',
] as const;

describe('documented TUI case traceability', () => {
  it('maps every documented case ID to an executable test', async () => {
    const testDirectory = import.meta.dirname;
    const files = (await fs.readdir(testDirectory))
      .filter((file) => file.endsWith('.test.ts') && file !== path.basename(import.meta.filename));
    const sources = await Promise.all(files.map((file) => fs.readFile(path.join(testDirectory, file), 'utf8')));
    const implemented = new Set(sources.flatMap((source) => source.match(/TUI-\d{3}[A-Z]?/g) ?? []));
    const documented = new Set<string>(CASE_IDS);

    expect(CASE_IDS).toHaveLength(90);
    expect([...documented].filter((id) => !implemented.has(id))).toEqual([]);
    expect([...implemented].filter((id) => !documented.has(id))).toEqual([]);
  });
});
