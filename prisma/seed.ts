import { PrismaClient } from '@prisma/client';

/**
 * Демо-данные для локальной разработки: одна организация и несколько напитков,
 * помеченных как биржевые. Реальные данные iiko при этом не используются —
 * iikoProductId сгенерированы локально и не совпадают с продакшеном.
 */
const prisma = new PrismaClient();

const DEMO_ORG_ID = '00000000-0000-4000-8000-000000000001';

interface SeedProduct {
  iikoProductId: string;
  name: string;
  basePrice: number;
  minPrice: number;
  maxPrice: number;
  isExchangeProduct: boolean;
}

const products: SeedProduct[] = [
  {
    iikoProductId: '00000000-0000-4000-8000-000000000101',
    name: 'Gin Tonic',
    basePrice: 2900,
    minPrice: 2400,
    maxPrice: 4200,
    isExchangeProduct: true,
  },
  {
    iikoProductId: '00000000-0000-4000-8000-000000000102',
    name: 'Негрони',
    basePrice: 3500,
    minPrice: 3000,
    maxPrice: 5000,
    isExchangeProduct: true,
  },
  {
    iikoProductId: '00000000-0000-4000-8000-000000000103',
    name: 'Апероль Шприц',
    basePrice: 3200,
    minPrice: 2700,
    maxPrice: 4600,
    isExchangeProduct: true,
  },
  {
    iikoProductId: '00000000-0000-4000-8000-000000000104',
    name: 'Пиво светлое 0.5',
    basePrice: 1800,
    minPrice: 1500,
    maxPrice: 2600,
    isExchangeProduct: true,
  },
  {
    iikoProductId: '00000000-0000-4000-8000-000000000105',
    name: 'Espresso',
    basePrice: 900,
    minPrice: 700,
    maxPrice: 1400,
    isExchangeProduct: false,
  },
];

async function main(): Promise<void> {
  const organization = await prisma.organization.upsert({
    where: { iikoOrganizationId: DEMO_ORG_ID },
    update: { name: 'Demo Bar (локальная разработка)', isSelected: true, status: 'ACTIVE' },
    create: {
      iikoOrganizationId: DEMO_ORG_ID,
      name: 'Demo Bar (локальная разработка)',
      status: 'ACTIVE',
      isSelected: true,
      metadata: { seeded: true },
    },
  });

  const group = await prisma.productGroup.upsert({
    where: {
      organizationId_iikoGroupId: {
        organizationId: organization.id,
        iikoGroupId: '00000000-0000-4000-8000-0000000000a1',
      },
    },
    update: { name: 'Бар', path: 'Бар' },
    create: {
      organizationId: organization.id,
      iikoGroupId: '00000000-0000-4000-8000-0000000000a1',
      name: 'Бар',
      path: 'Бар',
    },
  });

  for (const product of products) {
    await prisma.product.upsert({
      where: {
        organizationId_iikoProductId: {
          organizationId: organization.id,
          iikoProductId: product.iikoProductId,
        },
      },
      update: {
        name: product.name,
        basePrice: product.basePrice,
        minPrice: product.minPrice,
        maxPrice: product.maxPrice,
        isExchangeProduct: product.isExchangeProduct,
        isActive: true,
        status: 'ACTIVE',
      },
      create: {
        organizationId: organization.id,
        iikoProductId: product.iikoProductId,
        iikoParentGroupId: group.iikoGroupId,
        name: product.name,
        unit: 'порция',
        productType: 'Dish',
        basePrice: product.basePrice,
        currentKnownIikoPrice: product.basePrice,
        currentExchangePrice: product.basePrice,
        minPrice: product.minPrice,
        maxPrice: product.maxPrice,
        priceStep: 50,
        maxChangePercent: 10,
        isExchangeProduct: product.isExchangeProduct,
        metadata: { iikoGroupPath: group.path, seeded: true },
        syncedAt: new Date(),
      },
    });
  }

  const exchangeCount = products.filter((product) => product.isExchangeProduct).length;
  process.stdout.write(
    `Seed выполнен: организация «${organization.name}», товаров ${products.length}, из них биржевых ${exchangeCount}.\n`,
  );
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Seed завершился ошибкой: ${message}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
