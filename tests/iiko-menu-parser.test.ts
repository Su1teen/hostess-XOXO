import { describe, expect, it } from 'vitest';
import { parseExternalMenu } from '../src/modules/iiko/iiko-menu-parser.js';

const ORG_ID = 'cc9baa8d-cfac-4092-9c97-477746fe84e2';

/** Фикстура внешнего меню iiko (/api/2/menu) для тестов. */
const fixtureMenu = {
  correlationId: 'corr-123',
  id: 'menu-001',
  externalMenuId: '88042',
  groups: [
    { id: 'cat-cocktails', name: 'Коктейли' },
    { id: 'cat-beer', name: 'Пиво' },
  ],
  items: [
    {
      id: 'item-gin-tonic',
      name: 'Gin Tonic',
      sku: 'GT-001',
      productCategoryId: 'cat-cocktails',
      itemSizes: [
        {
          id: 'size-250',
          name: '250 ml',
          sizeCode: 'S',
          prices: [{ price: 2500, organizations: [{ id: ORG_ID }] }],
        },
        {
          id: 'size-400',
          name: '400 ml',
          sizeCode: 'L',
          prices: [{ price: 3200, organizations: [{ id: ORG_ID }] }],
        },
      ],
    },
    {
      id: 'item-espresso',
      name: 'Espresso',
      sku: 'ESP-1',
      productCategoryId: 'cat-beer',
      itemSizes: [
        { id: 'size-single', name: 'single', prices: [{ price: 900 }] },
      ],
    },
    // Без itemSizes — пропускается.
    {
      id: 'item-no-sizes',
      name: 'Syrup',
      itemSizes: [],
    },
    // Hidden — пропускается.
    {
      id: 'item-hidden',
      name: 'Secret',
      hidden: true,
      itemSizes: [{ id: 's1', prices: [{ price: 100 }] }],
    },
    // Все цены нулевые — пропускается.
    {
      id: 'item-zero',
      name: 'Free',
      itemSizes: [{ id: 's1', prices: [{ price: 0 }] }],
    },
    // Цена принадлежит другой организации — пропускается.
    {
      id: 'item-other-org',
      name: 'Other Org Drink',
      itemSizes: [
        { id: 's1', prices: [{ price: 500, organizations: [{ id: 'other-org' }] }] },
      ],
    },
    // Битая цена (строка) — пропускается как malformed.
    {
      id: 'item-malformed',
      name: 'Broken',
      itemSizes: [{ id: 's1', prices: [{ price: 'not-a-number' }] }],
    },
  ],
};

describe('parseExternalMenu', () => {
  it('извлекает sellable variants: один товар с двумя размерами = две строки', () => {
    const result = parseExternalMenu(fixtureMenu, { organizationId: ORG_ID });
    const gin = result.variants.filter((v) => v.iikoItemId === 'item-gin-tonic');
    expect(gin).toHaveLength(2);
    expect(gin[0]?.sizeName).toBe('250 ml');
    expect(gin[0]?.basePrice).toBe(2500);
    expect(gin[0]?.displayName).toBe('Gin Tonic · 250 ml');
    expect(gin[1]?.sizeName).toBe('400 ml');
    expect(gin[1]?.basePrice).toBe(3200);
    expect(gin[1]?.displayName).toBe('Gin Tonic · 400 ml');
  });

  it('НЕ схлопывает размеры в max-price: каждая цена = отдельная строка', () => {
    const result = parseExternalMenu(fixtureMenu, { organizationId: ORG_ID });
    const prices = result.variants
      .filter((v) => v.iikoItemId === 'item-gin-tonic')
      .map((v) => v.basePrice);
    expect(prices).toEqual([2500, 3200]);
  });

  it('пропускает товар без itemSizes', () => {
    const result = parseExternalMenu(fixtureMenu, { organizationId: ORG_ID });
    expect(result.variants.some((v) => v.iikoItemId === 'item-no-sizes')).toBe(false);
    expect(result.skippedNoSizes).toBeGreaterThanOrEqual(1);
  });

  it('пропускает товар со всеми нулевыми ценами', () => {
    const result = parseExternalMenu(fixtureMenu, { organizationId: ORG_ID });
    expect(result.variants.some((v) => v.iikoItemId === 'item-zero')).toBe(false);
    expect(result.skippedZeroPrice).toBeGreaterThanOrEqual(1);
  });

  it('пропускает hidden товар', () => {
    const result = parseExternalMenu(fixtureMenu, { organizationId: ORG_ID });
    expect(result.variants.some((v) => v.iikoItemId === 'item-hidden')).toBe(false);
    expect(result.skippedHidden).toBe(1);
  });

  it('пропускает цену, принадлежащую другой организации', () => {
    const result = parseExternalMenu(fixtureMenu, { organizationId: ORG_ID });
    expect(result.variants.some((v) => v.iikoItemId === 'item-other-org')).toBe(false);
  });

  it('пропускает malformed цену', () => {
    const result = parseExternalMenu(fixtureMenu, { organizationId: ORG_ID });
    expect(result.variants.some((v) => v.iikoItemId === 'item-malformed')).toBe(false);
    expect(result.skippedMalformedPrice).toBeGreaterThanOrEqual(1);
  });

  it('извлекает товар с одной положительной ценой', () => {
    const result = parseExternalMenu(fixtureMenu, { organizationId: ORG_ID });
    const espresso = result.variants.find((v) => v.iikoItemId === 'item-espresso');
    expect(espresso).toBeDefined();
    expect(espresso?.basePrice).toBe(900);
  });

  it('строит карту категорий и проставляет categoryName', () => {
    const result = parseExternalMenu(fixtureMenu, { organizationId: ORG_ID });
    const gin = result.variants.find((v) => v.iikoItemId === 'item-gin-tonic');
    expect(gin?.categoryId).toBe('cat-cocktails');
    expect(gin?.categoryName).toBe('Коктейли');
    expect(result.categoryCount).toBe(2);
  });

  it('сохраняет correlationId и source ids', () => {
    const result = parseExternalMenu(fixtureMenu, {
      organizationId: ORG_ID,
      externalMenuId: '88042',
    });
    expect(result.correlationId).toBe('corr-123');
    expect(result.sourceMenuId).toBe('menu-001');
    expect(result.sourceExternalMenuId).toBe('88042');
  });

  it('каждая строка имеет уникальный идентификатор organizationId + iikoItemId + iikoSizeId', () => {
    const result = parseExternalMenu(fixtureMenu, { organizationId: ORG_ID });
    const keys = result.variants.map((v) => `${v.organizationId}|${v.iikoItemId}|${v.iikoSizeId}`);
    const unique = new Set(keys);
    expect(keys.length).toBe(unique.size);
  });

  it('использует fallback size id, когда у размера нет id', () => {
    const menu = {
      items: [
        {
          id: 'item-x',
          name: 'X',
          itemSizes: [{ name: 'big', prices: [{ price: 100 }] }],
        },
      ],
    };
    const result = parseExternalMenu(menu, { organizationId: ORG_ID });
    expect(result.variants).toHaveLength(1);
    expect(result.variants[0]?.iikoSizeId).toBe('__no_size__');
  });

  it('игнорирует отрицательные и NaN цены', () => {
    const menu = {
      items: [
        {
          id: 'item-neg',
          name: 'Neg',
          itemSizes: [
            { id: 's1', prices: [{ price: -10 }, { price: 150 }] },
          ],
        },
      ],
    };
    const result = parseExternalMenu(menu, { organizationId: ORG_ID });
    expect(result.variants).toHaveLength(1);
    expect(result.variants[0]?.basePrice).toBe(150);
  });

  it('обрабатывает пустой/некорректный ответ без ошибок', () => {
    const result = parseExternalMenu(null, { organizationId: ORG_ID });
    expect(result.variants).toEqual([]);
    expect(result.sourceItemCount).toBe(0);
  });
});
