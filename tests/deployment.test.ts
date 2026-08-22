import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const railwayConfig = readFileSync(new URL('../railway.toml', import.meta.url), 'utf8');

describe('production exchange initialization', () => {
  it('runs migration, idempotent seed, then starts the app', () => {
    expect(railwayConfig).toContain(
      'startCommand = "npm run db:migrate:deploy && npm run db:seed && npm run start"',
    );
  });
});
