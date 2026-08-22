import fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { ADMIN_PAGE_HTML } from '../src/modules/admin/admin-page.html.js';
import { bartenderRoutes } from '../src/modules/bartender/bartender.routes.js';
import { BartenderSessionService } from '../src/modules/bartender/bartender.session.js';
import {
  calculateManualDiscount,
  MANUAL_DISCOUNT_OPTIONS,
} from '../src/services/discount.service.js';
import { calculateExchangeDemandScore } from '../src/services/price-engine.service.js';

function manual(selectedDiscountPercent: number, overrides: Record<string, unknown> = {}) {
  return calculateManualDiscount({
    originalPrice: 2000,
    minPrice: 1590,
    priceStep: 50,
    selectedDiscountPercent,
    ...overrides,
  });
}

describe('ручная скидка бармена', () => {
  it('считает цену по формуле original * (1 - p/100) с округлением до 50', () => {
    const result = manual(15);
    expect(result.rawPrice.toString()).toBe('1700');
    expect(result.roundedPrice.toString()).toBe('1700');
    expect(result.finalPrice.toString()).toBe('1700');
    expect(result.minPriceApplied).toBe(false);
  });

  it('округляет до шага 50 ₸', () => {
    // 1190 * 0.65 = 773.5 -> 750
    const result = manual(35, { originalPrice: 1190, minPrice: 500 });
    expect(result.rawPrice.toString()).toBe('773.5');
    expect(result.finalPrice.toString()).toBe('750');
  });

  it('никогда не опускает цену ниже minPrice и помечает ограничение', () => {
    const result = manual(90);
    expect(result.finalPrice.toString()).toBe('1590');
    expect(result.minPriceApplied).toBe(true);
  });

  it('принимает 100% и зажимает результат на minPrice', () => {
    const result = manual(100);
    expect(result.finalPrice.toString()).toBe('1590');
    expect(result.finalPrice.isNegative()).toBe(false);
  });

  it('разделяет выбранную и фактическую скидку', () => {
    const result = manual(90);
    expect(result.selectedDiscountPercent.toString()).toBe('90');
    expect(Number(result.actualDiscountPercent.toFixed(2))).toBe(20.5);
  });

  it('отклоняет некорректные проценты', () => {
    expect(() => manual(7)).toThrow();
    expect(() => manual(-5)).toThrow();
    expect(() => manual(105)).toThrow();
    expect(() => manual(12.5)).toThrow();
  });

  it('предлагает кнопки 0..95 без 100%', () => {
    expect(MANUAL_DISCOUNT_OPTIONS).toHaveLength(20);
    expect(MANUAL_DISCOUNT_OPTIONS[0]).toBe(0);
    expect(MANUAL_DISCOUNT_OPTIONS[19]).toBe(95);
    expect(MANUAL_DISCOUNT_OPTIONS).not.toContain(100);
  });
});

describe('спрос биржи', () => {
  it('игнорирует продажи меньше 2 штук', () => {
    expect(calculateExchangeDemandScore(1, 0.5).toNumber()).toBe(0);
    expect(calculateExchangeDemandScore(0, 0).toNumber()).toBe(0);
  });

  it('никогда не даёт отрицательный спрос и clamp-ит до 1', () => {
    expect(calculateExchangeDemandScore(2, 10).toNumber()).toBe(0);
    expect(calculateExchangeDemandScore(10, 2).toNumber()).toBe(1);
    expect(calculateExchangeDemandScore(3, 2).toNumber()).toBe(0.5);
  });
});

describe('сессии бармена', () => {
  const config = {
    pin: '1234',
    sessionTtlMinutes: 10,
    maxAttempts: 3,
    attemptWindowSeconds: 60,
  };

  it('выдаёт токен по верному PIN и инвалидирует его при logout', () => {
    const service = new BartenderSessionService(config);
    const session = service.login('1234');
    expect(session.token.length).toBeGreaterThan(20);
    expect(service.requireSession(session.token).token).toBe(session.token);
    expect(service.logout(session.token)).toBe(true);
    expect(() => service.requireSession(session.token)).toThrow();
  });

  it('отдаёт одинаковую ошибку на неверный PIN', () => {
    const service = new BartenderSessionService(config);
    expect(() => service.login('0000')).toThrow('Неверный PIN');
    expect(() => service.login('')).toThrow('Неверный PIN');
  });

  it('ограничивает число попыток входа', () => {
    const service = new BartenderSessionService(config);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(() => service.login('0000', 'ip')).toThrow('Неверный PIN');
    }
    expect(() => service.login('0000', 'ip')).toThrow(/Слишком много попыток/);
  });

  it('истёкшая сессия требует повторного входа', () => {
    let now = 1_000_000;
    const service = new BartenderSessionService(config, () => now);
    const session = service.login('1234');
    now += 11 * 60_000;
    expect(() => service.requireSession(session.token)).toThrow();
  });
});

interface Harness {
  app: FastifyInstance;
  bartender: {
    listProducts: ReturnType<typeof vi.fn>;
    status: ReturnType<typeof vi.fn>;
    preview: ReturnType<typeof vi.fn>;
    applyPrice: ReturnType<typeof vi.fn>;
    incrementSales: ReturnType<typeof vi.fn>;
    decrementSales: ReturnType<typeof vi.fn>;
  };
}

async function buildHarness(): Promise<Harness> {
  const app = fastify();
  const bartender = {
    listProducts: vi.fn(async () => ({ products: [], roundId: null })),
    status: vi.fn(async () => ({ running: true })),
    preview: vi.fn(async () => ({ finalPrice: 1700 })),
    applyPrice: vi.fn(async () => ({ changed: true, product: { id: 'p1' } })),
    incrementSales: vi.fn(async () => ({ salesQuantity: 3 })),
    decrementSales: vi.fn(async () => ({ salesQuantity: 1 })),
  };
  app.decorate('services', {
    bartender,
    bartenderSessions: new BartenderSessionService({
      pin: '1234',
      sessionTtlMinutes: 10,
      maxAttempts: 50,
      attemptWindowSeconds: 60,
    }),
    audit: { log: vi.fn(async () => undefined) },
  } as never);
  await app.register(bartenderRoutes);
  return { app, bartender };
}

async function loginToken(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/bartender/auth',
    payload: { pin: '1234' },
  });
  expect(response.statusCode).toBe(200);
  return response.json().token;
}

describe('bartender API', () => {
  it('не пускает без токена и пускает с токеном', async () => {
    const { app } = await buildHarness();
    const denied = await app.inject({ method: 'GET', url: '/api/v1/bartender/exchange/products' });
    expect(denied.statusCode).toBe(401);

    const token = await loginToken(app);
    const allowed = await app.inject({
      method: 'GET',
      url: '/api/v1/bartender/exchange/products',
      headers: { 'x-bartender-token': token },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it('не возвращает PIN в ответе авторизации', async () => {
    const { app } = await buildHarness();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/bartender/auth',
      payload: { pin: '1234' },
    });
    const body = response.json();
    expect(body.token).toBeTypeOf('string');
    expect(body.expiresAt).toBeTypeOf('string');
    expect(JSON.stringify(body)).not.toContain('1234');
    await app.close();
  });

  it('logout инвалидирует токен', async () => {
    const { app } = await buildHarness();
    const token = await loginToken(app);
    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/bartender/logout',
      headers: { 'x-bartender-token': token },
    });
    expect(logout.statusCode).toBe(200);
    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/bartender/exchange/status',
      headers: { 'x-bartender-token': token },
    });
    expect(after.statusCode).toBe(401);
    await app.close();
  });

  it('preview валидирует процент и не мутирует данные', async () => {
    const { app, bartender } = await buildHarness();
    const token = await loginToken(app);
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/bartender/exchange/products/00000000-0000-4000-8000-000000000000/price-preview',
      headers: { 'x-bartender-token': token },
      payload: { selectedDiscountPercent: 120 },
    });
    expect(bad.statusCode).toBe(400);
    expect(bartender.preview).not.toHaveBeenCalled();

    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/bartender/exchange/products/00000000-0000-4000-8000-000000000000/price-preview',
      headers: { 'x-bartender-token': token },
      payload: { selectedDiscountPercent: 15 },
    });
    expect(ok.statusCode).toBe(200);
    expect(bartender.preview).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000000', 15);
    expect(bartender.applyPrice).not.toHaveBeenCalled();
    await app.close();
  });

  it('apply-price игнорирует цену из фронтенда', async () => {
    const { app, bartender } = await buildHarness();
    const token = await loginToken(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/bartender/exchange/products/00000000-0000-4000-8000-000000000000/apply-price',
      headers: { 'x-bartender-token': token },
      payload: { selectedDiscountPercent: 20, finalPrice: 1 },
    });
    // Лишнее поле цены отбрасывается схемой: сервер считает цену сам.
    expect(response.statusCode).toBe(200);
    expect(bartender.applyPrice).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000000',
      20,
      expect.anything(),
    );

    const clean = await app.inject({
      method: 'POST',
      url: '/api/v1/bartender/exchange/products/00000000-0000-4000-8000-000000000000/apply-price',
      headers: { 'x-bartender-token': token },
      payload: { selectedDiscountPercent: 20 },
    });
    expect(clean.statusCode).toBe(200);
    expect(bartender.applyPrice).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000000',
      20,
      expect.objectContaining({ requestId: expect.any(String) }),
    );
    await app.close();
  });

  it('продажи меняются на положительное целое число', async () => {
    const { app, bartender } = await buildHarness();
    const token = await loginToken(app);
    const url = '/api/v1/bartender/exchange/products/00000000-0000-4000-8000-000000000000/sales/';
    const invalid = await app.inject({
      method: 'POST',
      url: url + 'increment',
      headers: { 'x-bartender-token': token },
      payload: { quantity: 0 },
    });
    expect(invalid.statusCode).toBe(400);

    const increment = await app.inject({
      method: 'POST',
      url: url + 'increment',
      headers: { 'x-bartender-token': token },
      payload: { quantity: 2 },
    });
    expect(increment.statusCode).toBe(200);
    expect(increment.json().salesQuantity).toBe(3);

    const decrement = await app.inject({
      method: 'POST',
      url: url + 'decrement',
      headers: { 'x-bartender-token': token },
      payload: {},
    });
    expect(decrement.statusCode).toBe(200);
    expect(bartender.decrementSales).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000000',
      1,
      expect.anything(),
    );
    await app.close();
  });
});

describe('страница /admin', () => {
  it('содержит вход в режим бармена и не содержит PIN', () => {
    expect(ADMIN_PAGE_HTML).toContain('id="btnBartenderOpen"');
    expect(ADMIN_PAGE_HTML).toContain('id="bartenderWorkspace"');
    expect(ADMIN_PAGE_HTML).toContain('Расчёт цен');
    expect(ADMIN_PAGE_HTML).toContain('/api/v1/bartender');
    expect(ADMIN_PAGE_HTML).not.toContain('1234');
  });

  it('сохраняет админскую диагностику в исходнике', () => {
    expect(ADMIN_PAGE_HTML).toContain('Статус системы');
    expect(ADMIN_PAGE_HTML).toContain('/api/v1/admin/diagnostics');
  });

  it('рисует кнопки скидок и парные кнопки расчёта и применения', () => {
    expect(ADMIN_PAGE_HTML).toContain('Рассчитать');
    expect(ADMIN_PAGE_HTML).toContain('Применить');
    expect(ADMIN_PAGE_HTML).toContain('bt-disc');
  });
});
