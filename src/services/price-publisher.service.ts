import type { AppEnv } from '../config/env.js';
import type { RoundsService } from '../modules/rounds/rounds.service.js';

export interface ValidationResult {
  valid: boolean;
  mode: PricePublisherMode;
  issues: string[];
  productsCount: number;
}

export interface ApplyResult {
  applied: boolean;
  mode: PricePublisherMode;
  message: string;
  /** Данные для ручного применения цен администратором (mode=manual). */
  export?: unknown;
}

export interface VerificationResult {
  verified: boolean;
  mode: PricePublisherMode;
  message: string;
}

export interface RollbackResult {
  rolledBack: boolean;
  mode: PricePublisherMode;
  message: string;
}

export type PricePublisherMode = 'disabled' | 'manual' | 'front_plugin';

/**
 * Контракт будущего механизма применения цен. В v0.1 ни одна реализация
 * не обращается к write API iiko.
 */
export interface PricePublisher {
  readonly mode: PricePublisherMode;
  validate(roundId: string): Promise<ValidationResult>;
  apply(roundId: string): Promise<ApplyResult>;
  verify(roundId: string): Promise<VerificationResult>;
  rollback(roundId: string): Promise<RollbackResult>;
}

abstract class BasePublisher implements PricePublisher {
  abstract readonly mode: PricePublisherMode;

  constructor(protected readonly rounds: RoundsService) {}

  async validate(roundId: string): Promise<ValidationResult> {
    const round = await this.rounds.getRound(roundId);
    const issues: string[] = [];
    if (round.prices.length === 0) issues.push('В раунде нет ни одного товара');
    for (const price of round.prices) {
      if (price.calculatedPrice.lt(price.minPrice)) {
        issues.push(`${price.product.name}: цена ниже minPrice`);
      }
      if (price.calculatedPrice.gt(price.maxPrice)) {
        issues.push(`${price.product.name}: цена выше maxPrice`);
      }
      if (price.calculatedPrice.lte(0)) {
        issues.push(`${price.product.name}: некорректная цена`);
      }
    }
    return {
      valid: issues.length === 0,
      mode: this.mode,
      issues,
      productsCount: round.prices.length,
    };
  }

  abstract apply(roundId: string): Promise<ApplyResult>;

  async verify(roundId: string): Promise<VerificationResult> {
    const round = await this.rounds.getRound(roundId);
    const published = round.prices.every((price) => price.publishedPrice !== null);
    return {
      verified: published,
      mode: this.mode,
      message: published
        ? 'Все цены раунда зафиксированы в базе backend-а (в iiko изменения не отправлялись)'
        : 'Раунд ещё не опубликован в backend-е',
    };
  }

  async rollback(roundId: string): Promise<RollbackResult> {
    const result = await this.rounds.rollbackRound(roundId, 'price-publisher');
    return {
      rolledBack: true,
      mode: this.mode,
      message: result.restoredRoundKey
        ? `Актуальным снова стал раунд ${result.restoredRoundKey}`
        : 'Раунд откатан, предыдущего опубликованного раунда нет',
    };
  }
}

/** По умолчанию: применение цен запрещено. */
export class DisabledPricePublisher extends BasePublisher {
  readonly mode = 'disabled' as const;

  async apply(): Promise<ApplyResult> {
    return {
      applied: false,
      mode: this.mode,
      message:
        'Применение цен отключено (PRICE_PUBLISHER_MODE=disabled). Backend v0.1 не меняет цены в iiko.',
    };
  }
}

/** Ручной режим: готовит таблицу для администратора, ничего не отправляет в iiko. */
export class ManualPricePublisher extends BasePublisher {
  readonly mode = 'manual' as const;

  async apply(roundId: string): Promise<ApplyResult> {
    const exported = await this.rounds.buildManualExport(roundId);
    return {
      applied: false,
      mode: this.mode,
      message:
        'Сформирован ручной экспорт цен. Применение в iiko выполняет администратор вручную; backend в iiko ничего не отправляет.',
      export: exported,
    };
  }
}

/**
 * Заготовка под будущий iikoFront plugin.
 *
 * ВАЖНО: фактическая установка predefinedPrice выполняется внутри iikoFront
 * plugin (C#) на кассе, а не этим backend-ом. Backend только отдаёт цену
 * опубликованного раунда через POST /api/v1/front-plugin/price-quote.
 */
export class FutureFrontPluginPricePublisher extends BasePublisher {
  readonly mode = 'front_plugin' as const;

  async apply(roundId: string): Promise<ApplyResult> {
    const exported = await this.rounds.buildManualExport(roundId);
    // TODO(v0.3): здесь появится нотификация плагина о новом раунде.
    // Установку цены всё равно выполняет плагин через predefinedPrice в iikoFront.
    return {
      applied: false,
      mode: this.mode,
      message:
        'Режим front_plugin: backend публикует цену только через price-quote API. Установку цены в чеке делает iikoFront plugin.',
      export: exported,
    };
  }
}

export function createPricePublisher(env: AppEnv, rounds: RoundsService): PricePublisher {
  switch (env.PRICE_PUBLISHER_MODE) {
    case 'manual':
      return new ManualPricePublisher(rounds);
    case 'front_plugin':
      return new FutureFrontPluginPricePublisher(rounds);
    case 'disabled':
    default:
      return new DisabledPricePublisher(rounds);
  }
}
