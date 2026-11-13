import fs from 'node:fs/promises';
import path from 'node:path';

interface ArtifactCapture {
  caseId: string;
  screen(): string;
  trace(): readonly string[];
}

let captures: ArtifactCapture[] = [];

export function resetTuiArtifactCaptures(): void {
  captures = [];
}

export function registerTuiArtifact(
  caseId: string,
  screen: () => string,
  trace: () => readonly string[] = () => [],
): void {
  captures.push({ caseId, screen, trace });
}

export async function writeTuiFailureArtifacts(error: string): Promise<void> {
  const root = process.env.TUI_ARTIFACT_DIR
    ?? path.resolve(import.meta.dirname, '../test-results/tui');
  await Promise.all(captures.map(async (capture, index) => {
    const suffix = captures.length > 1 ? `-${index + 1}` : '';
    const dir = path.join(root, `${safeName(capture.caseId)}${suffix}`);
    await fs.mkdir(dir, { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(dir, 'screen.txt'), `${capture.screen()}\n`),
      fs.writeFile(path.join(dir, 'trace.json'), `${JSON.stringify(capture.trace(), null, 2)}\n`),
      fs.writeFile(path.join(dir, 'process.log'), `${error}\n`),
      fs.writeFile(path.join(dir, 'environment.json'), `${JSON.stringify({
        caseId: capture.caseId,
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        term: process.env.TERM ?? null,
        lang: process.env.LANG ?? null,
      }, null, 2)}\n`),
    ]);
  }));
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '-');
}
