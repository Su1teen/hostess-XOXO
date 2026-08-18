import { describe, expect, it } from 'vitest';
import { parseExternalMenu } from '../src/modules/iiko/iiko-menu-parser.js';

const ORG_ID = 'configured-org-id';

function menuWith(items: unknown[], productCategories: unknown[] = []) {
  return {
    correlationId: 'corr-1',
    id: 'menu-1',
    productCategories,
    itemCategories: [{ items }],
  };
}

function realItem(overrides: Record<string, unknown> = {}) {
  return {
    itemId: 'item-ava',
    name: 'AVA лимонад',
    sku: 'AVA-1',
    productCategoryId: 'soft-drinks',
    itemSizes: [
      {
        sizeId: null,
        sizeName: null,
        prices: [{ organizationId: ORG_ID, price: 850.0 }],
      },
    ],
    ...overrides,
  };
}

describe('iiko drinks extractor port', () => {
  it('imports AVA lemonade from the real itemId/sizeId shape with price 850', () => {
    const result = parseExternalMenu(menuWith([realItem()]), { organizationId: ORG_ID });

    expect(result.variants).toHaveLength(1);
    expect(result.variants[0]).toMatchObject({
      iikoItemId: 'item-ava',
      iikoSizeId: null,
      name: 'AVA лимонад',
      displayName: 'AVA лимонад',
      sku: 'AVA-1',
      basePrice: 850,
      isDrinkCandidate: true,
      isSellable: true,
      isAvailable: true,
    });
    expect(result.candidateWithFinitePriceCount).toBe(1);
    expect(result.candidateWithPositivePriceCount).toBe(1);
  });

  it('imports a Bacardi-like item through a detected rum category', () => {
    const result = parseExternalMenu(
      menuWith(
        [
          realItem({
            itemId: 'bacardi-id',
            name: 'Bacardi Carta Blanca',
            productCategoryId: 'rum-category',
          }),
        ],
        [{ id: 'rum-category', name: 'Ром' }],
      ),
      { organizationId: ORG_ID },
    );

    expect(result.drinkCategoryCount).toBe(1);
    expect(result.variants[0]?.iikoItemId).toBe('bacardi-id');
  });

  it('does not create a sellable variant when price is null', () => {
    const result = parseExternalMenu(
      menuWith([
        realItem({
          itemSizes: [
            {
              sizeId: 'null-size',
              sizeName: 'Null',
              prices: [{ organizationId: ORG_ID, price: null }],
            },
          ],
        }),
      ]),
      { organizationId: ORG_ID },
    );

    expect(result.variants.filter((variant) => variant.isSellable)).toHaveLength(0);
    expect(result.skippedWithoutPriceCount).toBe(1);
  });

  it('preserves a zero-priced candidate but marks it non-sellable and unavailable', () => {
    const result = parseExternalMenu(
      menuWith([
        realItem({
          itemSizes: [
            {
              sizeId: 'zero-size',
              sizeName: 'Zero',
              prices: [{ organizationId: ORG_ID, price: 0 }],
            },
          ],
        }),
      ]),
      { organizationId: ORG_ID },
    );

    expect(result.variants[0]).toMatchObject({
      basePrice: 0,
      isSellable: false,
      isAvailable: false,
      sourceMetadata: { sourcePrice: 0 },
    });
    expect(result.zeroPriceCandidateCount).toBe(1);
    expect(result.candidateWithPositivePriceCount).toBe(0);
  });

  it('excludes a food item whose name contains both burger and cola', () => {
    const result = parseExternalMenu(
      menuWith([
        realItem({
          itemId: 'burger-cola',
          name: 'Бургер с кола соусом',
          productCategoryId: 'food',
        }),
      ]),
      { organizationId: ORG_ID },
    );

    expect(result.variants).toHaveLength(0);
    expect(result.nonDrinkItemCount).toBe(1);
  });

  it('includes an opaque item name when its category is a drink category', () => {
    const result = parseExternalMenu(
      menuWith(
        [realItem({ itemId: 'opaque', name: 'AVA 2026', productCategoryId: 'bar' })],
        [{ id: 'bar', name: 'Барное меню' }],
      ),
      { organizationId: ORG_ID },
    );

    expect(result.variants[0]?.iikoItemId).toBe('opaque');
  });

  it('creates separate variants for multiple item sizes without max aggregation', () => {
    const result = parseExternalMenu(
      menuWith([
        realItem({
          itemSizes: [
            {
              sizeId: 'size-small',
              sizeName: '0.3 л',
              prices: [{ organizationId: ORG_ID, price: 800 }],
            },
            {
              sizeId: 'size-large',
              sizeName: '0.5 л',
              prices: [{ organizationId: ORG_ID, price: 1200 }],
            },
          ],
        }),
      ]),
      { organizationId: ORG_ID },
    );

    expect(result.variants.map((variant) => [variant.iikoSizeId, variant.basePrice])).toEqual([
      ['size-small', 800],
      ['size-large', 1200],
    ]);
  });

  it('uses itemId and sizeId before fallback id fields and preserves source IDs', () => {
    const result = parseExternalMenu(
      menuWith([
        realItem({
          itemId: 'real-item-id',
          id: 'fallback-item-id',
          itemSizes: [
            {
              sizeId: 'real-size-id',
              id: 'fallback-size-id',
              sizeName: 'Bottle',
              prices: [{ organizationId: ORG_ID, price: 950 }],
            },
          ],
        }),
      ]),
      { organizationId: ORG_ID },
    );

    expect(result.variants[0]).toMatchObject({
      iikoItemId: 'real-item-id',
      iikoSizeId: 'real-size-id',
      sizeName: 'Bottle',
      sourceMetadata: {
        originalItemId: 'real-item-id',
        originalSizeId: 'real-size-id',
      },
    });
  });

  it('falls back to id fields only when real itemId/sizeId fields are absent', () => {
    const item = realItem({
      itemId: undefined,
      id: 'fallback-item',
      itemSizes: [
        {
          id: 'fallback-size',
          name: 'Fallback size',
          prices: [{ price: 700 }],
        },
      ],
    });
    const result = parseExternalMenu(menuWith([item]), { organizationId: ORG_ID });

    expect(result.variants[0]).toMatchObject({
      iikoItemId: 'fallback-item',
      iikoSizeId: 'fallback-size',
      sizeName: 'Fallback size',
    });
  });

  it('does not deduplicate different iiko items by name', () => {
    const result = parseExternalMenu(
      menuWith([
        realItem({ itemId: 'same-name-1' }),
        realItem({ itemId: 'same-name-2' }),
      ]),
      { organizationId: ORG_ID },
    );

    expect(result.variants.map((variant) => variant.iikoItemId)).toEqual([
      'same-name-1',
      'same-name-2',
    ]);
  });

  it('prefers the configured organization price and falls back to the first finite price', () => {
    const preferred = parseExternalMenu(
      menuWith([
        realItem({
          itemSizes: [
            {
              sizeId: 'preferred',
              prices: [
                { organizationId: 'other-org', price: 500 },
                { organizationId: ORG_ID, price: 850 },
              ],
            },
          ],
        }),
      ]),
      { organizationId: ORG_ID },
    );
    const fallback = parseExternalMenu(
      menuWith([
        realItem({
          itemSizes: [
            {
              sizeId: 'fallback',
              prices: [
                { organizationId: 'other-org', price: 600 },
                { organizationId: 'third-org', price: 700 },
              ],
            },
          ],
        }),
      ]),
      { organizationId: ORG_ID },
    );

    expect(preferred.variants[0]?.basePrice).toBe(850);
    expect(fallback.variants[0]?.basePrice).toBe(600);
  });

  it('reports candidate and non-drink summary counters separately', () => {
    const result = parseExternalMenu(
      menuWith([
        realItem(),
        realItem({ itemId: 'missing-price', itemSizes: [{ sizeId: 's', prices: [] }] }),
        realItem({ itemId: undefined, id: undefined }),
        realItem({ itemId: 'food', name: 'Хлеб', productCategoryId: 'food' }),
      ]),
      { organizationId: ORG_ID },
    );

    expect(result).toMatchObject({
      sourceItemCount: 4,
      drinkCandidateCount: 3,
      candidateWithFinitePriceCount: 1,
      candidateWithPositivePriceCount: 1,
      skippedWithoutItemIdCount: 1,
      skippedWithoutPriceCount: 1,
      nonDrinkItemCount: 1,
    });
  });

  it('keeps parser samples safe and limited to three real records', () => {
    const items = [0, 1, 2, 3].map((index) =>
      realItem({
        itemId: `item-${index}`,
        itemSizes: [
          {
            sizeId: `size-${index}`,
            sizeName: `Size ${index}`,
            prices: [
              {
                organizationId: ORG_ID,
                price: 850,
                token: 'must-not-leak',
                nested: { clientSecret: 'must-not-leak' },
              },
            ],
          },
        ],
      }),
    );
    const result = parseExternalMenu(menuWith(items), { organizationId: ORG_ID });
    const serialized = JSON.stringify(result.parserSamples);

    expect(result.parserSamples).toHaveLength(3);
    expect(result.parserSamples[0]).toMatchObject({
      itemName: 'AVA лимонад',
      sizeName: 'Size 0',
      priceValue: 850,
      javascriptNumberConversion: 850,
      selectedPriceField: 'price',
    });
    expect(serialized).not.toContain('must-not-leak');
    expect(serialized).not.toContain('clientSecret');
    expect(serialized).not.toContain('token');
  });
});
