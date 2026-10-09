import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const railwayConfig = readFileSync(new URL('../railway.toml', import.meta.url), 'utf8');

describe('production exchange initialization', () => {
  it('starts without implicit production DDL or catalog writes', () => {
    expect(railwayConfig).toContain(
      'startCommand = "npm run start"',
    );
  });
});
