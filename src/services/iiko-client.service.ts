import { iikoAuthFailed, iikoNotConfigured, iikoRequestFailed } from '../lib/errors.js';
import { redactDeep, sanitizeMessage } from '../lib/redaction.js';

/**
 * Типизированный клиент iiko Cloud API (api-ru.iiko.services).
 *
 * Используются только read-only endpoints, задокументированные в iikoCloud API:
 *   POST /api/1/access_token      — получение session key по apiLogin
 *   POST /api/1/organizations     — список организаций
 *   POST /api/1/nomenclature      — номенклатура организации
 *   POST /api/1/stop_lists        — стоп-лист
 *   POST /api/1/terminal_groups   — терминальные группы
 *   POST /api/2/menu              — внешние меню (v2)
 *   POST /api/2/menu/by_id        — внешнее меню по ID (v2)
 *
 * v0.1 не выполняет никаких write-операций: не создаёт заказы, не меняет цены,
 * не создаёт прайс-приказы.
 */

export interface IikoClientOptions {
  baseUrl: string;
  apiKey?: string;
  appId?: string;
  clientSecret?: string;
  /** Путь авторизации относительно baseUrl, по умолчанию /access_token. */
  authPath?: string;
  authReturnAdditionalInfo?: boolean;
  authIncludeDisabled?: boolean;
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

export interface IikoProductGroupDto {
  id: string;
  parentGroup?: string | null;
  name: string;
  isDeleted?: boolean;
}

export interface IikoProductDto {
  id: string;
  parentGroup?: string | null;
  name: string;
  description?: string | null;
  code?: string | null;
  type?: string | null;
  measureUnit?: string | null;
  price?: number | null;
  isDeleted?: boolean;
  imageLinks?: string[];
}

export interface IikoNomenclature {
  revision?: number;
  groups: IikoProductGroupDto[];
  products: IikoProductDto[];
}

export interface IikoStopListItem {
  productId: string;
  balance?: number | null;
}

export interface IikoTestConnectionResult {
  ok: boolean;
  organizationsCount: number;
  durationMs: number;
}

/**
 * Безопасный результат диагностики авторизации iiko.
 * Никогда не содержит значений секретов, apiLogin, токена или тела запроса.
 */
export interface IikoAuthDiagnostics {
  finalUrl: string;
  method: 'POST';
  apiLoginConfigured: boolean;
  appIdConfigured: boolean;
  clientSecretConfigured: boolean;
  syncEnabled: boolean;
  upstream: {
    httpStatus: number | null;
    correlationId: string | null;
    error: string | null;
  };
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
    Pick<IikoClientOptions, 'baseUrl' | 'timeoutMs' | 'syncEnabled' | 'debugRawPayloads'>
  > &
    IikoClientOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly rootUrl: string;
  private readonly authUrl: string;
  private readonly authPath: string;
  private tokenState: TokenState | null = null;
  private inflightToken: Promise<string> | null = null;

  constructor(options: IikoClientOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.rootUrl = normalizeRootUrl(options.baseUrl);
    this.authPath = normalizeAuthPath(options.authPath ?? '/access_token');
    this.authUrl = buildAuthUrl(options.baseUrl, this.authPath);
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

  async getNomenclature(organizationId: string): Promise<IikoNomenclature> {
    const { body } = await this.authorizedRequest<{
      revision?: number;
      groups?: unknown;
      products?: unknown;
    }>('/api/1/nomenclature', { organizationId }, 'nomenclature', organizationId);

    return {
      revision: typeof body.revision === 'number' ? body.revision : undefined,
      groups: asArray(body.groups).map(normalizeGroup).filter(isDefined),
      products: asArray(body.products).map(normalizeProduct).filter(isDefined),
    };
  }

  /**
   * Внешние меню (iiko API v2). Нужны только если у бара настроены внешние меню
   * с ценовыми категориями; для v0.1 используется как дополнительная диагностика.
   */
  async getExternalMenuOrMenu(organizationId: string): Promise<{
    externalMenus: Array<{ id: string; name: string }>;
    priceCategories: Array<{ id: string; name: string }>;
  }> {
    const { body } = await this.authorizedRequest<{
      externalMenus?: unknown;
      priceCategories?: unknown;
    }>('/api/2/menu', { organizationIds: [organizationId] }, 'menu_v2', organizationId);

    return {
      externalMenus: asArray(body.externalMenus)
        .map((item) => normalizeIdName(item))
        .filter(isDefined),
      priceCategories: asArray(body.priceCategories)
        .map((item) => normalizeIdName(item))
        .filter(isDefined),
    };
  }

  async getStopList(organizationId: string): Promise<IikoStopListItem[]> {
    const { body } = await this.authorizedRequest<{ terminalGroupStopLists?: unknown }>(
      '/api/1/stop_lists',
      { organizationIds: [organizationId] },
      'stop_lists',
      organizationId,
    );

    const items: IikoStopListItem[] = [];
    for (const group of asArray(body.terminalGroupStopLists)) {
      const items_ = asRecord(group)?.items;
      for (const terminal of asArray(items_)) {
        for (const item of asArray(asRecord(terminal)?.items)) {
          const record = asRecord(item);
          const productId = typeof record?.productId === 'string' ? record.productId : undefined;
          if (!productId) continue;
          items.push({
            productId,
            balance: typeof record?.balance === 'number' ? record.balance : null,
          });
        }
      }
    }
    return items;
  }

  async getTerminalGroups(organizationId: string): Promise<Array<{ id: string; name: string }>> {
    const { body } = await this.authorizedRequest<{ terminalGroups?: unknown }>(
      '/api/1/terminal_groups',
      { organizationIds: [organizationId] },
      'terminal_groups',
      organizationId,
    );
    const groups: Array<{ id: string; name: string }> = [];
    for (const entry of asArray(body.terminalGroups)) {
      for (const item of asArray(asRecord(entry)?.items)) {
        const normalized = normalizeIdName(item);
        if (normalized) groups.push(normalized);
      }
    }
    return groups;
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
   * Безопасная диагностика авторизации iiko. Выполняет реальный POST-запрос
   * к /access_token, но никогда не выбрасывает ошибку и не возвращает токен,
   * apiLogin, clientSecret или тело запроса. Только факты и upstream-ответ.
   */
  async diagnoseAuth(): Promise<IikoAuthDiagnostics> {
    const startedAt = this.now();
    const apiLoginConfigured = Boolean(this.options.apiKey);
    const appIdConfigured = Boolean(this.options.appId);
    const clientSecretConfigured = Boolean(this.options.clientSecret);

    const base: IikoAuthDiagnostics = {
      finalUrl: this.authUrl,
      method: 'POST',
      apiLoginConfigured,
      appIdConfigured,
      clientSecretConfigured,
      syncEnabled: this.options.syncEnabled,
      upstream: { httpStatus: null, correlationId: null, error: null },
      durationMs: 0,
    };

    if (!apiLoginConfigured || !appIdConfigured || !clientSecretConfigured) {
      base.upstream.error = 'Не все учётные данные настроены (apiLogin/appId/clientSecret).';
      base.durationMs = this.now() - startedAt;
      return base;
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
      base.upstream.httpStatus = response.status;
      const text = await response.text();
      const parsed = safeJsonParse(text);
      const record = asRecord(parsed);
      const correlationId = optionalString(record?.correlationId);
      base.upstream.correlationId = correlationId ?? null;
      if (!response.ok) {
        base.upstream.error = sanitizeMessage(
          extractIikoErrorDescription(parsed) ?? `HTTP ${response.status}`,
        );
      }
    } catch (error) {
      base.upstream.error = sanitizeMessage(
        isAbortError(error) ? 'TIMEOUT' : errorMessageOf(error),
      );
    } finally {
      clearTimeout(timer);
    }

    base.durationMs = this.now() - startedAt;
    return base;
  }

  private async authorizedRequest<T>(
    path: string,
    payload: Record<string, unknown>,
    operation: string,
    organizationId?: string,
  ): Promise<{ body: T; httpStatus: number }> {
    this.ensureConfigured();
    const token = await this.getAccessToken();
    try {
      return await this.rawRequest<T>(path, payload, { operation, token, organizationId });
    } catch (error) {
      // Единственный безопасный retry на 4xx: устаревший session key.
      if (isUnauthorizedIikoError(error)) {
        this.resetToken();
        const refreshed = await this.getAccessToken(true);
        return this.rawRequest<T>(path, payload, {
          operation,
          token: refreshed,
          organizationId,
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
    const url = context.absoluteUrl ? path : `${this.rootUrl}${path}`;
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

function normalizeRootUrl(baseUrl: string): string {
  // IIKO_API_BASE_URL исторически содержит /api/1; клиент сам выбирает версию пути.
  return baseUrl.replace(/\/+$/, '').replace(/\/api\/\d+$/, '');
}

/** Гарантирует, что путь авторизации начинается с / и не имеет trailing slash. */
function normalizeAuthPath(path: string): string {
  const trimmed = path.trim();
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withSlash.replace(/\/+$/, '') || '/';
}

/**
 * Безопасно собирает итоговый URL авторизации из baseUrl и authPath.
 * IIKO_API_BASE_URL=https://api-ru.iiko.services/api/1 + IIKO_AUTH_PATH=/access_token
 * => https://api-ru.iiko.services/api/1/access_token
 *
 * Не дублирует /api/1: путь авторизации присоединяется как есть, без
 * повторного добавления версии API.
 */
function buildAuthUrl(baseUrl: string, authPath: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  const normalizedPath = normalizeAuthPath(authPath);
  return `${normalizedBase}${normalizedPath}`;
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

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isDefined<T>(value: T | undefined | null): value is T {
  return value !== undefined && value !== null;
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

function normalizeGroup(value: unknown): IikoProductGroupDto | undefined {
  const record = asRecord(value);
  const id = optionalString(record?.id);
  if (!id) return undefined;
  return {
    id,
    parentGroup: optionalString(record?.parentGroup) ?? null,
    name: optionalString(record?.name) ?? 'Без названия',
    isDeleted: typeof record?.isDeleted === 'boolean' ? record.isDeleted : false,
  };
}

function normalizeProduct(value: unknown): IikoProductDto | undefined {
  const record = asRecord(value);
  const id = optionalString(record?.id);
  if (!id) return undefined;

  // Цена может приходить в sizePrices[].price.currentPrice либо в price.
  let price: number | null = null;
  const sizePrices = asArray(record?.sizePrices);
  for (const sizePrice of sizePrices) {
    const priceRecord = asRecord(asRecord(sizePrice)?.price);
    const current = priceRecord?.currentPrice;
    if (typeof current === 'number') {
      price = current;
      break;
    }
  }
  if (price === null && typeof record?.price === 'number') {
    price = record.price;
  }

  return {
    id,
    parentGroup: optionalString(record?.parentGroup) ?? null,
    name: optionalString(record?.name) ?? 'Без названия',
    description: optionalString(record?.description) ?? null,
    code: optionalString(record?.code) ?? null,
    type: optionalString(record?.type) ?? optionalString(record?.productCategoryId) ?? null,
    measureUnit: optionalString(record?.measureUnit) ?? null,
    price,
    isDeleted: typeof record?.isDeleted === 'boolean' ? record.isDeleted : false,
    imageLinks: asArray(record?.imageLinks).filter(
      (item): item is string => typeof item === 'string',
    ),
  };
}

function normalizeIdName(value: unknown): { id: string; name: string } | undefined {
  const record = asRecord(value);
  const id = optionalString(record?.id);
  if (!id) return undefined;
  return { id, name: optionalString(record?.name) ?? 'Без названия' };
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
