import { iikoAuthFailed, iikoNotConfigured, iikoRequestFailed } from '../lib/errors.js';
import { redactDeep, sanitizeMessage } from '../lib/redaction.js';

/**
 * Типизированный клиент iiko Cloud API (api-ru.iiko.services).
 *
 * Используются только read-only endpoints:
 *   POST {IIKO_AUTH_BASE_URL}/access_token  — авторизация (api/v2)
 *   POST {IIKO_MENU_BASE_URL}/menu          — внешнее меню (api/2)
 *   POST {apiRoot}/api/1/organizations      — список организаций (legacy v1)
 *
 * Важно: auth и menu живут на РАЗНЫХ базах.
 *   authBaseUrl = https://api-ru.iiko.services/api/v2
 *   menuBaseUrl = https://api-ru.iiko.services/api/2
 * Не использовать общий baseUrl для обеих операций.
 *
 * v0.1 не выполняет никаких write-операций: не создаёт заказы, не меняет цены,
 * не создаёт прайс-приказы.
 */

export interface IikoClientOptions {
  /** База авторизации, например https://api-ru.iiko.services/api/v2. */
  authBaseUrl: string;
  /** База запроса меню, например https://api-ru.iiko.services/api/2. */
  menuBaseUrl: string;
  apiKey?: string;
  appId?: string;
  clientSecret?: string;
  /** Путь авторизации относительно authBaseUrl, по умолчанию /access_token. */
  authPath?: string;
  /** Путь запроса меню относительно menuBaseUrl, по умолчанию /menu. */
  menuPath?: string;
  authReturnAdditionalInfo?: boolean;
  authIncludeDisabled?: boolean;
  /** Внешнее меню iiko (externalMenuId) для запроса /api/2/menu. */
  externalMenuId?: string;
  /** Организация по умолчанию (organizationId) для запроса /api/2/menu. */
  organizationId?: string;
  timeoutMs: number;
  syncEnabled: boolean;
  debugRawPayloads: boolean;
  logger: IikoLogger;
  now?: () => number;
  fetchImpl?: typeof fetch;
  onAttempt?: (attempt: IikoAttemptRecord) => void | Promise<void>;
  /** Запас времени до истечения токена, по умолчанию 5 минут. */
  tokenSafetyWindowMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}

export interface IikoLogger {
  info(payload: Record<string, unknown>, message?: string): void;
  warn(payload: Record<string, unknown>, message?: string): void;
  error(payload: Record<string, unknown>, message?: string): void;
  debug(payload: Record<string, unknown>, message?: string): void;
}

export interface IikoAttemptRecord {
  operation: string;
  status: 'SUCCESS' | 'FAILED';
  httpStatus?: number;
  durationMs: number;
  requestReference?: string;
  requestMetadata?: Record<string, unknown>;
  responseMetadata?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
  organizationId?: string;
}

export interface IikoOrganization {
  id: string;
  name: string;
  country?: string;
  restaurantAddress?: string;
  isActive?: boolean;
}

export interface IikoTestConnectionResult {
  ok: boolean;
  organizationsCount: number;
  durationMs: number;
}

/**
 * Безопасный результат одной стадии диагностики iiko.
 * Никогда не содержит значений секретов, apiLogin, токена или тела запроса.
 */
export interface IikoStageDiagnostics {
  finalUrl: string;
  method: 'POST';
  httpStatus: number | null;
  correlationId: string | null;
  error: string | null;
  durationMs: number;
  success: boolean;
}

/**
 * Безопасный результат диагностики авторизации и меню iiko.
 * Содержит две независимые стадии: auth и menu. Если auth не удался или
 * меню не настроено, стадия menu равна null. Ошибки меню никогда не
 * маскируются под ошибки авторизации.
 */
export interface IikoAuthDiagnostics {
  apiLoginConfigured: boolean;
  appIdConfigured: boolean;
  clientSecretConfigured: boolean;
  externalMenuIdConfigured: boolean;
  organizationIdConfigured: boolean;
  syncEnabled: boolean;
  auth: IikoStageDiagnostics;
  menu: IikoStageDiagnostics | null;
  durationMs: number;
}

interface TokenState {
  token: string;
  expiresAtMs: number;
}

/** Токен живёт только в памяти процесса; в PostgreSQL не сохраняется. */
const DEFAULT_TOKEN_TTL_MS = 55 * 60 * 1000;

export class IikoClient {
  private readonly options: Required<
    Pick<
      IikoClientOptions,
      'authBaseUrl' | 'menuBaseUrl' | 'timeoutMs' | 'syncEnabled' | 'debugRawPayloads'
    >
  > &
    IikoClientOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  /** Корень API без версии: https://api-ru.iiko.services — для legacy v1 endpoints. */
  private readonly apiRoot: string;
  private readonly authUrl: string;
  private readonly menuUrl: string;
  private tokenState: TokenState | null = null;
  private inflightToken: Promise<string> | null = null;

  constructor(options: IikoClientOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
    // authBaseUrl = https://api-ru.iiko.services/api/v2  -> authUrl  = .../api/v2/access_token
    // menuBaseUrl = https://api-ru.iiko.services/api/2   -> menuUrl  = .../api/2/menu
    // apiRoot     = https://api-ru.iiko.services          (для legacy /api/1/organizations)
    const authBase = normalizeBase(options.authBaseUrl);
    const menuBase = normalizeBase(options.menuBaseUrl);
    this.apiRoot = stripApiVersion(authBase);
    this.authUrl = `${authBase}${normalizePath(options.authPath ?? '/access_token')}`;
    this.menuUrl = `${menuBase}${normalizePath(options.menuPath ?? '/menu')}`;
  }

  get isConfigured(): boolean {
    return (
      this.options.syncEnabled &&
      Boolean(this.options.apiKey) &&
      Boolean(this.options.appId) &&
      Boolean(this.options.clientSecret)
    );
  }

  private ensureConfigured(): string {
    if (!this.isConfigured || !this.options.apiKey) {
      throw iikoNotConfigured();
    }
    return this.options.apiKey;
  }

  /** Тело запроса авторизации; никогда не покидает клиент. */
  private buildAuthBody(): Record<string, unknown> {
    return {
      apiLogin: this.options.apiKey,
      appId: this.options.appId,
      clientSecret: this.options.clientSecret,
      returnAdditionalInfo: this.options.authReturnAdditionalInfo ?? false,
      includeDisabled: this.options.authIncludeDisabled ?? false,
    };
  }

  /** Возвращает актуальный access token, обновляя его заранее при необходимости. */
  async getAccessToken(forceRefresh = false): Promise<string> {
    this.ensureConfigured();
    const safetyWindow = this.options.tokenSafetyWindowMs ?? 5 * 60 * 1000;

    if (
      !forceRefresh &&
      this.tokenState &&
      this.tokenState.expiresAtMs - safetyWindow > this.now()
    ) {
      return this.tokenState.token;
    }
    if (this.inflightToken && !forceRefresh) {
      return this.inflightToken;
    }

    this.inflightToken = (async () => {
      const response = await this.rawRequest<{ token?: string; correlationId?: string }>(
        this.authUrl,
        this.buildAuthBody(),
        { operation: 'access_token', withAuth: false, absoluteUrl: true },
      );
      const token = response.body.token;
      if (!token) {
        throw iikoAuthFailed({ reason: 'token_missing_in_response' });
      }
      this.tokenState = { token, expiresAtMs: this.now() + DEFAULT_TOKEN_TTL_MS };
      return token;
    })();

    try {
      return await this.inflightToken;
    } finally {
      this.inflightToken = null;
    }
  }

  async getOrganizations(): Promise<IikoOrganization[]> {
    const { body } = await this.authorizedRequest<{ organizations?: unknown }>(
      '/api/1/organizations',
      { returnAdditionalInfo: true, includeDisabled: true },
      'organizations',
    );
    const organizations = Array.isArray(body.organizations) ? body.organizations : [];
    return organizations
      .map(normalizeOrganization)
      .filter((org): org is IikoOrganization => Boolean(org));
  }

  /**
   * Внешнее меню iiko: POST {menuUrl} (= {IIKO_MENU_BASE_URL}/menu = /api/2/menu).
   * Тело: { externalMenuId, organizationIds: [organizationId] }.
   * Токен получается автоматически и кэшируется только в памяти.
   * Возвращает сырой распарсенный JSON меню; логирование тела отключено.
   */
  async getExternalMenu(
    organizationId: string,
    externalMenuId?: string,
  ): Promise<unknown> {
    const menuId = externalMenuId ?? this.options.externalMenuId;
    if (!menuId) {
      throw iikoNotConfigured();
    }
    const { body } = await this.authorizedRequest<unknown>(
      this.menuUrl,
      { externalMenuId: menuId, organizationIds: [organizationId] },
      'menu',
      organizationId,
      true,
    );
    return body;
  }

  async testConnection(): Promise<IikoTestConnectionResult> {
    const startedAt = this.now();
    const organizations = await this.getOrganizations();
    return {
      ok: true,
      organizationsCount: organizations.length,
      durationMs: this.now() - startedAt,
    };
  }

  /** Сбрасывает кэш токена (используется при 401 от iiko). */
  resetToken(): void {
    this.tokenState = null;
  }

  /**
   * Безопасная двухстадийная диагностика iiko: auth и menu.
   *
   * Стадия auth: реальный POST к /api/v2/access_token.
   * Стадия menu: если auth успешен и externalMenuId+organizationId настроены,
   *   реальный POST к /api/v2/menu с Bearer-токеном из стадии auth.
   *
   * Никогда не выбрасывает ошибку и не возвращает токен, apiLogin,
   * clientSecret или тело запроса. Ошибки меню отмечаются отдельно и никогда
   * не маскируются под IIKO_AUTH_FAILED.
   */
  async diagnoseAuth(): Promise<IikoAuthDiagnostics> {
    const startedAt = this.now();
    const apiLoginConfigured = Boolean(this.options.apiKey);
    const appIdConfigured = Boolean(this.options.appId);
    const clientSecretConfigured = Boolean(this.options.clientSecret);
    const externalMenuIdConfigured = Boolean(this.options.externalMenuId);
    const organizationIdConfigured = Boolean(this.options.organizationId);

    const authStage = await this.runAuthDiagnosisStage();

    let menuStage: IikoStageDiagnostics | null = null;
    if (authStage.success) {
      if (!externalMenuIdConfigured || !organizationIdConfigured) {
        menuStage = {
          finalUrl: this.menuUrl,
          method: 'POST',
          httpStatus: null,
          correlationId: null,
          error:
            'Меню не запрошено: не заданы IIKO_EXTERNAL_MENU_ID и/или IIKO_ORGANIZATION_ID.',
          durationMs: 0,
          success: false,
        };
      } else {
        // Токен из стадии auth используется только для пробы меню и не кэшируется.
        const token = await this.readFreshTokenForDiagnostics();
        menuStage = token
          ? await this.runMenuDiagnosisStage(token)
          : {
              finalUrl: this.menuUrl,
              method: 'POST',
              httpStatus: null,
              correlationId: null,
              error: 'Не удалось получить токен для пробы меню.',
              durationMs: 0,
              success: false,
            };
      }
    }

    return {
      apiLoginConfigured,
      appIdConfigured,
      clientSecretConfigured,
      externalMenuIdConfigured,
      organizationIdConfigured,
      syncEnabled: this.options.syncEnabled,
      auth: authStage,
      menu: menuStage,
      durationMs: this.now() - startedAt,
    };
  }

  /** Стадия auth: POST /api/v2/access_token без Bearer. */
  private async runAuthDiagnosisStage(): Promise<IikoStageDiagnostics> {
    const stage: IikoStageDiagnostics = {
      finalUrl: this.authUrl,
      method: 'POST',
      httpStatus: null,
      correlationId: null,
      error: null,
      durationMs: 0,
      success: false,
    };

    if (!this.options.apiKey || !this.options.appId || !this.options.clientSecret) {
      stage.error = 'Не все учётные данные настроены (apiLogin/appId/clientSecret).';
      return stage;
    }

    const startedAt = this.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await this.fetchImpl(this.authUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(this.buildAuthBody()),
        signal: controller.signal,
      });
      stage.httpStatus = response.status;
      const text = await response.text();
      const parsed = safeJsonParse(text);
      const record = asRecord(parsed);
      const correlationId = optionalString(record?.correlationId);
      stage.correlationId = correlationId ?? null;
      if (!response.ok) {
        stage.error = sanitizeMessage(
          extractIikoErrorDescription(parsed) ?? `HTTP ${response.status}`,
        );
      } else {
        const token = optionalString(record?.token);
        if (!token) {
          stage.error = 'Токен отсутствует в ответе авторизации.';
        } else {
          stage.success = true;
        }
      }
    } catch (error) {
      stage.error = sanitizeMessage(
        isAbortError(error) ? 'TIMEOUT' : errorMessageOf(error),
      );
    } finally {
      clearTimeout(timer);
    }
    stage.durationMs = this.now() - startedAt;
    return stage;
  }

  /** Стадия menu: POST /api/v2/menu с Bearer-токеном. */
  private async runMenuDiagnosisStage(token: string): Promise<IikoStageDiagnostics> {
    const stage: IikoStageDiagnostics = {
      finalUrl: this.menuUrl,
      method: 'POST',
      httpStatus: null,
      correlationId: null,
      error: null,
      durationMs: 0,
      success: false,
    };

    const startedAt = this.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await this.fetchImpl(this.menuUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          externalMenuId: this.options.externalMenuId,
          organizationIds: [this.options.organizationId],
        }),
        signal: controller.signal,
      });
      stage.httpStatus = response.status;
      const text = await response.text();
      const parsed = safeJsonParse(text);
      const record = asRecord(parsed);
      const correlationId = optionalString(record?.correlationId);
      stage.correlationId = correlationId ?? null;
      if (!response.ok) {
        // Ошибка меню — отдельная стадия, не подменяет IIKO_AUTH_FAILED.
        stage.error = sanitizeMessage(
          extractIikoErrorDescription(parsed) ?? `HTTP ${response.status}`,
        );
      } else {
        stage.success = true;
      }
    } catch (error) {
      stage.error = sanitizeMessage(
        isAbortError(error) ? 'TIMEOUT' : errorMessageOf(error),
      );
    } finally {
      clearTimeout(timer);
    }
    stage.durationMs = this.now() - startedAt;
    return stage;
  }

  /**
   * Получает одноразовый токен для диагностики, не загрязняя кэш tokenState.
   * Возвращает токен только в память стадии-вызова; никогда не логируется.
   */
  private async readFreshTokenForDiagnostics(): Promise<string | null> {
    if (!this.options.apiKey || !this.options.appId || !this.options.clientSecret) {
      return null;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await this.fetchImpl(this.authUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(this.buildAuthBody()),
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const parsed = asRecord(safeJsonParse(await response.text()));
      return optionalString(parsed?.token) ?? null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async authorizedRequest<T>(
    path: string,
    payload: Record<string, unknown>,
    operation: string,
    organizationId?: string,
    absoluteUrl = false,
  ): Promise<{ body: T; httpStatus: number }> {
    this.ensureConfigured();
    const token = await this.getAccessToken();
    try {
      return await this.rawRequest<T>(path, payload, {
        operation,
        token,
        organizationId,
        absoluteUrl,
      });
    } catch (error) {
      // Единственный безопасный retry на 4xx: устаревший session key.
      if (isUnauthorizedIikoError(error)) {
        this.resetToken();
        const refreshed = await this.getAccessToken(true);
        return this.rawRequest<T>(path, payload, {
          operation,
          token: refreshed,
          organizationId,
          absoluteUrl,
        });
      }
      throw error;
    }
  }

  private async rawRequest<T>(
    path: string,
    payload: Record<string, unknown>,
    context: {
      operation: string;
      token?: string;
      withAuth?: boolean;
      organizationId?: string;
      absoluteUrl?: boolean;
    },
  ): Promise<{ body: T; httpStatus: number }> {
    const maxRetries = this.options.maxRetries ?? 2;
    const retryDelayMs = this.options.retryDelayMs ?? 250;
    const url = context.absoluteUrl ? path : `${this.apiRoot}${path}`;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const startedAt = this.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
      try {
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          accept: 'application/json',
        };
        if (context.withAuth !== false && context.token) {
          headers.authorization = `Bearer ${context.token}`;
        }
        const response = await this.fetchImpl(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        const durationMs = this.now() - startedAt;
        const text = await response.text();
        const parsed = safeJsonParse(text);

        if (this.options.debugRawPayloads) {
          this.options.logger.debug(
            { operation: context.operation, payload: redactDeep(parsed) },
            'iiko raw payload (redacted)',
          );
        }

        if (!response.ok) {
          const transient = response.status >= 500 || response.status === 429;
          const errorDescription = extractIikoErrorDescription(parsed);
          await this.record({
            operation: context.operation,
            status: 'FAILED',
            httpStatus: response.status,
            durationMs,
            requestReference: path,
            organizationId: context.organizationId,
            errorCode: `HTTP_${response.status}`,
            errorMessage: sanitizeMessage(errorDescription ?? `HTTP ${response.status}`),
          });
          this.options.logger.warn(
            {
              operation: context.operation,
              httpStatus: response.status,
              durationMs,
              attempt,
            },
            'iiko request failed',
          );
          const error =
            context.operation === 'access_token' && response.status < 500
              ? iikoAuthFailed({ httpStatus: response.status })
              : iikoRequestFailed({ httpStatus: response.status, operation: context.operation });
          if (transient && attempt < maxRetries) {
            lastError = error;
            await sleep(retryDelayMs * (attempt + 1));
            continue;
          }
          throw error;
        }

        await this.record({
          operation: context.operation,
          status: 'SUCCESS',
          httpStatus: response.status,
          durationMs,
          requestReference: path,
          organizationId: context.organizationId,
          responseMetadata: { size: text.length },
        });
        this.options.logger.info(
          { operation: context.operation, httpStatus: response.status, durationMs },
          'iiko request ok',
        );
        return { body: (parsed ?? {}) as T, httpStatus: response.status };
      } catch (error) {
        const durationMs = this.now() - startedAt;
        if (isAppErrorLike(error)) {
          throw error;
        }
        // Сетевые ошибки и timeout — retry.
        lastError = error;
        await this.record({
          operation: context.operation,
          status: 'FAILED',
          durationMs,
          requestReference: path,
          organizationId: context.organizationId,
          errorCode: isAbortError(error) ? 'TIMEOUT' : 'NETWORK_ERROR',
          errorMessage: sanitizeMessage(errorMessageOf(error)),
        });
        this.options.logger.warn(
          {
            operation: context.operation,
            durationMs,
            attempt,
            errorCode: isAbortError(error) ? 'TIMEOUT' : 'NETWORK_ERROR',
          },
          'iiko network error',
        );
        if (attempt < maxRetries) {
          await sleep(retryDelayMs * (attempt + 1));
          continue;
        }
        throw iikoRequestFailed({ operation: context.operation, reason: 'network' });
      } finally {
        clearTimeout(timer);
      }
    }

    throw isAppErrorLike(lastError)
      ? lastError
      : iikoRequestFailed({ operation: context.operation });
  }

  private async record(attempt: IikoAttemptRecord): Promise<void> {
    if (!this.options.onAttempt) return;
    try {
      await this.options.onAttempt(attempt);
    } catch (error) {
      this.options.logger.warn(
        { errorMessage: sanitizeMessage(errorMessageOf(error)) },
        'не удалось сохранить iiko_sync_attempt',
      );
    }
  }
}

/**
 * Нормализует базу URL: убирает trailing slash.
 * https://api-ru.iiko.services/api/v2/ => https://api-ru.iiko.services/api/v2
 */
function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/**
 * Убирает суффикс /api/<version> из base, возвращая корень API.
 * https://api-ru.iiko.services/api/v2 => https://api-ru.iiko.services
 * Используется только для legacy v1 endpoints (/api/1/organizations).
 */
function stripApiVersion(base: string): string {
  return base.replace(/\/api\/v?\d+$/, '');
}

/** Гарантирует, что путь начинается с / и не имеет trailing slash. */
function normalizePath(path: string): string {
  const trimmed = path.trim();
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withSlash.replace(/\/+$/, '') || '/';
}

function safeJsonParse(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractIikoErrorDescription(payload: unknown): string | undefined {
  const record = asRecord(payload);
  if (!record) return undefined;
  const candidates = ['errorDescription', 'error', 'message'];
  for (const key of candidates) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizeOrganization(value: unknown): IikoOrganization | undefined {
  const record = asRecord(value);
  const id = optionalString(record?.id);
  if (!id) return undefined;
  return {
    id,
    name: optionalString(record?.name) ?? 'Без названия',
    country: optionalString(record?.country),
    restaurantAddress: optionalString(record?.restaurantAddress),
    isActive: typeof record?.isActive === 'boolean' ? record.isActive : undefined,
  };
}

function isAppErrorLike(error: unknown): error is Error & { code: string; statusCode: number } {
  return (
    error instanceof Error &&
    'code' in error &&
    'statusCode' in error &&
    typeof (error as { statusCode: unknown }).statusCode === 'number'
  );
}

function isUnauthorizedIikoError(error: unknown): boolean {
  if (!isAppErrorLike(error)) return false;
  const details = (error as { details?: Record<string, unknown> }).details;
  return details?.httpStatus === 401;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
