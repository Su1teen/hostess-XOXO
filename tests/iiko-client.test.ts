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
    baseUrl: 'https://api-ru.iiko.services/api/v2',
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

describe('IikoClient', () => {
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

    // 1 access_token + 2 organizations, повторного логина нет.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const authUrl = fetchMock.mock.calls[1]?.[0];
    expect(String(authUrl)).toBe('https://api-ru.iiko.services/api/1/organizations');
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

  it('нормализует номенклатуру, включая цену из sizePrices', async () => {
    const { client } = createClient([
      jsonResponse({ token: 't' }),
      jsonResponse({
        revision: 42,
        groups: [{ id: 'g1', name: 'Бар' }],
        products: [
          {
            id: 'p1',
            name: 'Gin Tonic',
            parentGroup: 'g1',
            sizePrices: [{ price: { currentPrice: 2900 } }],
          },
          { id: 'p2', name: 'Espresso', price: 900 },
          { name: 'без id' },
        ],
      }),
    ]);

    const nomenclature = await client.getNomenclature('org-1');
    expect(nomenclature.revision).toBe(42);
    expect(nomenclature.groups).toHaveLength(1);
    expect(nomenclature.products).toHaveLength(2);
    expect(nomenclature.products[0]?.price).toBe(2900);
    expect(nomenclature.products[1]?.price).toBe(900);
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

  it('не выполняет write-запросов: используются только документированные read-only пути', async () => {
    const { client, fetchMock } = createClient([
      jsonResponse({ token: 't' }),
      jsonResponse({ organizations: [] }),
      jsonResponse({ groups: [], products: [] }),
      jsonResponse({ terminalGroupStopLists: [] }),
    ]);

    await client.getOrganizations();
    await client.getNomenclature('org-1');
    await client.getStopList('org-1');

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls).toEqual([
      'https://api-ru.iiko.services/api/v2/access_token',
      'https://api-ru.iiko.services/api/1/organizations',
      'https://api-ru.iiko.services/api/1/nomenclature',
      'https://api-ru.iiko.services/api/1/stop_lists',
    ]);
    expect(urls.some((url) => /order|price|command/i.test(url))).toBe(false);
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
    // Тело использует apiLogin, не apiKey; organizationId в auth не передаётся.
    expect(body.apiKey).toBeUndefined();
    expect(body.organizationId).toBeUndefined();
    expect(body.organizationIds).toBeUndefined();
    // Флаги — настоящие boolean, не строки.
    expect(typeof body.returnAdditionalInfo).toBe('boolean');
    expect(typeof body.includeDisabled).toBe('boolean');
  });

  it('строит URL авторизации v2 без дублирования /api/1', async () => {
    const { client, fetchMock } = createClient([jsonResponse({ token: 't' })]);
    await client.getAccessToken();
    const authUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(authUrl).toBe('https://api-ru.iiko.services/api/v2/access_token');
    // /api/1 не должно быть в URL авторизации вообще.
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

  it('не дублирует /api/v2 при построении URL авторизации', async () => {
    const { client, fetchMock } = createClient([jsonResponse({ token: 't' })]);
    await client.getAccessToken();
    const authUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(authUrl.match(/\/api\/v2/g)?.length).toBe(1);
    expect(authUrl).not.toContain('/api/v2/api/v2');
  });

  it('строит URL меню из IIKO_MENU_PATH без дублирования', async () => {
    const { client, fetchMock } = createClient([
      jsonResponse({ token: 't' }),
      jsonResponse({ groups: [] }),
    ]);
    await client.getExternalMenuOrMenu('cc9baa8d-cfac-4092-9c97-477746fe84e2');
    const menuUrl = String(fetchMock.mock.calls[1]?.[0]);
    expect(menuUrl).toBe('https://api-ru.iiko.services/api/v2/menu');
    expect(menuUrl.match(/\/api\/v2/g)?.length).toBe(1);
    expect(menuUrl).not.toContain('/api/v2/api/v2');
  });

  it('isConfigured требует apiLogin, appId и clientSecret', async () => {
    const onlyLogin = createClient([], { appId: undefined, clientSecret: undefined });
    expect(onlyLogin.client.isConfigured).toBe(false);

    const onlyLoginAndApp = createClient([], { clientSecret: undefined });
    expect(onlyLoginAndApp.client.isConfigured).toBe(false);

    const all = createClient([]);
    expect(all.client.isConfigured).toBe(true);
  });

  it('getExternalMenuOrMenu шлёт externalMenuId + organizationIds на /api/v2/menu', async () => {
    const { client, fetchMock } = createClient([
      jsonResponse({ token: 't' }),
      jsonResponse({ groups: [] }),
    ]);
    await client.getExternalMenuOrMenu('cc9baa8d-cfac-4092-9c97-477746fe84e2');

    const menuUrl = String(fetchMock.mock.calls[1]?.[0]);
    expect(menuUrl).toBe('https://api-ru.iiko.services/api/v2/menu');
    const init = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.externalMenuId).toBe('88042');
    expect(body.organizationIds).toEqual(['cc9baa8d-cfac-4092-9c97-477746fe84e2']);
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer t');
  });

  it('getExternalMenuOrMenu требует externalMenuId', async () => {
    const { client } = createClient([jsonResponse({ token: 't' })], {
      externalMenuId: undefined,
    });
    await expect(
      client.getExternalMenuOrMenu('cc9baa8d-cfac-4092-9c97-477746fe84e2'),
    ).rejects.toMatchObject({ code: 'IIKO_NOT_CONFIGURED' });
  });

  it('diagnoseAuth: две стадии auth+menu, без токена и секретов', async () => {
    // auth (диагностика) + auth (для токена меню) + menu
    const { client, fetchMock } = createClient([
      jsonResponse({ token: 'session-key', correlationId: 'corr-auth' }, 200),
      jsonResponse({ token: 'session-key', correlationId: 'corr-auth-2' }, 200),
      jsonResponse({ groups: [], correlationId: 'corr-menu' }, 200),
    ]);
    const diag = await client.diagnoseAuth();

    expect(diag.apiLoginConfigured).toBe(true);
    expect(diag.appIdConfigured).toBe(true);
    expect(diag.clientSecretConfigured).toBe(true);
    expect(diag.externalMenuIdConfigured).toBe(true);
    expect(diag.organizationIdConfigured).toBe(true);

    // Стадия auth.
    expect(diag.auth.finalUrl).toBe('https://api-ru.iiko.services/api/v2/access_token');
    expect(diag.auth.method).toBe('POST');
    expect(diag.auth.httpStatus).toBe(200);
    expect(diag.auth.correlationId).toBe('corr-auth');
    expect(diag.auth.success).toBe(true);
    expect(diag.auth.error).toBeNull();

    // Стадия menu.
    expect(diag.menu).not.toBeNull();
    expect(diag.menu?.finalUrl).toBe('https://api-ru.iiko.services/api/v2/menu');
    expect(diag.menu?.httpStatus).toBe(200);
    expect(diag.menu?.correlationId).toBe('corr-menu');
    expect(diag.menu?.success).toBe(true);

    // Токен и секреты не попадают в диагностику.
    const serialized = JSON.stringify(diag);
    expect(serialized).not.toContain('session-key');
    expect(serialized).not.toContain('test-api-login');
    expect(serialized).not.toContain('test-app-id');
    expect(serialized).not.toContain('test-client-secret');

    // Тело запроса auth содержит секреты, но диагностика их не раскрывает.
    const authInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(String(authInit.body)).toContain('test-client-secret');
    // Тело menu содержит externalMenuId и Bearer, но диагностика не раскрывает токен.
    const menuInit = fetchMock.mock.calls[2]?.[1] as RequestInit;
    const menuHeaders = menuInit.headers as Record<string, string>;
    expect(menuHeaders.authorization).toBe('Bearer session-key');
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
    // auth (диагностика) + auth (токен) + menu 404
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
    // Auth при этом успешен — ошибка изолирована на стадии menu.
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
    // Только один запрос — auth (диагностика); токен для меню не запрашивается.
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
});
