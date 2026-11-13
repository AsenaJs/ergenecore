import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');

describe('formatter tooling', () => {
  it('runs the format scripts without looking up Prettier config files', async () => {
    const pkg = await Bun.file(join(root, 'package.json')).json();

    expect(pkg.scripts.format).toContain('--no-config');
    expect(pkg.scripts['format:check']).toContain('--no-config');
  });

  it('keeps a Prettier config in an ancestor directory out of bun fmt when --no-config is set', async () => {
    const base = mkdtempSync(join(tmpdir(), 'fmt-config-'));

    try {
      const repo = join(base, 'outer', 'inner');
      mkdirSync(repo, { recursive: true });
      writeFileSync(join(base, 'outer', '.prettierrc.json'), JSON.stringify({ semi: false }));
      writeFileSync(join(repo, 'bunfig.toml'), '[fmt]\nprintWidth = 120\nsingleQuote = true\n');
      writeFileSync(join(repo, 'a.ts'), "const a = 'x';\n");

      const check = (...extra: string[]) =>
        Bun.spawnSync([process.execPath, 'fmt', '--check', ...extra, 'a.ts'], { cwd: repo }).exitCode;

      expect(check()).not.toBe(0);
      expect(check('--no-config')).toBe(0);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('turns off changesets formatting of CHANGELOG.md', async () => {
    const changesetConfig = await Bun.file(join(root, '.changeset', 'config.json')).json();

    expect(changesetConfig.prettier).toBe(false);
  });
});
