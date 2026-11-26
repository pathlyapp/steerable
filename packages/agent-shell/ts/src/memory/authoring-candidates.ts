/**
 * Dual-hash quarantine sandbox for auto-distilled `SKILL.md` authoring candidates (Phase 9 R8-3).
 *
 * Candidate skills land under `<userDataDir>/authoring-candidates/<id>/` (outside any
 * active skill discovery path), undergo static safety validation, and require an
 * explicit human approval binding BOTH `(candidateHash, reviewHash)` before installation.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getUserDataDir } from '../runtime.js';

export interface AuthoringCandidateRecord {
  readonly id: string;
  readonly name: string;
  readonly candidateHash: string;
  readonly reviewHash: string;
  readonly createdAt: string;
  readonly sourceChatId: string;
  readonly staticCheckPassed: boolean;
  readonly staticViolations: readonly string[];
}

export function getAuthoringCandidatesDir(): string {
  return path.join(getUserDataDir(), 'authoring-candidates');
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const FORBIDDEN_SKILL_PATTERNS: Array<{ code: string; re: RegExp }> = [
  { code: 'credential_master_key_ref', re: /STEERABLE_CREDENTIAL_MASTER_KEY/ },
  { code: 'curl_pipe_shell', re: /curl\s+[^\n|]+\|\s*(?:ba)?sh/i },
  { code: 'host_memory_path_ref', re: /\/memory\/workspaces\// },
];

export function runCandidateSkillStaticCheck(skillMarkdown: string): string[] {
  const violations: string[] = [];
  for (const { code, re } of FORBIDDEN_SKILL_PATTERNS) {
    if (re.test(skillMarkdown)) {
      violations.push(code);
    }
  }
  return violations;
}

export async function stageAuthoringCandidate(input: {
  readonly name: string;
  readonly skillMarkdown: string;
  readonly reviewSummary: string;
  readonly sourceChatId: string;
}): Promise<AuthoringCandidateRecord> {
  const id = `cand_${randomBytes(6).toString('hex')}`;
  const dir = path.join(getAuthoringCandidatesDir(), id);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  const violations = runCandidateSkillStaticCheck(input.skillMarkdown);
  const candidateHash = sha256(input.skillMarkdown);
  const reviewHash = sha256(`${candidateHash}:${input.reviewSummary.trim()}`);
  const record: AuthoringCandidateRecord = {
    id,
    name: input.name.replace(/[^a-zA-Z0-9_-]/g, '-'),
    candidateHash,
    reviewHash,
    createdAt: new Date().toISOString(),
    sourceChatId: input.sourceChatId,
    staticCheckPassed: violations.length === 0,
    staticViolations: violations,
  };

  await fs.writeFile(path.join(dir, 'SKILL.md'), input.skillMarkdown, { mode: 0o600 });
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(record, null, 2), { mode: 0o600 });
  return record;
}

export async function promoteAuthoringCandidate(input: {
  readonly id: string;
  readonly expectedCandidateHash: string;
  readonly expectedReviewHash: string;
  readonly targetSkillsRoot?: string;
}): Promise<{ installedPath: string }> {
  const dir = path.join(getAuthoringCandidatesDir(), input.id);
  const metaRaw = await fs.readFile(path.join(dir, 'meta.json'), 'utf8');
  const meta = JSON.parse(metaRaw) as AuthoringCandidateRecord;
  const skillMarkdown = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8');

  const liveCandidateHash = sha256(skillMarkdown);
  if (
    liveCandidateHash !== meta.candidateHash ||
    liveCandidateHash !== input.expectedCandidateHash ||
    meta.reviewHash !== input.expectedReviewHash
  ) {
    throw new Error('authoring_candidate_hash_mismatch');
  }
  if (!meta.staticCheckPassed || runCandidateSkillStaticCheck(skillMarkdown).length > 0) {
    throw new Error('authoring_candidate_failed_static_check');
  }

  const destRoot = input.targetSkillsRoot ?? path.join(getUserDataDir(), 'skills');
  const destDir = path.join(destRoot, meta.name);
  await fs.mkdir(destDir, { recursive: true });
  const installedPath = path.join(destDir, 'SKILL.md');
  await fs.writeFile(installedPath, skillMarkdown, 'utf8');
  return { installedPath };
}
