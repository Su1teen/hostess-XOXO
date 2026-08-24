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

function manual(discountPercent: number, overrides: Record<string, unknown> = {}) {
  return calculateManualDiscount({
    originalPrice: 2000,
    minPrice: 1590,
    priceStep: 50,
    selectedDiscountPercent: discountPercent,
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
    incrementSales: ReturnType<typeof vi.fn>;
    decrementSales: ReturnType<typeof vi.fn>;
  };
}

async function buildHarness(): Promise<Harness> {
  const app = fastify();
  const bartender = {
    listProducts: vi.fn(async () => ({ products: [], roundId: null })),
    status: vi.fn(async () => ({ running: true })),
    incrementSales: vi.fn(async () => ({ salesQuantity: 3, quantity: 3, priceAtSale: 990, discountPercentAtSale: 31.7, roundEndsAt: '2026-08-22T22:15:00.000Z' })),
    decrementSales: vi.fn(async () => ({ salesQuantity: 1, quantity: 1, priceAtSale: 990, discountPercentAtSale: 31.7, roundEndsAt: '2026-08-22T22:15:00.000Z' })),
    setSalesQuantity: vi.fn(async (_productId: string, quantity: number) => ({ productId: 'p1', roundId: 'r1', quantity, roundEndsAt: '2026-08-22T22:15:00.000Z' })),
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
      payload: { quantity: 1 },
    });
    expect(decrement.statusCode).toBe(200);
    expect(bartender.decrementSales).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000000',
      1,
      expect.anything(),
    );
    await app.close();
  });

  it('sale increment с {quantity:1} без discountPercent — основное действие бармена', async () => {
    const { app, bartender } = await buildHarness();
    const token = await loginToken(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/bartender/exchange/products/00000000-0000-4000-8000-000000000000/sales/increment',
      headers: { 'x-bartender-token': token },
      payload: { quantity: 1 },
    });
    expect(response.statusCode).toBe(200);
    expect(bartender.incrementSales).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000000',
      1,
      expect.anything(),
    );
    const body = response.json();
    expect(body.priceAtSale).toBe(990);
    expect(body.discountPercentAtSale).toBe(31.7);
    expect(body.roundEndsAt).toBeTypeOf('string');
    expect(body.discountPercent).toBeUndefined();
    await app.close();
  });

  it('sale increment не принимает discountPercent и требует только quantity', async () => {
    const { app } = await buildHarness();
    const token = await loginToken(app);
    const url = '/api/v1/bartender/exchange/products/00000000-0000-4000-8000-000000000000/sales/increment';

    const missingQuantity = await app.inject({
      method: 'POST',
      url,
      headers: { 'x-bartender-token': token },
      payload: {},
    });
    expect(missingQuantity.statusCode).toBe(400);

    const valid = await app.inject({
      method: 'POST',
      url,
      headers: { 'x-bartender-token': token },
      payload: { quantity: 1 },
    });
    expect(valid.statusCode).toBe(200);
    await app.close();
  });

  it('PUT quantity устанавливает абсолютное количество и требует диапазон 0..9999', async () => {
    const { app, bartender } = await buildHarness();
    const token = await loginToken(app);
    const url = '/api/v1/bartender/exchange/products/00000000-0000-4000-8000-000000000000/sales/quantity';

    const valid = await app.inject({
      method: 'PUT',
      url,
      headers: { 'x-bartender-token': token },
      payload: { quantity: 5 },
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toEqual(expect.objectContaining({ productId: 'p1', roundId: 'r1', quantity: 5 }));
    expect(bartender.setSalesQuantity).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000000',
      5,
      expect.anything(),
    );

    const invalid = await app.inject({
      method: 'PUT',
      url,
      headers: { 'x-bartender-token': token },
      payload: { quantity: -1 },
    });
    expect(invalid.statusCode).toBe(400);

    const tooLarge = await app.inject({
      method: 'PUT',
      url,
      headers: { 'x-bartender-token': token },
      payload: { quantity: 10000 },
    });
    expect(tooLarge.statusCode).toBe(400);
    await app.close();
  });

  it('sale decrement требует quantity и не принимает discountPercent', async () => {
    const { app } = await buildHarness();
    const token = await loginToken(app);
    const url = '/api/v1/bartender/exchange/products/00000000-0000-4000-8000-000000000000/sales/decrement';

    const missingQuantity = await app.inject({
      method: 'POST',
      url,
      headers: { 'x-bartender-token': token },
      payload: {},
    });
    expect(missingQuantity.statusCode).toBe(400);

    const valid = await app.inject({
      method: 'POST',
      url,
      headers: { 'x-bartender-token': token },
      payload: { quantity: 1 },
    });
    expect(valid.statusCode).toBe(200);
    await app.close();
  });
});

describe('страница /admin', () => {
  it('содержит вход в режим бармена и не содержит PIN', () => {
    expect(ADMIN_PAGE_HTML).toContain('id="btnBartenderOpen"');
    expect(ADMIN_PAGE_HTML).toContain('id="bartenderWorkspace"');
    expect(ADMIN_PAGE_HTML).toContain('Бармен — продажи');
    expect(ADMIN_PAGE_HTML).toContain('/api/v1/bartender');
    expect(ADMIN_PAGE_HTML).not.toContain('1234');
  });

  it('сохраняет админскую диагностику в исходнике', () => {
    expect(ADMIN_PAGE_HTML).toContain('Статус системы');
    expect(ADMIN_PAGE_HTML).toContain('/api/v1/admin/diagnostics');
  });

  it('не показывает бармену ручной выбор скидки', () => {
    expect(ADMIN_PAGE_HTML).not.toContain('Рассчитать');
    expect(ADMIN_PAGE_HTML).not.toContain('apply-price');
    expect(ADMIN_PAGE_HTML).not.toContain('price-preview');
    expect(ADMIN_PAGE_HTML).not.toContain('bt-disc');
    expect(ADMIN_PAGE_HTML).not.toContain('Уровень');
    expect(ADMIN_PAGE_HTML).not.toContain('Минимальная цена');
    expect(ADMIN_PAGE_HTML).toContain('Ставка');
  });

  it('оставляет один quantity control с абсолютным сохранением', () => {
    expect(ADMIN_PAGE_HTML).not.toContain('Продано +1');
    expect(ADMIN_PAGE_HTML).toContain('sales/quantity');
    expect(ADMIN_PAGE_HTML).toContain('quantity.value');
    expect(ADMIN_PAGE_HTML).not.toContain('selectedDiscountPercent');
  });

  it('округляет скидку только для отображения и поддерживает абсолютное количество', () => {
    expect(ADMIN_PAGE_HTML).toContain('Math.round(level)');
    expect(ADMIN_PAGE_HTML).toContain("'/exchange/products/' + product.id + '/sales/quantity'");
    expect(ADMIN_PAGE_HTML).toContain("quantity.min = '0'");
    expect(ADMIN_PAGE_HTML).toContain("quantity.max = '9999'");
  });

  it('имеет один quantity control и мобильную responsive-разметку', () => {
    expect(ADMIN_PAGE_HTML).not.toContain('Шаг:');
    expect(ADMIN_PAGE_HTML).not.toContain('Изменить на:');
    expect(ADMIN_PAGE_HTML).not.toContain('bt-delta');
    expect(ADMIN_PAGE_HTML).toContain("'/exchange/products/' + product.id + '/sales/' + endpoint");
    expect(ADMIN_PAGE_HTML).toContain('bt-apply-quantity');
    expect(ADMIN_PAGE_HTML).toContain('@media (max-width: 700px)');
    expect(ADMIN_PAGE_HTML).toContain('min-height: 44px');
  });
});
