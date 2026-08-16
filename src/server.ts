import { buildApp } from './app.js';
import { getEnv } from './config/env.js';

async function main(): Promise<void> {
  const env = getEnv();
  const app = await buildApp(env);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'останавливаю сервис');
    try {
      await app.close();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'ошибка при остановке');
      process.exit(1);
    }
  };

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info(
    { port: env.PORT, timezone: env.APP_TIMEZONE, publisherMode: env.PRICE_PUBLISHER_MODE },
    'Bar Exchange backend запущен (v0.1: запись в iiko отключена)',
  );
}

main().catch((error: unknown) => {
  // Логгер может быть ещё не создан — печатаем только сообщение, без секретов.
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Не удалось запустить сервис: ${message}\n`);
  process.exit(1);
});
