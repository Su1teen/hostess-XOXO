import { describe, expect, it } from 'vitest';
import {
  normalizePositivePrice,
  parseExternalMenu,
} from '../src/modules/iiko/iiko-menu-parser.js';

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

describe('normalizePositivePrice', () => {
  it('принимает number > 0', () => {
    expect(normalizePositivePrice(2500)).toBe(2500);
    expect(normalizePositivePrice(25.5)).toBe(25.5);
  });

  it('принимает numeric string "2500"', () => {
    expect(normalizePositivePrice('2500')).toBe(2500);
  });

  it('принимает decimal string "2500.00"', () => {
    expect(normalizePositivePrice('2500.00')).toBe(2500);
  });

  it('принимает comma decimal string "2500,00"', () => {
    expect(normalizePositivePrice('2500,00')).toBe(2500);
  });

  it('отвергает zero, отрицательные, NaN, мусор', () => {
    expect(normalizePositivePrice(0)).toBeNull();
    expect(normalizePositivePrice(-10)).toBeNull();
    expect(normalizePositivePrice(NaN)).toBeNull();
    expect(normalizePositivePrice(Infinity)).toBeNull();
    expect(normalizePositivePrice('not-a-number')).toBeNull();
    expect(normalizePositivePrice('')).toBeNull();
    expect(normalizePositivePrice(null)).toBeNull();
    expect(normalizePositivePrice(undefined)).toBeNull();
    expect(normalizePositivePrice(true)).toBeNull();
    expect(normalizePositivePrice({})).toBeNull();
  });
});

describe('parseExternalMenu price normalization (real iiko shapes)', () => {
  it('парсит цену как string "2500" (основной формат /api/2/menu/by_id)', () => {
    const menu = {
      itemCategories: [
        {
          items: [
            {
              id: 'item-1',
              name: 'Cola',
              itemSizes: [
                {
                  id: 'size-1',
                  name: '0.5L',
                  prices: [{ price: '2500', organizationId: ORG_ID }],
                },
              ],
            },
          ],
        },
      ],
    };
    const result = parseExternalMenu(menu, { organizationId: ORG_ID });
    expect(result.variants).toHaveLength(1);
    expect(result.variants[0]?.basePrice).toBe(2500);
    expect(result.skippedMalformedPrice).toBe(0);
  });

  it('парсит цену как decimal string "2500.00"', () => {
    const menu = {
      itemCategories: [
        {
          items: [
            {
              id: 'item-1',
              name: 'Cola',
              itemSizes: [
                { id: 's1', prices: [{ price: '2500.00' }] },
              ],
            },
          ],
        },
      ],
    };
    const result = parseExternalMenu(menu, { organizationId: ORG_ID });
    expect(result.variants).toHaveLength(1);
    expect(result.variants[0]?.basePrice).toBe(2500);
  });

  it('парсит цену как comma decimal string "2500,00"', () => {
    const menu = {
      itemCategories: [
        {
          items: [
            {
              id: 'item-1',
              name: 'Cola',
              itemSizes: [
                { id: 's1', prices: [{ price: '2500,00' }] },
              ],
            },
          ],
        },
      ],
    };
    const result = parseExternalMenu(menu, { organizationId: ORG_ID });
    expect(result.variants).toHaveLength(1);
    expect(result.variants[0]?.basePrice).toBe(2500);
  });

  it('парсит цену как number 2500', () => {
    const menu = {
      itemCategories: [
        {
          items: [
            {
              id: 'item-1',
              name: 'Cola',
              itemSizes: [
                { id: 's1', prices: [{ price: 2500 }] },
              ],
            },
          ],
        },
      ],
    };
    const result = parseExternalMenu(menu, { organizationId: ORG_ID });
    expect(result.variants).toHaveLength(1);
    expect(result.variants[0]?.basePrice).toBe(2500);
  });

  it('парсит цену из price.currentPrice (v1 nomenclature shape)', () => {
    const menu = {
      itemCategories: [
        {
          items: [
            {
              id: 'item-1',
              name: 'Cola',
              itemSizes: [
                {
                  id: 's1',
                  prices: [
                    { price: { currentPrice: 1800, isIncludedInMenu: true } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const result = parseExternalMenu(menu, { organizationId: ORG_ID });
    expect(result.variants).toHaveLength(1);
    expect(result.variants[0]?.basePrice).toBe(1800);
  });

  it('парсит цену из price.amount (альтернативное имя)', () => {
    const menu = {
      itemCategories: [
        {
          items: [
            {
              id: 'item-1',
              name: 'Cola',
              itemSizes: [
                { id: 's1', prices: [{ amount: 1500 }] },
              ],
            },
          ],
        },
      ],
    };
    const result = parseExternalMenu(menu, { organizationId: ORG_ID });
    expect(result.variants).toHaveLength(1);
    expect(result.variants[0]?.basePrice).toBe(1500);
  });

  it('парсит цену из price.value (альтернативное имя)', () => {
    const menu = {
      itemCategories: [
        {
          items: [
            {
              id: 'item-1',
              name: 'Cola',
              itemSizes: [
                { id: 's1', prices: [{ value: 1200 }] },
              ],
            },
          ],
        },
      ],
    };
    const result = parseExternalMenu(menu, { organizationId: ORG_ID });
    expect(result.variants).toHaveLength(1);
    expect(result.variants[0]?.basePrice).toBe(1200);
  });

  it('пропускает null и zero цены', () => {
    const menu = {
      itemCategories: [
        {
          items: [
            {
              id: 'item-zero',
              name: 'Free',
              itemSizes: [
                { id: 's1', prices: [{ price: 0 }] },
              ],
            },
            {
              id: 'item-null',
              name: 'NullPrice',
              itemSizes: [
                { id: 's1', prices: [{ price: null }] },
              ],
            },
          ],
        },
      ],
    };
    const result = parseExternalMenu(menu, { organizationId: ORG_ID });
    expect(result.variants).toHaveLength(0);
    expect(result.skippedZeroPrice).toBeGreaterThanOrEqual(1);
  });

  it('обрабатывает item с двумя размерами (string и number цены)', () => {
    const menu = {
      itemCategories: [
        {
          items: [
            {
              id: 'item-beer',
              name: 'Beer',
              itemSizes: [
                { id: 's-small', name: '0.3L', prices: [{ price: '800' }] },
                { id: 's-large', name: '0.5L', prices: [{ price: 1200 }] },
              ],
            },
          ],
        },
      ],
    };
    const result = parseExternalMenu(menu, { organizationId: ORG_ID });
    expect(result.variants).toHaveLength(2);
    expect(result.variants[0]?.basePrice).toBe(800);
    expect(result.variants[0]?.sizeName).toBe('0.3L');
    expect(result.variants[1]?.basePrice).toBe(1200);
    expect(result.variants[1]?.sizeName).toBe('0.5L');
    // Оба сохраняют iikoItemId.
    expect(result.variants.every((v) => v.iikoItemId === 'item-beer')).toBe(true);
  });

  it('обрабатывает вложенные itemCategories (множественные категории)', () => {
    const menu = {
      itemCategories: [
        {
          id: 'cat-drinks',
          name: 'Напитки',
          items: [
            { id: 'item-cola', name: 'Cola', itemSizes: [{ id: 's1', prices: [{ price: '500' }] }] },
          ],
        },
        {
          id: 'cat-food',
          name: 'Еда',
          items: [
            { id: 'item-burger', name: 'Burger', itemSizes: [{ id: 's1', prices: [{ price: '1500' }] }] },
          ],
        },
      ],
    };
    const result = parseExternalMenu(menu, { organizationId: ORG_ID });
    expect(result.variants).toHaveLength(2);
    expect(result.sourceItemCount).toBe(2);
    expect(result.sourceCategoryCount).toBe(2);
  });

  it('пропускает malformed цену (строка не-число)', () => {
    const menu = {
      itemCategories: [
        {
          items: [
            {
              id: 'item-bad',
              name: 'Bad',
              itemSizes: [
                { id: 's1', prices: [{ price: 'not-a-number' }] },
              ],
            },
          ],
        },
      ],
    };
    const result = parseExternalMenu(menu, { organizationId: ORG_ID });
    expect(result.variants).toHaveLength(0);
    expect(result.skippedMalformedPrice).toBe(1);
  });

  it('выбирает organization-specific цену по organizationId (single string)', () => {
    const menu = {
      itemCategories: [
        {
          items: [
            {
              id: 'item-org',
              name: 'Org Drink',
              itemSizes: [
                {
                  id: 's1',
                  prices: [
                    { price: '1000', organizationId: 'other-org' },
                    { price: '1200', organizationId: ORG_ID },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const result = parseExternalMenu(menu, { organizationId: ORG_ID });
    expect(result.variants).toHaveLength(1);
    expect(result.variants[0]?.basePrice).toBe(1200);
  });

  it('выбирает organization-specific цену по organizations (array)', () => {
    const menu = {
      itemCategories: [
        {
          items: [
            {
              id: 'item-org',
              name: 'Org Drink',
              itemSizes: [
                {
                  id: 's1',
                  prices: [
                    { price: 1000, organizations: [{ id: 'other-org' }] },
                    { price: 1200, organizations: [{ id: ORG_ID }] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const result = parseExternalMenu(menu, { organizationId: ORG_ID });
    expect(result.variants).toHaveLength(1);
    expect(result.variants[0]?.basePrice).toBe(1200);
  });

  it('диагностика содержит safe field names/types без секретов', () => {
    const menu = {
      itemCategories: [
        {
          items: [
            {
              id: 'item-1',
              name: 'Sample Item',
              itemSizes: [
                {
                  id: 's1',
                  name: 'Sample Size',
                  prices: [{ price: '2500', organizationId: ORG_ID }],
                },
              ],
            },
          ],
        },
      ],
    };
    const result = parseExternalMenu(menu, { organizationId: ORG_ID });
    expect(result.diagnostic).not.toBeNull();
    expect(result.diagnostic?.firstItemName).toBe('Sample Item');
    expect(result.diagnostic?.firstSizeName).toBe('Sample Size');
    expect(result.diagnostic?.pricesArrayLength).toBe(1);
    expect(result.diagnostic?.priceValueType).toBe('string');
    expect(result.diagnostic?.priceObjectKeys).toContain('price');
    expect(result.diagnostic?.priceObjectKeys).toContain('organizationId');
    expect(result.diagnostic?.validPositivePriceCount).toBe(1);
    // Диагностика не должна содержать секреты.
    const serialized = JSON.stringify(result.diagnostic);
    expect(serialized).not.toContain('apiLogin');
    expect(serialized).not.toContain('clientSecret');
    expect(serialized).not.toContain('token');
  });

  it('1107-подобный сценарий: все string цены теперь парсятся, 0 malformed', () => {
    // Симулируем реальный сценарий: 3 товара с string ценами.
    const menu = {
      itemCategories: [
        {
          items: [
            {
              id: 'item-1',
              name: 'Pivo 1',
              itemSizes: [{ id: 's1', prices: [{ price: '2500', organizationId: ORG_ID }] }],
            },
            {
              id: 'item-2',
              name: 'Pivo 2',
              itemSizes: [{ id: 's1', prices: [{ price: '3000', organizationId: ORG_ID }] }],
            },
            {
              id: 'item-3',
              name: 'Pivo 3',
              itemSizes: [{ id: 's1', prices: [{ price: '1800', organizationId: ORG_ID }] }],
            },
          ],
        },
      ],
    };
    const result = parseExternalMenu(menu, { organizationId: ORG_ID });
    expect(result.variants).toHaveLength(3);
    expect(result.skippedMalformedPrice).toBe(0);
    expect(result.variants.map((v) => v.basePrice).sort((a, b) => a - b)).toEqual([1800, 2500, 3000]);
  });
});
