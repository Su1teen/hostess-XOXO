import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { IikoSyncService } from '../src/modules/iiko/iiko.service.js';

const ORG_ID = 'configured-org-id';

function createPrisma() {
  return {
    organization: {
      findFirst: vi.fn(async () => ({
        id: '11111111-1111-1111-1111-111111111111',
        iikoOrganizationId: ORG_ID,
        name: 'Test organization',
      })),
    },
    product: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }) => data),
      update: vi.fn(async ({ data }) => data),
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    appSetting: {
      upsert: vi.fn(async () => ({})),
    },
  } as unknown as PrismaClient;
}

describe('IikoSyncService drink catalog persistence', () => {
  it('saves real iiko IDs, finite price, candidate flags, and source metadata', async () => {
    const prisma = createPrisma();
    const iiko = {
      getExternalMenu: vi.fn(async () => ({
        productCategories: [{ id: 'drinks', name: 'Лимонады' }],
        itemCategories: [
          {
            items: [
              {
                itemId: 'ava-item-id',
                name: 'AVA лимонад',
                sku: 'AVA-1',
                productCategoryId: 'drinks',
                itemSizes: [
                  {
                    sizeId: null,
                    sizeName: null,
                    prices: [{ organizationId: ORG_ID, price: 850 }],
                  },
                ],
              },
            ],
          },
        ],
      })),
    };
    const audit = { log: vi.fn(async () => {}) };
    const telegram = { sendAlert: vi.fn(async () => {}) };
    const service = new IikoSyncService(
      prisma,
      {
        IIKO_EXTERNAL_MENU_ID: 'menu-id',
        PRICE_DEFAULT_STEP: 50,
        PRICE_MAX_CHANGE_PERCENT: 10,
      } as never,
      iiko as never,
      audit as never,
      telegram as never,
    );

    const summary = await service.syncMenu('request-id');
    const create = vi.mocked(prisma.product.create);

    expect(summary).toMatchObject({
      sourceItemCount: 1,
      drinkCategoryCount: 1,
      drinkCandidateCount: 1,
      candidateWithFinitePriceCount: 1,
      candidateWithPositivePriceCount: 1,
      savedCount: 1,
      updatedCount: 0,
    });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: '11111111-1111-1111-1111-111111111111',
        iikoItemId: 'ava-item-id',
        iikoSizeId: null,
        name: 'AVA лимонад',
        displayName: 'AVA лимонад',
        sku: 'AVA-1',
        categoryId: 'drinks',
        categoryName: 'Лимонады',
        basePrice: '850',
        currentKnownIikoPrice: '850',
        isDrinkCandidate: true,
        isSellable: true,
        isAvailable: true,
        isExchangeProduct: false,
        sourceMetadata: expect.objectContaining({
          sourcePrice: 850,
          originalItemId: 'ava-item-id',
          originalSizeId: null,
        }),
      }),
    });
  });
});
