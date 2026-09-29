import { PrismaClient } from '@prisma/client';
import { ExchangeService } from '../src/modules/exchange/exchange.service.js';
import { calculateDiscountPercent } from '../src/services/discount.service.js';
import { getCanonicalPriceLevelPercent } from '../src/services/price-engine.service.js';

const prisma = new PrismaClient();
const APPLY_FLAG = '--apply';

/**
 * Сбрасывает ТОЛЬКО состояние биржи до ценового минимума из каталога.
 *
 * Без --apply это dry-run. С --apply удаляются только exchange_sales и
 * round_prices, связанные с exchange_products; обычные меню, iiko-данные и
 * не-биржевые раунды не затрагиваются. Пустые после этого биржевые раунды
 * удаляются, чтобы старый published round никогда не вернул прежние цены.
 */
async function main(): Promise<void> {
  const products = await prisma.exchangeProduct.findMany({ orderBy: { slug: 'asc' } });
  const exchangeProductIds = products.map((product) => product.id);
  const affectedRoundRows = exchangeProductIds.length
    ? await prisma.roundPrice.findMany({
        where: { exchangeProductId: { in: exchangeProductIds } },
        select: { roundId: true },
        distinct: ['roundId'],
      })
    : [];
  const affectedRoundIds = affectedRoundRows.map((row) => row.roundId);
  const salesCount = exchangeProductIds.length
    ? await prisma.exchangeSale.count({ where: { exchangeProductId: { in: exchangeProductIds } } })
    : 0;

  const summary = {
    products: products.length,
    exchangeSalesToDelete: salesCount,
    exchangeRoundsToRefresh: affectedRoundIds.length,
    expected: products.map((product) => ({
      slug: product.slug,
      price: product.minPrice.toString(),
      priceLevelPercent: getCanonicalPriceLevelPercent({
        originalPrice: product.originalPrice,
        currentPrice: product.minPrice,
      }),
    })),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

  if (!process.argv.includes(APPLY_FLAG)) {
    process.stdout.write('Dry-run: данные не изменены. Запустите с --apply для подтверждения.\n');
    return;
  }
  if (products.length === 0) throw new Error('Нет exchange_products: сбрасывать нечего');

  await prisma.$transaction(async (tx) => {
    await tx.exchangeSale.deleteMany({ where: { exchangeProductId: { in: exchangeProductIds } } });
    await tx.roundPrice.deleteMany({ where: { exchangeProductId: { in: exchangeProductIds } } });

    // Удаляются исключительно раунды, которые после удаления биржевых строк
    // стали пустыми. Раунд с данными иной подсистемы остаётся нетронутым.
    if (affectedRoundIds.length) {
      await tx.priceRound.deleteMany({
        where: { id: { in: affectedRoundIds }, prices: { none: {} }, sales: { none: {} } },
      });
    }

    for (const product of products) {
      const discount = calculateDiscountPercent(product.originalPrice, product.minPrice);
      await tx.exchangeProduct.update({
        where: { id: product.id },
        data: {
          currentPrice: product.minPrice,
          priceLevelPercent: getCanonicalPriceLevelPercent({
            originalPrice: product.originalPrice,
            currentPrice: product.minPrice,
          }),
          currentDiscountPercent: discount,
          actualDiscountPercent: discount,
          manualPriceAppliedAt: null,
        },
      });
    }
  });

  // Создаёт чистый published round текущего окна на основе уже сброшенных цен.
  const exchange = new ExchangeService(prisma);
  const round = await exchange.ensureCurrentRound();
  process.stdout.write(`Сброс завершён. Новый раунд: ${round?.id ?? 'не создан'}\n`);
}

main()
  .catch((error: unknown) => {
    process.stderr.write(
      `Сброс завершился ошибкой: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
