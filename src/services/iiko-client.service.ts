import { createHash } from 'node:crypto';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { URL } from 'node:url';
import {
  iikoAuthFailed,
  iikoMenuJsonParseFailed,
  iikoMenuNetworkError,
  iikoMenuRequestFailed,
  iikoMenuTimeout,
  iikoNotConfigured,
  iikoRequestFailed,
} from '../lib/errors.js';
import { redactDeep, sanitizeMessage } from '../lib/redaction.js';

/**
 * Типизированный клиент iiko Cloud API (api-ru.iiko.services).
 *
 * Используются только read-only endpoints:
 *   POST {IIKO_AUTH_BASE_URL}/access_token  — авторизация (api/v2)
 *   POST {IIKO_MENU_BASE_URL}/menu/by_id    — полное внешнее меню (api/2)
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

/**
 * Результат вызова https.request-подобной функции.
 * Используется и для production (node:https.request), и для тестовых моков.
 */
export interface IikoHttpsRequestResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/**
 * Тип функции-транспорта https.request, инъектируемой в IikoClient.
 * Принимает URL, заголовки и тело; возвращает статус, заголовки и тело ответа.
 * Не выполняет retry — это ответственность вызывающей стороны.
 */
export type IikoHttpsRequestFn = (
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
) => Promise<IikoHttpsRequestResult>;

export interface IikoClientOptions {
  /** База авторизации, например https://api-ru.iiko.services/api/v2. */
  authBaseUrl: string;
  /** База запроса меню, например https://api-ru.iiko.services/api/2. */
  menuBaseUrl: string;
  apiKey?: string;
  authApiKeyField?: 'apiLogin';
  appId?: string;
  clientSecret?: string;
  /** Путь авторизации относительно authBaseUrl, по умолчанию /access_token. */
  authPath?: string;
  /** Путь запроса меню относительно menuBaseUrl, по умолчанию /menu/by_id. */
  menuPath?: string;
  authReturnAdditionalInfo?: boolean;
  authIncludeDisabled?: boolean;
  /** Внешнее меню iiko (externalMenuId) для запроса /api/2/menu/by_id. */
  externalMenuId?: string;
  /** Организация по умолчанию (organizationId) для запроса /api/2/menu/by_id. */
  organizationId?: string;
  timeoutMs: number;
  syncEnabled: boolean;
  debugRawPayloads: boolean;
  logger: IikoLogger;
  now?: () => number;
  fetchImpl?: typeof fetch;
  /**
   * Опциональная реализация node:https.request для тестов.
   * В production используется реальный node:https.request.
   */
  httpsRequestImpl?: IikoHttpsRequestFn;
  /**
   * Принудительный транспорт для production-запросов меню.
   * По умолчанию 'fetch'. Если fetch возвращает HTML 5xx, executeMenuRequest
   * автоматически переключается на https_request в рамках того же вызова.
   * Это поле позволяет зафиксировать транспорт после диагностики.
   */
  menuTransport?: 'fetch' | 'https_request';
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

export interface IikoMenuRequestDiagnostics {
  finalUrl: string;
  method: 'POST';
  bodyKeys: ['externalMenuId', 'organizationIds'];
  externalMenuIdType: 'string';
  organizationIdsType: 'array';
  organizationIdsCount: number;
  tokenPresent: boolean;
  tokenLength: number;
  authorizationScheme: 'Bearer';
  outboundHeaderNames: string[];
  userAgent: string;
  contentType: 'application/json';
  upstreamStatus: number | null;
  upstreamContentType: string | null;
  correlationId: string | null;
  responseTextSha256: string | null;
  responseText: string | null;
  errorKind:
    | 'UPSTREAM_HTTP_ERROR'
    | 'NETWORK_ERROR'
    | 'TIMEOUT'
    | 'JSON_PARSE_ERROR'
    | null;
  durationMs: number;
}

/**
 * Результат одного транспорта (fetch или https.request) в transport-test.
 * Никогда не содержит токен, секреты или полное тело ответа.
 */
export interface IikoMenuTransportProbe {
  transport: 'fetch' | 'https_request';
  success: boolean;
  httpStatus: number | null;
  contentType: string | null;
  correlationId: string | null;
  responseTextSha256: string | null;
  responseTextPreview: string | null;
  errorKind: IikoMenuRequestDiagnostics['errorKind'];
  error: string | null;
  durationMs: number;
}

/**
 * Сравнительная диагностика двух транспортов для запроса меню iiko.
 * Сначала выполняется fetch; если fetch вернул HTML 5xx, выполняется
 * https.request с теми же URL, заголовками и телом.
 */
export interface IikoMenuTransportDiagnostics {
  finalUrl: string;
  method: 'POST';
  outboundHeaderNames: string[];
  userAgent: string;
  contentType: 'application/json';
  bodyKeys: ['externalMenuId', 'organizationIds'];
  externalMenuIdType: 'string';
  organizationIdsType: 'array';
  organizationIdsCount: number;
  tokenPresent: boolean;
  tokenLength: number;
  authorizationScheme: 'Bearer';
  fetch: IikoMenuTransportProbe;
  httpsRequest: IikoMenuTransportProbe | null;
  recommendedTransport: 'fetch' | 'https_request';
  durationMs: number;
}

interface TokenState {
  token: string;
  expiresAtMs: number;
}

/** Токен живёт только в памяти процесса; в PostgreSQL не сохраняется. */
const DEFAULT_TOKEN_TTL_MS = 55 * 60 * 1000;
const IIKO_MENU_BY_ID_URL = 'https://api-ru.iiko.services/api/2/menu/by_id';

export class IikoClient {
  private readonly options: Required<
    Pick<
      IikoClientOptions,
      'authBaseUrl' | 'menuBaseUrl' | 'timeoutMs' | 'syncEnabled' | 'debugRawPayloads'
    >
  > &
    IikoClientOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly httpsRequestFn: IikoHttpsRequestFn;
  private readonly menuTransport: 'fetch' | 'https_request';
  private readonly now: () => number;
  /** Корень API без версии: https://api-ru.iiko.services — для legacy v1 endpoints. */
  private readonly apiRoot: string;
  private readonly authUrl: string;
  private readonly menuUrl: string;
  private tokenState: TokenState | null = null;
  private inflightToken: Promise<string> | null = null;
  private lastMenuDiagnostics: IikoMenuRequestDiagnostics | null = null;

  constructor(options: IikoClientOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.httpsRequestFn = options.httpsRequestImpl ?? defaultHttpsRequest;
    this.menuTransport = options.menuTransport ?? 'fetch';
    this.now = options.now ?? (() => Date.now());
    // authBaseUrl = https://api-ru.iiko.services/api/v2  -> authUrl  = .../api/v2/access_token
    // menuBaseUrl = https://api-ru.iiko.services/api/2   -> menuUrl  = .../api/2/menu/by_id
    // apiRoot     = https://api-ru.iiko.services          (для legacy /api/1/organizations)
    const authBase = normalizeBase(options.authBaseUrl);
    this.apiRoot = stripApiVersion(authBase);
    this.authUrl = `${authBase}${normalizePath(options.authPath ?? '/access_token')}`;
    this.menuUrl = IIKO_MENU_BY_ID_URL;
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
    const apiKeyField = this.options.authApiKeyField ?? 'apiLogin';
    return {
      [apiKeyField]: this.options.apiKey,
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
      const token = optionalString(response.body.token);
      if (!token) {
        throw iikoAuthFailed({ reason: 'token_missing_or_empty_in_response' });
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

  async getExternalMenu(
    _organizationId: string,
    _externalMenuId?: string,
  ): Promise<unknown> {
    this.ensureConfigured();
    const authResponse = { token: await this.getAccessToken(true) };
    return (await this.executeMenuRequest(authResponse)).body;
  }

  async diagnoseMenuRequest(): Promise<IikoMenuRequestDiagnostics> {
    const startedAt = this.now();
    this.lastMenuDiagnostics = null;
    try {
      this.ensureConfigured();
      const authResponse = { token: await this.getAccessToken(true) };
      await this.executeMenuRequest(authResponse);
    } catch (error) {
      if (!this.lastMenuDiagnostics) {
        this.lastMenuDiagnostics = this.emptyMenuDiagnostics(
          this.classifyTransportError(error),
          this.sanitizeMenuText(errorMessageOf(error), ''),
          startedAt,
        );
      }
    }
    return (
      this.lastMenuDiagnostics ??
      this.emptyMenuDiagnostics(null, 'Запрос меню не выполнялся.', startedAt)
    );
  }

  private async executeMenuRequest(authResponse: {
    token: string;
  }): Promise<{ body: unknown; httpStatus: number }> {
    const startedAt = this.now();
    const accessToken = authResponse.token.trim().replace(/^Bearer\s+/i, '');
    const menuUrl = IIKO_MENU_BY_ID_URL;
    const menuBody = {
      externalMenuId: String(this.options.externalMenuId),
      organizationIds: [String(this.options.organizationId)],
    };
    const validationError = validateMenuRequest(accessToken, menuBody);
    if (validationError) {
      this.lastMenuDiagnostics = this.buildMenuDiagnostics(
        accessToken,
        menuBody,
        null,
        null,
        null,
        validationError,
        null,
        startedAt,
      );
      throw iikoMenuRequestFailed({ safeUpstreamError: validationError });
    }

    const headers = buildPostmanMenuHeaders(accessToken);
    const serializedBody = JSON.stringify(menuBody);

    // Шаг 1: основной транспорт (fetch по умолчанию, https_request если зафиксировано).
    let fetchResult: IikoTransportOutcome | null = null;
    let httpsResult: IikoTransportOutcome | null = null;

    if (this.menuTransport === 'https_request') {
      httpsResult = await this.runHttpsMenuTransport(menuUrl, headers, serializedBody, accessToken, menuBody, startedAt);
    } else {
      fetchResult = await this.runFetchMenuTransport(menuUrl, headers, serializedBody, accessToken, menuBody, startedAt);
    }

    // Шаг 2: если fetch вернул HTML 5xx — пробуем https.request как fallback.
    if (
      fetchResult &&
      fetchResult.kind === 'http' &&
      isHtmlServerError(fetchResult.status, fetchResult.text)
    ) {
      httpsResult = await this.runHttpsMenuTransport(menuUrl, headers, serializedBody, accessToken, menuBody, startedAt);
    }

    const primary = httpsResult ?? fetchResult;
    if (!primary) {
      // Не должно происходить, но защищаем типами.
      throw iikoMenuRequestFailed({ safeUpstreamError: 'Транспорт меню не выполнен.' });
    }

    if (primary.kind === 'network') {
      const errorKind = primary.errorKind;
      const safeMessage = primary.safeMessage;
      this.lastMenuDiagnostics = this.buildMenuDiagnostics(
        accessToken,
        menuBody,
        null,
        null,
        null,
        safeMessage,
        null,
        startedAt,
        errorKind,
      );
      await this.recordMenuFailure(
        errorKind === 'TIMEOUT' ? 'TIMEOUT' : 'NETWORK_ERROR',
        safeMessage,
        startedAt,
      );
      if (errorKind === 'TIMEOUT') throw iikoMenuTimeout(safeMessage);
      throw iikoMenuNetworkError(safeMessage);
    }

    const status = primary.status;
    const text = primary.text;
    const upstreamContentType = primary.contentType;
    const diagnosticJson = safeJsonParse(text);
    const correlationId = optionalString(asRecord(diagnosticJson)?.correlationId) ?? null;
    const safeResponseText = this.sanitizeMenuText(text, accessToken).slice(0, 1000);

    if (status < 200 || status >= 300) {
      this.lastMenuDiagnostics = this.buildMenuDiagnostics(
        accessToken,
        menuBody,
        status,
        upstreamContentType,
        correlationId,
        safeResponseText,
        text,
        startedAt,
        'UPSTREAM_HTTP_ERROR',
      );
      await this.recordMenuFailure(`HTTP_${status}`, safeResponseText, startedAt, status, correlationId);
      throw iikoMenuRequestFailed({
        upstreamStatus: status,
        correlationId,
        safeUpstreamError: safeResponseText || `HTTP ${status}`,
      });
    }

    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      const safeMessage = 'iiko вернул HTTP 2xx, но тело полного меню не является JSON.';
      this.lastMenuDiagnostics = this.buildMenuDiagnostics(
        accessToken,
        menuBody,
        status,
        upstreamContentType,
        correlationId,
        safeResponseText,
        text,
        startedAt,
        'JSON_PARSE_ERROR',
      );
      await this.recordMenuFailure('JSON_PARSE_ERROR', safeMessage, startedAt, status, correlationId);
      throw iikoMenuJsonParseFailed({
        upstreamStatus: status,
        correlationId,
        safeMessage,
      });
    }

    this.lastMenuDiagnostics = this.buildMenuDiagnostics(
      accessToken,
      menuBody,
      status,
      upstreamContentType,
      correlationId,
      safeResponseText,
      text,
      startedAt,
      null,
    );
    await this.record({
      operation: 'menu_by_id',
      status: 'SUCCESS',
      httpStatus: status,
      durationMs: this.now() - startedAt,
      requestReference: menuUrl,
      organizationId: menuBody.organizationIds[0],
      responseMetadata: { correlationId, size: text.length },
    });
    return { body, httpStatus: status };
  }

  /**
   * Сравнительная диагностика транспортов fetch vs https.request.
   * Сначала выполняется fetch; если fetch вернул HTML 5xx, выполняется
   * https.request с теми же URL, заголовками и телом. Возвращает безопасные
   * fingerprints обоих транспортов без токена, секретов или полного тела.
   */
  async diagnoseMenuTransport(): Promise<IikoMenuTransportDiagnostics> {
    const startedAt = this.now();
    this.ensureConfigured();
    const accessToken = (await this.getAccessToken(true)).trim().replace(/^Bearer\s+/i, '');
    const menuBody = {
      externalMenuId: String(this.options.externalMenuId),
      organizationIds: [String(this.options.organizationId)],
    };
    const headers = buildPostmanMenuHeaders(accessToken);
    const serializedBody = JSON.stringify(menuBody);

    const fetchProbe = await this.probeFetchTransport(IIKO_MENU_BY_ID_URL, headers, serializedBody, accessToken);
    let httpsProbe: IikoMenuTransportProbe | null = null;
    if (isHtmlServerErrorProbe(fetchProbe)) {
      httpsProbe = await this.probeHttpsTransport(IIKO_MENU_BY_ID_URL, headers, serializedBody, accessToken);
    }

    const recommendedTransport: 'fetch' | 'https_request' =
      httpsProbe && httpsProbe.success && !fetchProbe.success
        ? 'https_request'
        : fetchProbe.success
          ? 'fetch'
          : httpsProbe && httpsProbe.success
            ? 'https_request'
            : 'fetch';

    return {
      finalUrl: IIKO_MENU_BY_ID_URL,
      method: 'POST',
      outboundHeaderNames: Object.keys(headers),
      userAgent: POSTMAN_USER_AGENT,
      contentType: 'application/json',
      bodyKeys: ['externalMenuId', 'organizationIds'],
      externalMenuIdType: 'string',
      organizationIdsType: 'array',
      organizationIdsCount: menuBody.organizationIds.length,
      tokenPresent: accessToken.length > 0,
      tokenLength: accessToken.length,
      authorizationScheme: 'Bearer',
      fetch: fetchProbe,
      httpsRequest: httpsProbe,
      recommendedTransport,
      durationMs: this.now() - startedAt,
    };
  }

  private async runFetchMenuTransport(
    url: string,
    headers: Record<string, string>,
    serializedBody: string,
    accessToken: string,
    menuBody: { externalMenuId: string; organizationIds: string[] },
    startedAt: number,
  ): Promise<IikoTransportOutcome> {
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: serializedBody,
      });
      const text = await response.text();
      return {
        kind: 'http',
        status: response.status,
        contentType: response.headers.get('content-type'),
        text,
      };
    } catch (error) {
      const errorKind = this.classifyTransportError(error);
      const safeMessage = this.sanitizeMenuText(errorMessageOf(error), accessToken);
      this.lastMenuDiagnostics = this.buildMenuDiagnostics(
        accessToken,
        menuBody,
        null,
        null,
        null,
        safeMessage,
        null,
        startedAt,
        errorKind,
      );
      return { kind: 'network', errorKind, safeMessage };
    }
  }

  private async runHttpsMenuTransport(
    url: string,
    headers: Record<string, string>,
    serializedBody: string,
    accessToken: string,
    menuBody: { externalMenuId: string; organizationIds: string[] },
    startedAt: number,
  ): Promise<IikoTransportOutcome> {
    try {
      const result = await this.httpsRequestFn(url, headers, serializedBody, this.options.timeoutMs);
      const contentType = pickHeader(result.headers, 'content-type');
      return {
        kind: 'http',
        status: result.status,
        contentType,
        text: result.body,
      };
    } catch (error) {
      const errorKind = this.classifyTransportError(error);
      const safeMessage = this.sanitizeMenuText(errorMessageOf(error), accessToken);
      this.lastMenuDiagnostics = this.buildMenuDiagnostics(
        accessToken,
        menuBody,
        null,
        null,
        null,
        safeMessage,
        null,
        startedAt,
        errorKind,
      );
      return { kind: 'network', errorKind, safeMessage };
    }
  }

  private async probeFetchTransport(
    url: string,
    headers: Record<string, string>,
    serializedBody: string,
    accessToken: string,
  ): Promise<IikoMenuTransportProbe> {
    const startedAt = this.now();
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: serializedBody,
      });
      const text = await response.text();
      const contentType = response.headers.get('content-type');
      const correlationId = extractCorrelationId(text);
      return {
        transport: 'fetch',
        success: response.ok && !isHtmlBody(text),
        httpStatus: response.status,
        contentType,
        correlationId,
        responseTextSha256: sha256Hex(text),
        responseTextPreview: this.sanitizeMenuText(text, accessToken).slice(0, 300),
        errorKind: null,
        error: null,
        durationMs: this.now() - startedAt,
      };
    } catch (error) {
      const errorKind = this.classifyTransportError(error);
      return {
        transport: 'fetch',
        success: false,
        httpStatus: null,
        contentType: null,
        correlationId: null,
        responseTextSha256: null,
        responseTextPreview: null,
        errorKind,
        error: this.sanitizeMenuText(errorMessageOf(error), accessToken).slice(0, 300),
        durationMs: this.now() - startedAt,
      };
    }
  }

  private async probeHttpsTransport(
    url: string,
    headers: Record<string, string>,
    serializedBody: string,
    accessToken: string,
  ): Promise<IikoMenuTransportProbe> {
    const startedAt = this.now();
    try {
      const result = await this.httpsRequestFn(url, headers, serializedBody, this.options.timeoutMs);
      const contentType = pickHeader(result.headers, 'content-type');
      const text = result.body;
      const correlationId = extractCorrelationId(text);
      const ok = result.status >= 200 && result.status < 300 && !isHtmlBody(text);
      return {
        transport: 'https_request',
        success: ok,
        httpStatus: result.status,
        contentType,
        correlationId,
        responseTextSha256: sha256Hex(text),
        responseTextPreview: this.sanitizeMenuText(text, accessToken).slice(0, 300),
        errorKind: null,
        error: null,
        durationMs: this.now() - startedAt,
      };
    } catch (error) {
      const errorKind = this.classifyTransportError(error);
      return {
        transport: 'https_request',
        success: false,
        httpStatus: null,
        contentType: null,
        correlationId: null,
        responseTextSha256: null,
        responseTextPreview: null,
        errorKind,
        error: this.sanitizeMenuText(errorMessageOf(error), accessToken).slice(0, 300),
        durationMs: this.now() - startedAt,
      };
    }
  }

  private async recordMenuFailure(
    errorCode: string,
    errorMessage: string,
    startedAt: number,
    httpStatus?: number,
    correlationId?: string | null,
  ): Promise<void> {
    await this.record({
      operation: 'menu_by_id',
      status: 'FAILED',
      httpStatus,
      durationMs: this.now() - startedAt,
      requestReference: IIKO_MENU_BY_ID_URL,
      organizationId: this.options.organizationId,
      responseMetadata: correlationId ? { correlationId } : undefined,
      errorCode,
      errorMessage,
    });
  }

  private classifyTransportError(error: unknown): 'NETWORK_ERROR' | 'TIMEOUT' {
    return isTimeoutLike(error) ? 'TIMEOUT' : 'NETWORK_ERROR';
  }

  private sanitizeMenuText(text: string, accessToken: string): string {
    let safe = sanitizeMessage(text);
    for (const value of [
      accessToken,
      this.options.apiKey,
      this.options.appId,
      this.options.clientSecret,
    ]) {
      if (value && value.length >= 6) safe = safe.replaceAll(value, '[REDACTED]');
    }
    return safe;
  }

  private buildMenuDiagnostics(
    accessToken: string,
    menuBody: { externalMenuId: string; organizationIds: string[] },
    upstreamStatus: number | null,
    upstreamContentType: string | null,
    correlationId: string | null,
    responseText: string | null,
    rawResponseText: string | null,
    startedAt: number,
    errorKind: IikoMenuRequestDiagnostics['errorKind'] = null,
  ): IikoMenuRequestDiagnostics {
    return {
      finalUrl: IIKO_MENU_BY_ID_URL,
      method: 'POST',
      bodyKeys: ['externalMenuId', 'organizationIds'],
      externalMenuIdType: 'string',
      organizationIdsType: 'array',
      organizationIdsCount: menuBody.organizationIds.length,
      tokenPresent: accessToken.length > 0,
      tokenLength: accessToken.length,
      authorizationScheme: 'Bearer',
      outboundHeaderNames: [...POSTMAN_HEADER_NAMES],
      userAgent: POSTMAN_USER_AGENT,
      contentType: 'application/json',
      upstreamStatus,
      upstreamContentType,
      correlationId,
      responseTextSha256: rawResponseText ? sha256Hex(rawResponseText) : null,
      responseText,
      errorKind,
      durationMs: this.now() - startedAt,
    };
  }

  private emptyMenuDiagnostics(
    errorKind: IikoMenuRequestDiagnostics['errorKind'],
    responseText: string,
    startedAt: number,
  ): IikoMenuRequestDiagnostics {
    return this.buildMenuDiagnostics(
      '',
      {
        externalMenuId: String(this.options.externalMenuId),
        organizationIds: [String(this.options.organizationId)],
      },
      null,
      null,
      null,
      responseText.slice(0, 1000),
      null,
      startedAt,
      errorKind,
    );
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
   *   реальный POST к /api/2/menu/by_id с Bearer-токеном из стадии auth.
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

  /** Стадия menu: POST /api/2/menu/by_id с одним Bearer prefix. */
  private async runMenuDiagnosisStage(token: string): Promise<IikoStageDiagnostics> {
    const startedAt = this.now();
    try {
      const result = await this.executeMenuRequest({ token });
      const diagnostics = this.lastMenuDiagnostics;
      return {
        finalUrl: this.menuUrl,
        method: 'POST',
        httpStatus: result.httpStatus,
        correlationId: diagnostics?.correlationId ?? null,
        error: null,
        durationMs: this.now() - startedAt,
        success: true,
      };
    } catch {
      const diagnostics = this.lastMenuDiagnostics;
      return {
        finalUrl: this.menuUrl,
        method: 'POST',
        httpStatus: diagnostics?.upstreamStatus ?? null,
        correlationId: diagnostics?.correlationId ?? null,
        error: diagnostics?.responseText ?? 'Ошибка запроса меню.',
        durationMs: this.now() - startedAt,
        success: false,
      };
    }
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
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function validateMenuRequest(
  accessToken: string,
  body: { externalMenuId: string; organizationIds: string[] },
): string | null {
  if (accessToken.length === 0) return 'Токен авторизации iiko отсутствует.';
  if (
    typeof body.externalMenuId !== 'string' ||
    body.externalMenuId.trim().length === 0 ||
    body.externalMenuId === 'undefined'
  ) {
    return 'IIKO_EXTERNAL_MENU_ID должен быть непустой строкой.';
  }
  if (!Array.isArray(body.organizationIds)) return 'organizationIds должен быть массивом.';
  if (body.organizationIds.length !== 1) {
    return 'organizationIds должен содержать ровно одну организацию.';
  }
  if (!isUuid(body.organizationIds[0] ?? '')) {
    return 'IIKO_ORGANIZATION_ID должен быть UUID.';
  }
  return null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
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

function isTimeoutLike(error: unknown): boolean {
  if (isAbortError(error)) return true;
  if (error instanceof Error && (error.name === 'TimeoutError' || /timeout|timed out/i.test(error.message))) {
    return true;
  }
  if (error && typeof error === 'object') {
    const record = error as { code?: unknown; cause?: unknown };
    if (
      typeof record.code === 'string' &&
      ['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(
        record.code,
      )
    ) {
      return true;
    }
    if (record.cause && record.cause !== error) return isTimeoutLike(record.cause);
  }
  return false;
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Postman-equivalent request profile for POST /api/2/menu/by_id
// ---------------------------------------------------------------------------

const POSTMAN_USER_AGENT = 'PostmanRuntime/7.43.0';
const POSTMAN_ACCEPT = '*/*';
const POSTMAN_ACCEPT_LANGUAGE = 'en-US,en;q=0.9';
const POSTMAN_CONNECTION = 'keep-alive';

/**
 * Имена заголовков в порядке Postman. Используется только для diagnostics
 * (имена, не значения). Никогда не включает Content-Length, Host,
 * Transfer-Encoding, Accept-Encoding — их устанавливает сам транспорт.
 */
const POSTMAN_HEADER_NAMES = [
  'Authorization',
  'Content-Type',
  'Accept',
  'Accept-Language',
  'User-Agent',
  'Connection',
] as const;

/**
 * Строит заголовки, эквивалентные профилю Postman для /api/2/menu/by_id.
 * Не включает Content-Length, Host, Transfer-Encoding, Accept-Encoding —
 * их устанавливает транспорт (fetch/undici или node:https).
 */
function buildPostmanMenuHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    Accept: POSTMAN_ACCEPT,
    'Accept-Language': POSTMAN_ACCEPT_LANGUAGE,
    'User-Agent': POSTMAN_USER_AGENT,
    Connection: POSTMAN_CONNECTION,
  };
}

/** Возвращает SHA-256 hex от текста ответа (для diagnostics fingerprint). */
function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Извлекает correlationId из JSON-тела ответа (если оно JSON). */
function extractCorrelationId(text: string): string | null {
  const parsed = safeJsonParse(text);
  return optionalString(asRecord(parsed)?.correlationId) ?? null;
}

/** Возвращает значение заголовка (последнее, если массив) в нижнем регистре ключа. */
function pickHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      if (Array.isArray(value)) return value[value.length - 1] ?? null;
      return value ?? null;
    }
  }
  return null;
}

/** Детектит HTML Symfony error page (или любой HTML-ответ). */
function isHtmlBody(text: string): boolean {
  const head = text.slice(0, 600).toLowerCase();
  return head.includes('<!doctype html') || head.includes('<html');
}

/** Детектит HTML 5xx — сценарий, при котором fetch получает Symfony error page. */
function isHtmlServerError(status: number, text: string): boolean {
  return status >= 500 && isHtmlBody(text);
}

/** Детектит HTML 5xx по probe-результату транспорта. */
function isHtmlServerErrorProbe(probe: IikoMenuTransportProbe): boolean {
  return (
    !probe.success &&
    probe.httpStatus !== null &&
    probe.httpStatus >= 500 &&
    probe.responseTextPreview !== null &&
    isHtmlBody(probe.responseTextPreview)
  );
}

/**
 * Внутренний результат одного транспортного вызова меню.
 * - kind: 'http' — получили HTTP-ответ (любой статус).
 * - kind: 'network' — сетевая ошибка или timeout.
 */
type IikoTransportOutcome =
  | { kind: 'http'; status: number; contentType: string | null; text: string }
  | { kind: 'network'; errorKind: 'NETWORK_ERROR' | 'TIMEOUT'; safeMessage: string };

/**
 * Production-реализация node:https.request для POST JSON-запроса.
 * Не выполняет retry. Сохраняет TLS-верификацию (rejectUnauthorized по умолчанию true).
 * Не использует insecure TLS-настройки.
 */
function defaultHttpsRequest(
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<IikoHttpsRequestResult> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (error) {
      reject(error);
      return;
    }
    const options: RequestOptions = {
      method: 'POST',
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: `${parsed.pathname}${parsed.search}`,
      headers,
    };
    const req = httpsRequest(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const headers: Record<string, string | string[] | undefined> = {};
        // node: IncomingHttpHeaders использует lowercase ключи.
        for (const [key, value] of Object.entries(res.headers)) {
          if (value !== undefined) headers[key] = value;
        }
        resolve({ status: res.statusCode ?? 0, headers, body });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => {
      req.destroy(new Error('https.request timed out'));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs);
    req.write(body);
    req.end();
  });
}
