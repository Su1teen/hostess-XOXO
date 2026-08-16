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
    baseUrl: 'https://api-ru.iiko.services/api/1',
    apiKey: 'apiKey' in overrides ? overrides.apiKey : 'test-api-login',
    appId: 'appId' in overrides ? overrides.appId : 'test-app-id',
    clientSecret:
      'clientSecret' in overrides ? overrides.clientSecret : 'test-client-secret',
    authPath: overrides.authPath,
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
      'https://api-ru.iiko.services/api/1/access_token',
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
    // Тело использует apiLogin, не apiKey.
    expect(body.apiKey).toBeUndefined();
    // Флаги — настоящие boolean, не строки.
    expect(typeof body.returnAdditionalInfo).toBe('boolean');
    expect(typeof body.includeDisabled).toBe('boolean');
  });

  it('строит URL авторизации без дублирования /api/1', async () => {
    const { client, fetchMock } = createClient([jsonResponse({ token: 't' })]);
    await client.getAccessToken();
    const authUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(authUrl).toBe('https://api-ru.iiko.services/api/1/access_token');
    expect(authUrl.match(/\/api\/1/g)?.length).toBe(1);
  });

  it('использует IIKO_AUTH_PATH для построения URL авторизации', async () => {
    const { client, fetchMock } = createClient([jsonResponse({ token: 't' })], {
      authPath: '/access_token',
    });
    await client.getAccessToken();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://api-ru.iiko.services/api/1/access_token',
    );
  });

  it('isConfigured требует apiLogin, appId и clientSecret', async () => {
    const onlyLogin = createClient([], { appId: undefined, clientSecret: undefined });
    expect(onlyLogin.client.isConfigured).toBe(false);

    const onlyLoginAndApp = createClient([], { clientSecret: undefined });
    expect(onlyLoginAndApp.client.isConfigured).toBe(false);

    const all = createClient([]);
    expect(all.client.isConfigured).toBe(true);
  });

  it('diagnoseAuth возвращает безопасную диагностику без токена и секретов', async () => {
    const { client, fetchMock } = createClient([
      jsonResponse({ token: 'session-key', correlationId: 'corr-123' }, 200),
    ]);
    const diag = await client.diagnoseAuth();

    expect(diag.method).toBe('POST');
    expect(diag.finalUrl).toBe('https://api-ru.iiko.services/api/1/access_token');
    expect(diag.apiLoginConfigured).toBe(true);
    expect(diag.appIdConfigured).toBe(true);
    expect(diag.clientSecretConfigured).toBe(true);
    expect(diag.upstream.httpStatus).toBe(200);
    expect(diag.upstream.correlationId).toBe('corr-123');
    expect(diag.upstream.error).toBeNull();

    // Токен и секреты не попадают в диагностику.
    const serialized = JSON.stringify(diag);
    expect(serialized).not.toContain('session-key');
    expect(serialized).not.toContain('test-api-login');
    expect(serialized).not.toContain('test-app-id');
    expect(serialized).not.toContain('test-client-secret');

    // Тело запроса содержит секреты, но диагностика их не раскрывает.
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(String(init.body)).toContain('test-client-secret');
  });

  it('diagnoseAuth фиксирует upstream HTTP-статус и correlationId при ошибке', async () => {
    const { client } = createClient([
      jsonResponse(
        { errorDescription: 'Invalid credentials', correlationId: 'corr-err-1' },
        401,
      ),
    ]);
    const diag = await client.diagnoseAuth();

    expect(diag.upstream.httpStatus).toBe(401);
    expect(diag.upstream.correlationId).toBe('corr-err-1');
    expect(diag.upstream.error).toContain('Invalid credentials');
    // Не выбрасывает, возвращает безопасный объект.
    expect(diag.apiLoginConfigured).toBe(true);
  });

  it('diagnoseAuth сообщает о незавершённых учётных данных без запроса', async () => {
    const { client, fetchMock } = createClient([], { appId: undefined });
    const diag = await client.diagnoseAuth();

    expect(diag.appIdConfigured).toBe(false);
    expect(diag.upstream.httpStatus).toBeNull();
    expect(diag.upstream.error).toMatch(/настроены/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
