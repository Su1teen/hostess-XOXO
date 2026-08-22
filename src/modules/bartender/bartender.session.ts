import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { rateLimited, unauthorized } from '../../lib/errors.js';

export interface BartenderSessionConfig {
  /** SHA-256 hex от PIN (предпочтительный способ). */
  pinHash?: string;
  /** Временный fallback: PIN в открытом виде из env. */
  pin?: string;
  sessionTtlMinutes: number;
  maxAttempts: number;
  attemptWindowSeconds: number;
}

export interface BartenderSession {
  token: string;
  expiresAt: Date;
}

interface AttemptState {
  count: number;
  windowStartedAt: number;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a.toLowerCase(), 'utf8');
  const right = Buffer.from(b.toLowerCase(), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Сессии панели бармена.
 *
 * PIN проверяется один раз при входе, дальше клиент использует случайный
 * короткоживущий токен. PIN и токены никогда не логируются и не попадают в URL.
 * Хранилище — память процесса: рестарт инвалидирует сессии, это допустимо.
 */
export class BartenderSessionService {
  private readonly sessions = new Map<string, number>();
  private readonly attempts = new Map<string, AttemptState>();
  private readonly expectedHash: string | null;

  constructor(
    private readonly config: BartenderSessionConfig,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.expectedHash = config.pinHash
      ? config.pinHash.trim().toLowerCase()
      : config.pin
        ? sha256Hex(config.pin)
        : null;
  }

  get isConfigured(): boolean {
    return this.expectedHash !== null;
  }

  /** true, если используется временный plaintext PIN из env. */
  get isTemporaryPinMode(): boolean {
    return !this.config.pinHash && Boolean(this.config.pin);
  }

  /**
   * Проверяет PIN и выдаёт токен. Сообщение об ошибке всегда одинаковое:
   * клиент не узнаёт ни длину PIN, ни какой символ неверный.
   */
  login(pin: unknown, clientKey = 'unknown'): BartenderSession {
    this.registerAttempt(clientKey);
    if (!this.expectedHash || typeof pin !== 'string' || pin.length === 0) {
      throw unauthorized('Неверный PIN');
    }
    if (!timingSafeEqualHex(sha256Hex(pin), this.expectedHash)) {
      throw unauthorized('Неверный PIN');
    }
    this.attempts.delete(clientKey);

    const token = randomBytes(32).toString('base64url');
    const expiresAtMs = this.now() + this.config.sessionTtlMinutes * 60_000;
    this.sessions.set(token, expiresAtMs);
    this.pruneSessions();
    return { token, expiresAt: new Date(expiresAtMs) };
  }

  /** Бросает 401, если токен неизвестен или истёк. */
  requireSession(token: unknown): BartenderSession {
    if (typeof token !== 'string' || token.length === 0) {
      throw unauthorized('Требуется вход в панель бармена');
    }
    const expiresAtMs = this.sessions.get(token);
    if (!expiresAtMs) {
      throw unauthorized('Требуется вход в панель бармена');
    }
    if (expiresAtMs <= this.now()) {
      this.sessions.delete(token);
      throw unauthorized('Сессия истекла, войдите снова');
    }
    return { token, expiresAt: new Date(expiresAtMs) };
  }

  logout(token: unknown): boolean {
    if (typeof token !== 'string') return false;
    return this.sessions.delete(token);
  }

  get activeSessions(): number {
    this.pruneSessions();
    return this.sessions.size;
  }

  private registerAttempt(clientKey: string): void {
    const windowMs = this.config.attemptWindowSeconds * 1000;
    const now = this.now();
    const state = this.attempts.get(clientKey);
    if (!state || now - state.windowStartedAt > windowMs) {
      this.attempts.set(clientKey, { count: 1, windowStartedAt: now });
      return;
    }
    state.count += 1;
    if (state.count > this.config.maxAttempts) {
      throw rateLimited('Слишком много попыток входа, попробуйте позже');
    }
  }

  private pruneSessions(): void {
    const now = this.now();
    for (const [token, expiresAt] of this.sessions) {
      if (expiresAt <= now) this.sessions.delete(token);
    }
  }
}

export const BARTENDER_TOKEN_HEADER = 'x-bartender-token';
