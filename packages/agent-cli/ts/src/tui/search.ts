import type { TranscriptLine } from './screen.js';

export interface SearchHit {
  line: number;
  snippet: string;
}

/** Case-insensitive hits over user, assistant, tool, reasoning, and tree text. */
export function searchHits(lines: readonly TranscriptLine[], query: string): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const hits: SearchHit[] = [];
  lines.forEach((line, index) => {
    const text = lineText(line);
    const at = text.toLowerCase().indexOf(needle);
    if (at < 0) return;
    hits.push({ line: index, snippet: snippetAt(text, at, needle.length) });
  });
  return hits;
}

export function searchLabel(query: string, hits: readonly SearchHit[], index: number): string {
  const shown = query.trim();
  if (!shown) return '搜索';
  if (hits.length === 0) return `搜索 ${shown}  无匹配`;
  const hit = hits[Math.min(index, hits.length - 1)] ?? hits[0];
  return `搜索 ${shown}  ${Math.min(index, hits.length - 1) + 1}/${hits.length}  ${hit?.snippet ?? ''}`;
}

function lineText(line: TranscriptLine): string {
  if (line.kind === 'tool') {
    return [line.name, line.args, line.output, line.diff].filter((part) => part && part.length > 0).join(' ');
  }
  return line.text ?? '';
}

function snippetAt(text: string, at: number, length: number): string {
  const start = Math.max(0, at - 8);
  const end = Math.min(text.length, at + length + 16);
  const slice = text.slice(start, end).replace(/\s+/g, ' ').trim();
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${slice}${suffix}`;
}
