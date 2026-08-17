import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/lib/errors.js';
import { IikoClient, type IikoAttemptRecord } from '../src/services/iiko-client.service.js';

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface ClientSetup {
  fetchMock: ReturnType<typeof vi.fn>;
  attempts: IikoAttemptRecord[];
  client: IikoClient;
}

function createClient(
  responses: Array<Response | Error>,
  overrides: {
    syncEnabled?: boolean;
    apiKey?: string;
    appId?: string;
    clientSecret?: string;
    authPath?: string;
    menuPath?: string;
    authBaseUrl?: string;
    menuBaseUrl?: string;
    externalMenuId?: string;
    organizationId?: string;
  } = {},
): ClientSetup {
  const queue = [...responses];
  const fetchMock = vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error('неожиданный дополнительный запрос к iiko');
    if (next instanceof Error) throw next;
    return next;
  });
  const attempts: IikoAttemptRecord[] = [];

  const client = new IikoClient({
    authBaseUrl: overrides.authBaseUrl ?? 'https://api-ru.iiko.services/api/v2',
    menuBaseUrl: overrides.menuBaseUrl ?? 'https://api-ru.iiko.services/api/2',
    apiKey: 'apiKey' in overrides ? overrides.apiKey : 'test-api-login',
    appId: 'appId' in overrides ? overrides.appId : 'test-app-id',
    clientSecret:
      'clientSecret' in overrides ? overrides.clientSecret : 'test-client-secret',
    authPath: overrides.authPath,
    menuPath: overrides.menuPath,
    externalMenuId: 'externalMenuId' in overrides ? overrides.externalMenuId : '88042',
    organizationId:
      'organizationId' in overrides
        ? overrides.organizationId
        : 'cc9baa8d-cfac-4092-9c97-477746fe84e2',
    timeoutMs: 1000,
    syncEnabled: overrides.syncEnabled ?? true,
    debugRawPayloads: false,
    logger,
    fetchImpl: fetchMock as unknown as typeof fetch,
    onAttempt: (attempt) => {
      attempts.push(attempt);
    },
    maxRetries: 2,
    retryDelayMs: 0,
  });

  return { fetchMock, attempts, client };
}

const ORG_ID = 'cc9baa8d-cfac-4092-9c97-477746fe84e2';

describe('IikoClient endpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('не работает без ключа: IIKO_NOT_CONFIGURED', async () => {
    const { client } = createClient([], { apiKey: undefined });
    expect(client.isConfigured).toBe(false);
    await expect(client.getAccessToken()).rejects.toMatchObject({ code: 'IIKO_NOT_CONFIGURED' });
  });

  it('не работает при выключенной синхронизации', async () => {
    const { client } = createClient([], { syncEnabled: false });
    expect(client.isConfigured).toBe(false);
    await expect(client.getOrganizations()).rejects.toBeInstanceOf(AppError);
  });

  it('получает токен и кэширует его в памяти', async () => {
    const { client, fetchMock } = createClient([
      jsonResponse({ token: 'session-key-1' }),
      jsonResponse({ organizations: [{ id: 'org-1', name: 'Bar' }] }),
      jsonResponse({ organizations: [{ id: 'org-1', name: 'Bar' }] }),
    ]);

    const token = await client.getAccessToken();
    expect(token).toBe('session-key-1');

    await client.getOrganizations();
    await client.getOrganizations();

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('передаёт Bearer-токен и не логирует apiKey', async () => {
    const { client, fetchMock, attempts } = createClient([
      jsonResponse({ token: 'session-key-1' }),
      jsonResponse({ organizations: [] }),
    ]);
    await client.getOrganizations();

    const init = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer session-key-1');
    expect(JSON.stringify(attempts)).not.toContain('test-api-login');
    expect(JSON.stringify(attempts)).not.toContain('test-app-id');
    expect(JSON.stringify(attempts)).not.toContain('test-client-secret');
    expect(JSON.stringify(attempts)).not.toContain('session-key-1');
  });

  it('нормализует организации и отбрасывает записи без id', async () => {
    const { client } = createClient([
      jsonResponse({ token: 't' }),
      jsonResponse({
        organizations: [{ id: 'org-1' }, { name: 'без id' }, { id: 'org-2', name: 'Bar 2' }],
      }),
    ]);
    const organizations = await client.getOrganizations();
    expect(organizations.map((item) => item.id)).toEqual(['org-1', 'org-2']);
    expect(organizations[0]?.name).toBe('Без названия');
  });

  it('повторяет запрос при сетевой ошибке', async () => {
    const { client, fetchMock } = createClient([
      jsonResponse({ token: 't' }),
      new Error('ECONNRESET'),
      jsonResponse({ organizations: [] }),
    ]);
    await expect(client.getOrganizations()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('повторяет запрос при 500 и не повторяет при 400', async () => {
    const transient = createClient([
      jsonResponse({ token: 't' }),
      jsonResponse({ errorDescription: 'server error' }, 500),
      jsonResponse({ organizations: [] }),
    ]);
    await expect(transient.client.getOrganizations()).resolves.toEqual([]);
    expect(transient.fetchMock).toHaveBeenCalledTimes(3);

    const permanent = createClient([
      jsonResponse({ token: 't' }),
      jsonResponse({ errorDescription: 'bad request' }, 400),
    ]);
    await expect(permanent.client.getOrganizations()).rejects.toMatchObject({
      code: 'IIKO_REQUEST_FAILED',
    });
    expect(permanent.fetchMock).toHaveBeenCalledTimes(2);
  });

  it('обновляет токен один раз при 401', async () => {
    const { client, fetchMock } = createClient([
      jsonResponse({ token: 'old' }),
      jsonResponse({ errorDescription: 'unauthorized' }, 401),
      jsonResponse({ token: 'new' }),
      jsonResponse({ organizations: [{ id: 'org-1', name: 'Bar' }] }),
    ]);

    const organizations = await client.getOrganizations();
    expect(organizations).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('сообщает IIKO_AUTH_FAILED при отсутствии токена в ответе', async () => {
    const { client } = createClient([jsonResponse({})]);
    await expect(client.getAccessToken()).rejects.toMatchObject({ code: 'IIKO_AUTH_FAILED' });
  });

  it('фиксирует попытки синхронизации без секретов', async () => {
    const { client, attempts } = createClient([
      jsonResponse({ token: 't' }),
      jsonResponse({ organizations: [] }),
    ]);
    await client.getOrganizations();

    expect(attempts.map((attempt) => attempt.operation)).toEqual(['access_token', 'organizations']);
    expect(attempts.every((attempt) => attempt.status === 'SUCCESS')).toBe(true);
  });

  it('использует только read-only пути: auth /api/v2/access_token, menu /api/2/menu/by_id, organizations /api/1/organizations', async () => {
    const { client, fetchMock } = createClient([
      jsonResponse({ token: 't' }),
      jsonResponse({ organizations: [] }),
      jsonResponse({ token: 'fresh-t' }),
      jsonResponse({ itemCategories: [] }),
    ]);

    await client.getOrganizations();
    await client.getExternalMenu(ORG_ID);

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls).toEqual([
      'https://api-ru.iiko.services/api/v2/access_token',
      'https://api-ru.iiko.services/api/1/organizations',
      'https://api-ru.iiko.services/api/v2/access_token',
      'https://api-ru.iiko.services/api/2/menu/by_id',
    ]);
    expect(urls.some((url) => /order|price|command/i.test(url))).toBe(false);
    // /api/v2/menu и /api/1/nomenclature не должны использоваться для полной синхронизации.
    expect(urls.some((url) => url.includes('/api/v2/menu'))).toBe(false);
    expect(urls.some((url) => url.includes('/api/1/nomenclature'))).toBe(false);
  });

  it('отправляет тело авторизации с apiLogin/appId/clientSecret и boolean-флагами', async () => {
    const { client, fetchMock } = createClient([jsonResponse({ token: 't' })]);
    await client.getAccessToken();

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.apiLogin).toBe('test-api-login');
    expect(body.appId).toBe('test-app-id');
    expect(body.clientSecret).toBe('test-client-secret');
    expect(body.returnAdditionalInfo).toBe(false);
    expect(body.includeDisabled).toBe(false);
    expect(body.apiKey).toBeUndefined();
    expect(body.organizationId).toBeUndefined();
    expect(body.organizationIds).toBeUndefined();
    expect(typeof body.returnAdditionalInfo).toBe('boolean');
    expect(typeof body.includeDisabled).toBe('boolean');
  });

  it('строит корректный URL авторизации: /api/v2/access_token', async () => {
    const { client, fetchMock } = createClient([jsonResponse({ token: 't' })]);
    await client.getAccessToken();
    const authUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(authUrl).toBe('https://api-ru.iiko.services/api/v2/access_token');
    expect(authUrl).not.toContain('/api/1');
  });

  it('использует IIKO_AUTH_PATH для построения URL авторизации', async () => {
    const { client, fetchMock } = createClient([jsonResponse({ token: 't' })], {
      authPath: '/access_token',
    });
    await client.getAccessToken();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://api-ru.iiko.services/api/v2/access_token',
    );
  });

  it('строит корректный URL меню: /api/2/menu/by_id (НЕ /api/v2/menu и НЕ /api/1/nomenclature)', async () => {
    const { client, fetchMock } = createClient([
      jsonResponse({ token: 't' }),
      jsonResponse({ itemCategories: [] }),
    ]);
    await client.getExternalMenu(ORG_ID);
    const menuUrl = String(fetchMock.mock.calls[1]?.[0]);
    expect(menuUrl).toBe('https://api-ru.iiko.services/api/2/menu/by_id');
    expect(menuUrl).not.toContain('/api/v2/menu');
    expect(menuUrl).not.toContain('/api/1/nomenclature');
  });

  it('isConfigured требует apiLogin, appId и clientSecret', async () => {
    const onlyLogin = createClient([], { appId: undefined, clientSecret: undefined });
    expect(onlyLogin.client.isConfigured).toBe(false);

    const onlyLoginAndApp = createClient([], { clientSecret: undefined });
    expect(onlyLoginAndApp.client.isConfigured).toBe(false);

    const all = createClient([]);
    expect(all.client.isConfigured).toBe(true);
  });

  it('getExternalMenu создаёт запрос, семантически идентичный Postman, без duplicate Bearer', async () => {
    const { client, fetchMock } = createClient([
      // Даже если upstream token ошибочно уже содержит scheme, финальный header содержит ровно один Bearer.
      jsonResponse({ token: 'Bearer t' }),
      jsonResponse({ itemCategories: [], correlationId: 'menu-correlation' }),
    ]);
    await client.getExternalMenu(ORG_ID);

    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      'https://api-ru.iiko.services/api/2/menu/by_id',
    );
    const init = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      externalMenuId: '88042',
      organizationIds: [ORG_ID],
    });
    expect(init.headers).toEqual({
      Authorization: 'Bearer t',
      'Content-Type': 'application/json',
      Accept: 'application/json',
    });
    expect(String((init.headers as Record<string, string>).Authorization).match(/Bearer/g)).toHaveLength(
      1,
    );
  });

  it('getExternalMenu валидирует непустой externalMenuId до menu fetch', async () => {
    const { client, fetchMock } = createClient([jsonResponse({ token: 't' })], {
      externalMenuId: undefined,
    });
    await expect(client.getExternalMenu(ORG_ID)).rejects.toMatchObject({
      code: 'IIKO_MENU_REQUEST_FAILED',
      details: { safeUpstreamError: 'IIKO_EXTERNAL_MENU_ID должен быть непустой строкой.' },
    });
    // Выполнен только свежий auth; menu fetch не отправлен.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('diagnoseAuth: две стадии auth+menu, без токена и секретов', async () => {
    const { client, fetchMock } = createClient([
      jsonResponse({ token: 'session-key', correlationId: 'corr-auth' }, 200),
      jsonResponse({ token: 'session-key', correlationId: 'corr-auth-2' }, 200),
      jsonResponse({ itemCategories: [], correlationId: 'corr-menu' }, 200),
    ]);
    const diag = await client.diagnoseAuth();

    expect(diag.apiLoginConfigured).toBe(true);
    expect(diag.appIdConfigured).toBe(true);
    expect(diag.clientSecretConfigured).toBe(true);
    expect(diag.externalMenuIdConfigured).toBe(true);
    expect(diag.organizationIdConfigured).toBe(true);

    expect(diag.auth.finalUrl).toBe('https://api-ru.iiko.services/api/v2/access_token');
    expect(diag.auth.method).toBe('POST');
    expect(diag.auth.httpStatus).toBe(200);
    expect(diag.auth.correlationId).toBe('corr-auth');
    expect(diag.auth.success).toBe(true);
    expect(diag.auth.error).toBeNull();

    expect(diag.menu).not.toBeNull();
    expect(diag.menu?.finalUrl).toBe('https://api-ru.iiko.services/api/2/menu/by_id');
    expect(diag.menu?.httpStatus).toBe(200);
    expect(diag.menu?.correlationId).toBe('corr-menu');
    expect(diag.menu?.success).toBe(true);

    const serialized = JSON.stringify(diag);
    expect(serialized).not.toContain('session-key');
    expect(serialized).not.toContain('test-api-login');
    expect(serialized).not.toContain('test-app-id');
    expect(serialized).not.toContain('test-client-secret');

    const menuInit = fetchMock.mock.calls[2]?.[1] as RequestInit;
    const menuHeaders = menuInit.headers as Record<string, string>;
    expect(menuHeaders.Authorization).toBe('Bearer session-key');
  });

  it('diagnoseAuth: menu стадия не выполняется при провале auth', async () => {
    const { client } = createClient([
      jsonResponse(
        { errorDescription: 'Invalid credentials', correlationId: 'corr-err-1' },
        401,
      ),
    ]);
    const diag = await client.diagnoseAuth();

    expect(diag.auth.httpStatus).toBe(401);
    expect(diag.auth.correlationId).toBe('corr-err-1');
    expect(diag.auth.success).toBe(false);
    expect(diag.auth.error).toContain('Invalid credentials');
    expect(diag.menu).toBeNull();
  });

  it('diagnoseAuth: ошибка меню не маскируется под IIKO_AUTH_FAILED', async () => {
    const { client } = createClient([
      jsonResponse({ token: 'session-key' }, 200),
      jsonResponse({ token: 'session-key' }, 200),
      jsonResponse({ errorDescription: 'Menu not found', correlationId: 'corr-menu-err' }, 404),
    ]);
    const diag = await client.diagnoseAuth();

    expect(diag.auth.success).toBe(true);
    expect(diag.menu).not.toBeNull();
    expect(diag.menu?.httpStatus).toBe(404);
    expect(diag.menu?.success).toBe(false);
    expect(diag.menu?.error).toContain('Menu not found');
    expect(diag.menu?.correlationId).toBe('corr-menu-err');
    expect(diag.auth.error).toBeNull();
  });

  it('diagnoseAuth: menu не запрашивается без externalMenuId/organizationId', async () => {
    const { client, fetchMock } = createClient(
      [jsonResponse({ token: 'session-key' }, 200)],
      { externalMenuId: undefined, organizationId: undefined },
    );
    const diag = await client.diagnoseAuth();

    expect(diag.auth.success).toBe(true);
    expect(diag.externalMenuIdConfigured).toBe(false);
    expect(diag.organizationIdConfigured).toBe(false);
    expect(diag.menu).not.toBeNull();
    expect(diag.menu?.success).toBe(false);
    expect(diag.menu?.httpStatus).toBeNull();
    expect(diag.menu?.error).toMatch(/IIKO_EXTERNAL_MENU_ID/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('diagnoseAuth сообщает о незавершённых учётных данных без запроса', async () => {
    const { client, fetchMock } = createClient([], { appId: undefined });
    const diag = await client.diagnoseAuth();

    expect(diag.appIdConfigured).toBe(false);
    expect(diag.auth.httpStatus).toBeNull();
    expect(diag.auth.error).toMatch(/настроены/);
    expect(diag.auth.success).toBe(false);
    expect(diag.menu).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('диагностика никогда не содержит токен или секреты', async () => {
    const { client } = createClient([
      jsonResponse({ token: 'session-key', correlationId: 'c1' }, 200),
      jsonResponse({ token: 'session-key', correlationId: 'c2' }, 200),
      jsonResponse({ itemCategories: [], correlationId: 'c3' }, 200),
    ]);
    const diag = await client.diagnoseAuth();
    const serialized = JSON.stringify(diag);
    expect(serialized).not.toContain('session-key');
    expect(serialized).not.toContain('test-api-login');
    expect(serialized).not.toContain('test-client-secret');
    expect(serialized).not.toContain('Bearer session-key');
  });

  it('menu-request diagnostics возвращает только безопасные fingerprints', async () => {
    const { client } = createClient([
      jsonResponse({ token: 'Bearer session-key', correlationId: 'auth-corr' }),
      jsonResponse({ itemCategories: [], correlationId: 'menu-corr' }),
    ]);
    const diagnostics = await client.diagnoseMenuRequest();

    expect(diagnostics).toMatchObject({
      finalUrl: 'https://api-ru.iiko.services/api/2/menu/by_id',
      method: 'POST',
      authorizationScheme: 'Bearer',
      accessTokenPresent: true,
      accessTokenLength: 'session-key'.length,
      externalMenuIdPresent: true,
      externalMenuIdType: 'string',
      organizationIdsType: 'array',
      organizationIdsCount: 1,
      firstOrganizationIdLooksLikeUuid: true,
      headersPresent: ['authorization', 'content-type', 'accept'],
      lastUpstreamStatus: 200,
      lastCorrelationId: 'menu-corr',
      safeUpstreamError: null,
    });
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain('session-key');
    expect(serialized).not.toContain('test-api-login');
    expect(serialized).not.toContain('test-client-secret');
  });

  it('menu failure сохраняет upstream status, correlationId и безопасную ошибку', async () => {
    const { client } = createClient([
      jsonResponse({ token: 't' }),
      jsonResponse(
        { errorDescription: 'External menu rejected', correlationId: 'failure-corr' },
        400,
      ),
    ]);

    await expect(client.getExternalMenu(ORG_ID)).rejects.toMatchObject({
      code: 'IIKO_MENU_REQUEST_FAILED',
      details: {
        upstreamStatus: 400,
        correlationId: 'failure-corr',
        safeUpstreamError: 'External menu rejected',
      },
    });
  });
});
