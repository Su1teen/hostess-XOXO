import { PrismaClient } from '@prisma/client';
import { Decimal } from 'decimal.js';

const prisma = new PrismaClient();
const DEMO_ORG_ID = '00000000-0000-4000-8000-000000000001';
const PRICE_STEP = 50;

interface SeedProduct {
  key: string;
  name: string;
  category: string;
  startPrice: number;
  minPrice: number;
  volumeMl: number | null;
}

const products: SeedProduct[] = [
  ['Немецкое', 'Крепкий алкоголь', 1190, 790, 50],
  ['Джин Beefeater', 'Крепкий алкоголь', 2000, 1590, 50],
  ['Jägermeister', 'Крепкий алкоголь', 2000, 1590, 50],
  ['Oakheart', 'Крепкий алкоголь', 2000, 1590, 50],
  ['Bacardi Black', 'Крепкий алкоголь', 1600, 1190, 50],
  ['Ballantines', 'Крепкий алкоголь', 2000, 1590, 50],
  ['Jameson', 'Крепкий алкоголь', 2000, 1590, 50],
  ['Chivas', 'Крепкий алкоголь', 3000, 2590, 50],
  ['Jack Daniels', 'Крепкий алкоголь', 3000, 2590, 50],
  ['Monkey Shoulder', 'Крепкий алкоголь', 3500, 2990, 50],
  ['Absolut', 'Крепкий алкоголь', 1450, 990, 50],
  ['Nemiroff', 'Крепкий алкоголь', 1300, 890, 50],
  ['Хортица Айс', 'Крепкий алкоголь', 890, 590, 50],
  ['Кызылжар', 'Крепкий алкоголь', 790, 590, 50],
  ['Миллер', 'Бутылочное пиво', 1650, 990, null],
  ['Bud', 'Бутылочное пиво', 2190, 990, null],
  ['Corona Extra', 'Бутылочное пиво', 2990, 2590, null],
  ['Paulaner', 'Бутылочное пиво', 2500, 1990, null],
  ['Tsingtao', 'Бутылочное пиво', 2500, 1990, null],
  ['Hoegaarden', 'Бутылочное пиво', 2500, 1990, null],
  ['Red Bull Vodka', 'Коктейли', 3200, 2190, null],
  ['Red Bull Jäger', 'Коктейли', 3200, 2190, null],
  ['Gin Tonic', 'Коктейли', 3200, 2190, null],
  ['Red Bull Whiskey', 'Коктейли', 3200, 2190, null],
  ['Mojito', 'Коктейли', 2800, 1890, null],
  ['Long Island', 'Коктейли', 3500, 2490, null],
  ['Whiskey Sour', 'Коктейли', 3200, 2190, null],
].map(([name, category, startPrice, minPrice, volumeMl], index) => ({
  key: `exchange-${String(index + 1).padStart(2, '0')}`,
  name: name as string,
  category: category as string,
  startPrice: startPrice as number,
  minPrice: minPrice as number,
  volumeMl: volumeMl as number | null,
}));

function temporaryMaxPrice(startPrice: number): string {
  return new Decimal(startPrice)
    .mul('1.5')
    .div(PRICE_STEP)
    .toDecimalPlaces(0)
    .mul(PRICE_STEP)
    .toFixed(2);
}

function isLegacySeed(value: unknown): boolean {
  return (
    typeof value === 'object' && value !== null && (value as { seeded?: unknown }).seeded === true
  );
}

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

  for (const product of products) {
    const maxPrice = temporaryMaxPrice(product.startPrice);
    await prisma.product.upsert({
      where: { exchangeKey: product.key },
      update: {
        name: product.name,
        displayName: product.name,
        category: product.category,
        categoryName: product.category,
        volumeMl: product.volumeMl,
        startPrice: product.startPrice,
        currentPrice: product.startPrice,
        basePrice: product.startPrice,
        currentExchangePrice: product.startPrice,
        minPrice: product.minPrice,
        maxPrice,
        priceStep: PRICE_STEP,
        maxChangePercent: 10,
        currency: 'KZT',
        isExchangeProduct: true,
        isActive: true,
        isSellable: true,
        isAvailable: true,
        status: 'ACTIVE',
      },
      create: {
        organizationId: organization.id,
        exchangeKey: product.key,
        name: product.name,
        displayName: product.name,
        category: product.category,
        categoryName: product.category,
        volumeMl: product.volumeMl,
        startPrice: product.startPrice,
        currentPrice: product.startPrice,
        basePrice: product.startPrice,
        currentExchangePrice: product.startPrice,
        minPrice: product.minPrice,
        maxPrice,
        priceStep: PRICE_STEP,
        maxChangePercent: 10,
        currency: 'KZT',
        isExchangeProduct: true,
        isActive: true,
        isSellable: true,
        isAvailable: true,
        status: 'ACTIVE',
        unit: product.volumeMl ? 'порция' : 'позиция',
        productType: 'ExchangeProduct',
        metadata: { seeded: true, maxPricePolicy: 'startPrice * 1.5 rounded to priceStep' },
      },
    });
  }

  // Старый demo seed создавал 5 iiko-записей без exchangeKey. Не удаляем их,
  // но выводим из биржи, чтобы повторный deploy оставлял ровно 27 foundation-позиций.
  const legacySeeded = await prisma.product.findMany({
    where: { organizationId: organization.id, exchangeKey: null, isExchangeProduct: true },
    select: { id: true, metadata: true },
  });
  for (const product of legacySeeded) {
    if (isLegacySeed(product.metadata)) {
      await prisma.product.update({
        where: { id: product.id },
        data: { isExchangeProduct: false },
      });
    }
  }

  const count = await prisma.product.count({
    where: { organizationId: organization.id, isExchangeProduct: true, isActive: true },
  });
  process.stdout.write(
    `Seed выполнен: биржевых товаров ${count} (ожидалось ${products.length}).\n`,
  );
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Seed завершился ошибкой: ${message}\n`);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
