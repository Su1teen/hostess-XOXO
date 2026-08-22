import { PrismaClient } from '@prisma/client';
import { ExchangeService } from '../src/modules/exchange/exchange.service.js';

const prisma = new PrismaClient();
const DEMO_ORG_ID = '00000000-0000-4000-8000-000000000001';

async function main(): Promise<void> {
  await prisma.organization.upsert({
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

  const exchange = new ExchangeService(prisma);
  const count = await exchange.seedProducts();
  const initial = await exchange.ensureInitialRound();
  process.stdout.write(
    `Seed выполнен: биржевых товаров ${count}, initial round ${initial?.created ? 'создан' : 'уже существует'}\n`,
  );
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Seed завершился ошибкой: ${message}\n`);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
