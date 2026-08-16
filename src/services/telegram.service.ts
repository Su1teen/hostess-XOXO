import { telegramNotConfigured } from '../lib/errors.js';
import { sanitizeMessage } from '../lib/redaction.js';
import type { AuditService } from './audit.service.js';

export type TelegramAlertKind =
  | 'IIKO_CONNECTION_FAILED'
  | 'IIKO_MENU_SYNC_FAILED'
  | 'CRON_SIMULATION_FAILED'
  | 'ROUND_PUBLISH_FAILED'
  | 'DATABASE_FAILURE'
  | 'CRON_SUMMARY'
  | 'TEST';

export interface TelegramServiceOptions {
  enabled: boolean;
  botToken?: string;
  chatId?: string;
  cooldownSeconds: number;
  timeoutMs: number;
  logger: { warn(payload: Record<string, unknown>, message?: string): void };
  audit?: AuditService;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface TelegramSendResult {
  sent: boolean;
  reason?: 'disabled' | 'cooldown' | 'failed';
}

/**
 * Отправка алертов в Telegram. При TELEGRAM_ENABLED=false ни один сетевой
 * запрос не выполняется. Секреты в текст сообщений не подставляются.
 */
export class TelegramService {
  private readonly lastSentAtByKind = new Map<TelegramAlertKind, number>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: TelegramServiceOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
  }

  get isConfigured(): boolean {
    return this.options.enabled && Boolean(this.options.botToken && this.options.chatId);
  }

  /** Прямая отправка (используется endpoint-ом /admin/telegram/test). */
  async sendMessage(text: string): Promise<TelegramSendResult> {
    if (!this.isConfigured) throw telegramNotConfigured();
    return this.deliver(text, 'TEST', true);
  }

  /** Отправка алерта с антиспам-кулдауном на тип ошибки. */
  async sendAlert(kind: TelegramAlertKind, text: string): Promise<TelegramSendResult> {
    if (!this.isConfigured) return { sent: false, reason: 'disabled' };
    const last = this.lastSentAtByKind.get(kind);
    const cooldownMs = this.options.cooldownSeconds * 1000;
    if (last !== undefined && this.now() - last < cooldownMs) {
      return { sent: false, reason: 'cooldown' };
    }
    return this.deliver(text, kind, false);
  }

  private async deliver(
    text: string,
    kind: TelegramAlertKind,
    throwOnFailure: boolean,
  ): Promise<TelegramSendResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await this.fetchImpl(
        `https://api.telegram.org/bot${this.options.botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: this.options.chatId,
            text: sanitizeMessage(text),
            disable_web_page_preview: true,
          }),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        this.options.logger.warn(
          { httpStatus: response.status, kind },
          'Telegram sendMessage failed',
        );
        if (throwOnFailure) {
          throw telegramNotConfigured();
        }
        return { sent: false, reason: 'failed' };
      }
      this.lastSentAtByKind.set(kind, this.now());
      await this.options.audit?.log({
        action: 'TELEGRAM_ALERT_SENT',
        actorType: 'SYSTEM',
        summary: `Telegram-алерт отправлен: ${kind}`,
        metadata: { kind },
      });
      return { sent: true };
    } catch (error) {
      this.options.logger.warn(
        {
          kind,
          errorMessage: sanitizeMessage(error instanceof Error ? error.message : String(error)),
        },
        'Telegram sendMessage error',
      );
      if (throwOnFailure) throw error;
      return { sent: false, reason: 'failed' };
    } finally {
      clearTimeout(timer);
    }
  }
}
