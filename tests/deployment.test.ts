import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const railwayConfig = readFileSync(new URL('../railway.toml', import.meta.url), 'utf8');

describe('production exchange initialization', () => {
  it('starts without implicit production DDL or catalog writes', () => {
    expect(railwayConfig).toContain(
      'startCommand = "npm run start"',
    );
  });
  it('runs migrations before deployment with a runtime Prisma CLI', () => {
    expect(railwayConfig).toContain('preDeployCommand = "npm run db:migrate:deploy"');
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.dependencies.prisma).toBe('5.22.0');
    expect(pkg.devDependencies.prisma).toBeUndefined();
    expect(railwayConfig).not.toContain('db:seed &&');
  });
});
