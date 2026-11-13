import { describe, expect, it } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const formatted = "export function run() {\n  return 'ok';\n}\n";

const fmtCheck = (cwd: string, file: string) =>
  Bun.spawnSync([process.execPath, 'fmt', '--check', file], { cwd }).exitCode;

describe('formatter tooling', () => {
  it('keeps the repo style when an .editorconfig asks for tabs and CRLF', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fmt-editorconfig-'));

    try {
      copyFileSync(join(root, 'bunfig.toml'), join(dir, 'bunfig.toml'));
      writeFileSync(join(dir, '.editorconfig'), 'root = true\n\n[*]\nindent_style = tab\nend_of_line = crlf\n');
      writeFileSync(join(dir, 'a.ts'), formatted);

      expect(fmtCheck(dir, 'a.ts')).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a Prettier config in an ancestor directory out of bun fmt', () => {
    const base = mkdtempSync(join(tmpdir(), 'fmt-config-'));

    try {
      const repo = join(base, 'outer', 'inner');
      mkdirSync(repo, { recursive: true });
      writeFileSync(
        join(base, 'outer', '.prettierrc.json'),
        JSON.stringify({ semi: false, trailingComma: 'none', arrowParens: 'avoid' }),
      );
      copyFileSync(join(root, 'bunfig.toml'), join(repo, 'bunfig.toml'));
      writeFileSync(join(repo, 'a.ts'), "const a = 'x';\nexport const f = (x) => [x, 1];\n");

      expect(fmtCheck(repo, 'a.ts')).toBe(0);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('turns off changesets formatting of CHANGELOG.md', async () => {
    const changesetConfig = await Bun.file(join(root, '.changeset', 'config.json')).json();

    expect(changesetConfig.prettier).toBe(false);
  });
});
