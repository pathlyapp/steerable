const EXAMPLES = `
Examples:
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
  <product> chat list | show <id> | rm <id> | export <id> [--format md|json]
  <product> skills list
  <product> mcp list | add <name> -- <cmd...> | rm <name>
  <product> config get <key> | set <key> <value>
  <product> doctor
  <product> tui${pack}

${EXAMPLES}
`.trim();
}

export function runHelp(): string {
  return `
Usage:
  <product> run "<task>" [--chat <id>] [--approve deny|allow-read|allow-all]
                         [--json | --stream-json] [--project <dir> | --cwd <dir> | --no-project] [--trust]
                         [--data-dir <dir>]

--approve deny is the default. A denied approval exits 3. A busy chat exits 6.
run binds the current directory as a project. --project and --cwd name that directory.
--no-project keeps a workspace per chat.
--trust marks that project trusted and loads its rule files. It cannot be combined with --no-project.
STEERABLE_APPROVAL=0 turns the approval layer off for this process. A destructive tool
is then rejected by the tool router. Use --approve allow-all to allow those tools instead.

${EXAMPLES}
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
  <product> doctor [--data-dir <dir>]

Examples:
  <product> doctor
`.trim();
}

/** Placeholder left in help text until a product bin supplies its command name. */
export const COMMAND_NAME_TOKEN = '<product>';

/**
 * Replaces {@link COMMAND_NAME_TOKEN} with the running bin name.
 * A blank name, the token itself, or a name that is not a command token is left unchanged.
 *
 * @param text Help or protected-directory text.
 * @param commandName Bin name such as `aroli` or `steerable-cli`.
 * @returns Text with the placeholder replaced when the name is usable.
 */
export function renderCommandName(text: string, commandName: string | undefined): string {
  const name = commandName?.trim() ?? '';
  if (!name || name === COMMAND_NAME_TOKEN) return text;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return text;
  return text.replaceAll(COMMAND_NAME_TOKEN, name);
}
