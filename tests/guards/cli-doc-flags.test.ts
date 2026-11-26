import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_TS_PATH = path.resolve(HERE, '../../packages/agent-cli/ts/src/cli.ts');
const CLI_DOC_PATH = path.resolve(HERE, '../../docs/cli.md');

export function extractCliSurfaceFromAst(cliSource: string): {
  commands: string[];
  flags: string[];
} {
  const sf = ts.createSourceFile('cli.ts', cliSource, ts.ScriptTarget.Latest, true);
  const commands = new Set<string>();
  const flags = new Set<string>();

  const visit = (node: ts.Node): void => {
    // Extract `options: { ... }` inside `parseArgs({ ... })`
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'parseArgs' &&
      node.arguments.length >= 1 &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      for (const prop of node.arguments[0].properties) {
        if (
          ts.isPropertyAssignment(prop) &&
          ts.isIdentifier(prop.name) &&
          prop.name.text === 'options' &&
          ts.isObjectLiteralExpression(prop.initializer)
        ) {
          for (const optProp of prop.initializer.properties) {
            if (ts.isPropertyAssignment(optProp)) {
              if (ts.isIdentifier(optProp.name)) {
                flags.add(`--${optProp.name.text}`);
              } else if (ts.isStringLiteral(optProp.name)) {
                flags.add(`--${optProp.name.text}`);
              }
            }
          }
        }
      }
    }

    // Extract `command === '...'`
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
      ts.isIdentifier(node.left) &&
      node.left.text === 'command' &&
      ts.isStringLiteral(node.right)
    ) {
      commands.add(node.right.text);
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);
  return {
    commands: [...commands].sort(),
    flags: [...flags].sort(),
  };
}

export function extractDocumentedCliSurface(markdown: string): {
  commands: string[];
  flags: string[];
} {
  const cmdBlock =
    markdown.split('<!-- cli-commands-start -->')[1]?.split('<!-- cli-commands-end -->')[0] ?? '';
  const flagBlock =
    markdown.split('<!-- cli-flags-start -->')[1]?.split('<!-- cli-flags-end -->')[0] ?? '';

  const commands = new Set<string>();
  for (const m of cmdBlock.matchAll(/^\|\s*`([a-z0-9-]+)`\s*\|/gm)) {
    commands.add(m[1]);
  }

  const flags = new Set<string>();
  for (const m of flagBlock.matchAll(/^\|\s*`(--[a-z0-9-]+)`\s*\|/gm)) {
    flags.add(m[1]);
  }

  return {
    commands: [...commands].sort(),
    flags: [...flags].sort(),
  };
}

describe('AST Guard #5: cli-doc-flags bidirectional parity (T-ARC-05)', () => {
  it('ensures every subcommand and --flag in agent-cli/ts/src/cli.ts matches docs/cli.md 1:1', () => {
    const cliSrc = fs.readFileSync(CLI_TS_PATH, 'utf8');
    const docMd = fs.readFileSync(CLI_DOC_PATH, 'utf8');

    const actual = extractCliSurfaceFromAst(cliSrc);
    const documented = extractDocumentedCliSurface(docMd);

    expect(actual.commands).toEqual(documented.commands);
    expect(actual.flags).toEqual(documented.flags);
  });

  it('detects an undocumented ghost --flag immediately', () => {
    const cliWithGhost =
      fs.readFileSync(CLI_TS_PATH, 'utf8').replace(
        "help: { type: 'boolean', short: 'h' },",
        "help: { type: 'boolean', short: 'h' }, 'ghost-undocumented-flag': { type: 'boolean' },",
      );
    const docMd = fs.readFileSync(CLI_DOC_PATH, 'utf8');
    const actual = extractCliSurfaceFromAst(cliWithGhost);
    const documented = extractDocumentedCliSurface(docMd);
    expect(actual.flags).not.toEqual(documented.flags);
    expect(actual.flags).toContain('--ghost-undocumented-flag');
  });
});
