import { describe, expect, it } from 'vitest';
import { parseExternalMenu } from '../src/modules/iiko/iiko-menu-parser.js';

const ORG_ID = 'cc9baa8d-cfac-4092-9c97-477746fe84e2';

/**
 * Фикстура полного внешнего меню iiko (ответ POST /api/2/menu/by_id).
 * Реальная структура: productCategories + itemCategories[].items[].
 */
const fixtureMenu = {
  correlationId: 'corr-123',
  id: 'menu-001',
  externalMenuId: '88042',
  productCategories: [
    { id: 'cat-cocktails', name: 'Коктейли', isDeleted: false },
    { id: 'cat-beer', name: 'Пиво' },
  ],
  itemCategories: [
    {
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
        // Неоднозначная цена: две положительные generic цены без орг-матча — пропускается.
        {
          id: 'item-ambiguous',
          name: 'Ambiguous',
          itemSizes: [{ id: 's1', prices: [{ price: 100 }, { price: 200 }] }],
        },
      ],
    },
  ],
};

describe('parseExternalMenu /api/2/menu/by_id', () => {
  it('строит карту productCategories id -> name', () => {
    const result = parseExternalMenu(fixtureMenu, { organizationId: ORG_ID });
    expect(result.sourceCategoryCount).toBe(2);
    const gin = result.variants.find((v) => v.iikoItemId === 'item-gin-tonic');
    expect(gin?.categoryId).toBe('cat-cocktails');
    expect(gin?.categoryName).toBe('Коктейли');
  });

  it('flatten itemCategories[].items[] (НЕ корневой items)', () => {
    const result = parseExternalMenu(fixtureMenu, { organizationId: ORG_ID });
    // Все товары из фикстуры учтены в sourceItemCount (включая пропущенные).
    expect(result.sourceItemCount).toBe(8);
  });

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

  it('НЕ схлопывает размеры в maxPrice: каждая цена = отдельная строка', () => {
    const result = parseExternalMenu(fixtureMenu, { organizationId: ORG_ID });
    const prices = result.variants
      .filter((v) => v.iikoItemId === 'item-gin-tonic')
      .map((v) => v.basePrice);
    expect(prices).toEqual([2500, 3200]);
  });

  it('извлекает товар с одной положительной ценой', () => {
    const result = parseExternalMenu(fixtureMenu, { organizationId: ORG_ID });
    const espresso = result.variants.find((v) => v.iikoItemId === 'item-espresso');
    expect(espresso).toBeDefined();
    expect(espresso?.basePrice).toBe(900);
    expect(espresso?.sku).toBe('ESP-1');
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

  it('пропускает неоднозначную цену (две positive generic) без max-price collapse', () => {
    const result = parseExternalMenu(fixtureMenu, { organizationId: ORG_ID });
    expect(result.variants.some((v) => v.iikoItemId === 'item-ambiguous')).toBe(false);
    expect(result.skippedAmbiguousPrice).toBe(1);
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
    const keys = result.variants.map(
      (v) => `${v.organizationId}|${v.iikoItemId}|${v.iikoSizeId}`,
    );
    const unique = new Set(keys);
    expect(keys.length).toBe(unique.size);
  });

  it('использует fallback size id, когда у размера нет id', () => {
    const menu = {
      productCategories: [],
      itemCategories: [
        {
          items: [
            {
              id: 'item-x',
              name: 'X',
              itemSizes: [{ name: 'big', prices: [{ price: 100 }] }],
            },
          ],
        },
      ],
    };
    const result = parseExternalMenu(menu, { organizationId: ORG_ID });
    expect(result.variants).toHaveLength(1);
    expect(result.variants[0]?.iikoSizeId).toBe('__no_size__');
  });

  it('игнорирует отрицательные и NaN цены', () => {
    const menu = {
      productCategories: [],
      itemCategories: [
        {
          items: [
            {
              id: 'item-neg',
              name: 'Neg',
              itemSizes: [
                { id: 's1', prices: [{ price: -10 }, { price: 150 }] },
              ],
            },
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

  it('maxPrice aggregation никогда не используется для persisted exchange products', () => {
    const menu = {
      productCategories: [],
      itemCategories: [
        {
          items: [
            {
              id: 'item-multi',
              name: 'Multi',
              itemSizes: [
                { id: 's1', name: 'small', prices: [{ price: 100 }] },
                { id: 's2', name: 'big', prices: [{ price: 300 }] },
              ],
            },
          ],
        },
      ],
    };
    const result = parseExternalMenu(menu, { organizationId: ORG_ID });
    // Две строки с разными ценами, не одна строка с max=300.
    expect(result.variants).toHaveLength(2);
    expect(result.variants.map((v) => v.basePrice).sort((a, b) => a - b)).toEqual([100, 300]);
  });
});
