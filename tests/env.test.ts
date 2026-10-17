import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env.js';

describe('iiko environment defaults', () => {
  it('keeps QR ingestion opt-in and parses explicit rollout values', () => {
    const base={DATABASE_URL:'postgresql://localhost/test',ADMIN_API_KEY:'1234567890abcdef'};
    expect(parseEnv(base).QR_ORDER_EVENTS_ENABLED).toBe(false);
    for (const value of ['true','YES','1',' on ']) expect(parseEnv({...base,QR_ORDER_EVENTS_ENABLED:value}).QR_ORDER_EVENTS_ENABLED).toBe(true);
    for (const value of ['false','no','0','off']) expect(parseEnv({...base,QR_ORDER_EVENTS_ENABLED:value}).QR_ORDER_EVENTS_ENABLED).toBe(false);
    expect(parseEnv({...base,CORS_ORIGINS:'https://hostes.online,https://barboard-exchange.sovetovsultann.workers.dev'}).CORS_ORIGINS).toEqual(['https://hostes.online','https://barboard-exchange.sovetovsultann.workers.dev']);
  });
  it('IIKO_AUTH_API_KEY_FIELD defaults to apiLogin and menu path to /menu/by_id', () => {
    const env = parseEnv({
      DATABASE_URL: 'postgresql://localhost/test',
      ADMIN_API_KEY: '1234567890abcdef',
    } as NodeJS.ProcessEnv);

    expect(env.IIKO_AUTH_API_KEY_FIELD).toBe('apiLogin');
    expect(env.IIKO_MENU_BASE_URL).toBe('https://api-ru.iiko.services/api/2');
    expect(env.IIKO_MENU_BY_ID_PATH).toBe('/menu/by_id');
  });

  it('внутренний планировщик раундов включён по умолчанию и отключается явно', () => {
    const base = {
      DATABASE_URL: 'postgresql://localhost/test',
      ADMIN_API_KEY: '1234567890abcdef',
    } as NodeJS.ProcessEnv;

    expect(parseEnv(base).ROUND_SCHEDULER_ENABLED).toBe(true);
    expect(parseEnv({ ...base, ROUND_SCHEDULER_ENABLED: 'false' }).ROUND_SCHEDULER_ENABLED).toBe(
      false,
    );
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
