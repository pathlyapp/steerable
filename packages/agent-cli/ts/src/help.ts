import { exitCodeHelp } from './exit-codes.js';

const EXAMPLES = `
Examples:
  <product> login
  <product> run "列出当前目录" --approve allow-read --stream-json
  <product> run --chat <id> "继续"
  <product> chat list
  <product> chat show <id>
  <product> chat export <id> --format md
  <product> skills list
  <product> mcp list
  <product> config get model
  <product> doctor
  <product> tui
`.trim();

export function rootHelp(commands: readonly { name: string; summary: string }[] = []): string {
  const extra = commands
    .map((command) => `  <product> ${command.name}    ${command.summary}`)
    .join('\n');
  const pack = extra ? `\n${extra}` : '';
  return `
Usage:
  <product> run "<task>" [--chat <id>] [--approve deny|allow-read|allow-all]
                         [--json | --stream-json] [--project <dir> | --cwd <dir> | --no-project] [--trust]
                         [--timeout <dur>] [--data-dir <dir>] [--agent <id>] [--file <path>...]
                         [--no-preflight] [--verbose]
  <product> login | logout
  <product> web [--port <n>]
  <product> chat list | show <id> | rm <id> | export <id> [--format md|json]
  <product> children list [--session <id>] [--active] | answer --child <id> [--wait]
  <product> skills list
  <product> mcp list | add <name> -- <cmd...> | rm <name>
  <product> config get <key> | set <key> <value>
  <product> doctor [--json] [--deep] [--verbose]
  <product> tui${pack}

Options:
  -h, --help       Show this text.
  -v, --version    Print the CLI version.

${EXAMPLES}

${exitCodeHelp()}
`.trim();
}

export function runHelp(): string {
  return `
Usage:
  <product> run "<task>" [--chat <id>] [--approve deny|allow-read|allow-all]
                         [--json | --stream-json] [--project <dir> | --cwd <dir> | --no-project] [--trust]
                         [--data-dir <dir>]

--approve deny is the default.
run binds the current directory as a project. --project and --cwd name that directory.
--no-project keeps a workspace per chat.
--trust marks that project trusted and loads its rule files. It cannot be combined with --no-project.
STEERABLE_APPROVAL=0 turns the approval layer off for this process. A destructive tool
is then rejected by the tool router. Use --approve allow-all to allow those tools instead.

Before the first request run checks that a model credential is configured. Without one it
prints how to set it and exits 78 without contacting the model service. --no-preflight skips
that check. The key comes from settings or from the provider's environment variable, for
example DEEPSEEK_API_KEY. --verbose prints stacks and the log path.

${EXAMPLES}

${exitCodeHelp()}
`.trim();
}

export function childrenHelp(): string {
  return `
Usage:
  <product> children list [--session <id>] [--json] [--active] [--data-dir <dir>]
  <product> children answer --session <id> --child <id> [--wait] [--json]

Children are the sub-agents a session spawned. They outlive the turn that
created them, so this keeps working after a restart — a child that never
finished is reported as interrupted and can be resumed by its parent.

--active lists only children that are not in a terminal state.
--session defaults to the most recent session in the data directory.

Examples:
  <product> children list
  <product> children list --session 8c1e4f2a --active
  <product> children answer --session 8c1e4f2a --child 0.2
`.trim();
}

export function chatHelp(): string {
  return `
Usage:
  <product> chat list [--json] [--data-dir <dir>]
  <product> chat show <id> [--json]
  <product> chat rm <id>
  <product> chat export <id> [--format md|json]

rm of a chat held by another process exits 6.

Examples:
  <product> chat list
  <product> chat show <id>
  <product> chat export <id> --format md
`.trim();
}

export function skillsHelp(): string {
  return `
Usage:
  <product> skills list [--json] [--data-dir <dir>]

Examples:
  <product> skills list
`.trim();
}

export function mcpHelp(): string {
  return `
Usage:
  <product> mcp list [--json]
  <product> mcp add <name> -- <cmd...>
  <product> mcp rm <name>

Examples:
  <product> mcp add files -- npx -y @modelcontextprotocol/server-filesystem .
  <product> mcp rm files
`.trim();
}

export function configHelp(): string {
  return `
Usage:
  <product> config get <key>
  <product> config set <key> <value>

Keys: provider, vendorId, model, baseUrl, apiKey, temperature, systemPrompt,
maxTotalTokens, execTimeoutSeconds.

Examples:
  <product> config get model
  <product> config set model demo-model
`.trim();
}

export function tuiHelp(): string {
  return `
Usage:
  <product> tui [--project <dir> | --cwd <dir> | --no-project] [--trust]
               [--approve deny|allow-read|allow-all] [--data-dir <dir>]

Starts the terminal interface in the current directory's project.
--no-project keeps a workspace per chat.
--trust marks that project trusted and loads its rule files. It cannot be combined with --no-project.
STEERABLE_APPROVAL=0 turns the approval layer off for this process. A destructive tool
is then rejected by the tool router. Use --approve allow-all to allow those tools instead.
When stdin is not a terminal, use run instead.

/new  /model  /clear  /help
Ctrl+C interrupts the current turn. Ctrl+L lists chats.

Examples:
  <product> tui
`.trim();
}

export function doctorHelp(): string {
  return `
Usage:
  <product> doctor [--data-dir <dir>] [--json] [--deep] [--verbose]

Each check prints ok, warn, fail or skip. A failed check is followed by the command
that fixes it. Exits 78 when any check failed, 0 when all passed.
--json prints the checks as an array of objects.
--deep also verifies every runtime file against its published digest.
--verbose prints the reason behind a failed sidecar start.

Examples:
  <product> doctor
  <product> doctor --json
  <product> doctor --deep --verbose
`.trim();
}

/** Placeholder left in help text until a product bin supplies its command name. */
export const COMMAND_NAME_TOKEN = '<product>';

/**
 * Replaces {@link COMMAND_NAME_TOKEN} with the running bin name.
 * A blank name, the token itself, or a name that is not a command token is left unchanged.
 *
 * @param text Help or protected-directory text.
 * @param commandName Bin name such as `agent` or `steerable-cli`.
 * @returns Text with the placeholder replaced when the name is usable.
 */
export function renderCommandName(text: string, commandName: string | undefined): string {
  const name = commandName?.trim() ?? '';
  if (!name || name === COMMAND_NAME_TOKEN) return text;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return text;
  return text.replaceAll(COMMAND_NAME_TOKEN, name);
}

export function loginHelp(): string {
  return `
Usage:
  <product> login
  <product> logout

login picks a provider, verifies the API key with one model-list request, and saves
the credential for later runs. A rejected key is never saved. In scripts and CI set
the provider's environment variable instead (DEEPSEEK_API_KEY, OPENAI_API_KEY, ...):
login needs an interactive terminal.
logout removes the saved key; environment variables are untouched.

Examples:
  <product> login
  <product> logout
`.trim();
}

export function logoutHelp(): string {
  return `
Usage:
  <product> logout

Removes the saved API key. Environment variables are untouched.

Examples:
  <product> logout
`.trim();
}

export function webHelp(): string {
  return `
Usage:
  <product> web [--port <n>]

Serves the neutral Steerable shell in a browser and prints its URL. The first
screen configures a model when no credential is available. Runs until
interrupted.

  --port <n>   Port to bind; 0 picks a free one. Default 4787.
  --once       Serve, report the URL, then stop.

Examples:
  <product> web
  <product> web --port 8080
`.trim();
}
