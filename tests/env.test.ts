import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env.js';

describe('iiko environment defaults', () => {
  it('IIKO_AUTH_API_KEY_FIELD defaults to apiLogin and menu path to /menu/by_id', () => {
    const env = parseEnv({
      DATABASE_URL: 'postgresql://localhost/test',
      ADMIN_API_KEY: '1234567890abcdef',
    } as NodeJS.ProcessEnv);

    expect(env.IIKO_AUTH_API_KEY_FIELD).toBe('apiLogin');
    expect(env.IIKO_MENU_BASE_URL).toBe('https://api-ru.iiko.services/api/2');
    expect(env.IIKO_MENU_BY_ID_PATH).toBe('/menu/by_id');
  });

  it('отклоняет apiKey как имя поля auth body', () => {
    expect(() =>
      parseEnv({
        DATABASE_URL: 'postgresql://localhost/test',
        ADMIN_API_KEY: '1234567890abcdef',
        IIKO_AUTH_API_KEY_FIELD: 'apiKey',
      } as NodeJS.ProcessEnv),
    ).toThrow(/IIKO_AUTH_API_KEY_FIELD/);
  });
});
