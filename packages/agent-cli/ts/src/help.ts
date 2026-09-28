const EXAMPLES = `
Examples:
  <product> run "列出当前目录" --approve allow-read --stream-json
  <product> run --chat <id> "继续"
  <product> chat list
  <product> doctor
`.trim();

export function rootHelp(): string {
  return `
Usage:
  <product> run "<task>" [--chat <id>] [--approve deny|allow-read|allow-all]
                         [--json | --stream-json] [--cwd <dir>] [--timeout <dur>]
                         [--data-dir <dir>] [--agent <id>] [--file <path>...]
  <product> chat list
  <product> doctor

${EXAMPLES}
`.trim();
}

export function runHelp(): string {
  return `
Usage:
  <product> run "<task>" [--chat <id>] [--approve deny|allow-read|allow-all]
                         [--json | --stream-json] [--data-dir <dir>]

--approve deny is the default. A denied approval exits 3. A busy chat exits 6.

${EXAMPLES}
`.trim();
}

export function chatHelp(): string {
  return `
Usage:
  <product> chat list [--data-dir <dir>]

Examples:
  <product> chat list
`.trim();
}

export function doctorHelp(): string {
  return `
Usage:
  <product> doctor [--data-dir <dir>]

Examples:
  <product> doctor
`.trim();
}
