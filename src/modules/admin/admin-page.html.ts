/**
 * HTML диагностической страницы. Никаких данных, ключей и внешних CDN здесь нет:
 * ключ администратора вводится в браузере и хранится только в sessionStorage.
 * Плейсхолдер __ADMIN_HEADER__ подставляется из ADMIN_API_KEY_HEADER.
 */
export const ADMIN_PAGE_HTML = `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>Bar Exchange — диагностика</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0e1116;
        --panel: #161b22;
        --border: #273041;
        --text: #e6edf3;
        --muted: #8b949e;
        --ok: #3fb950;
        --warn: #d29922;
        --err: #f85149;
        --accent: #2f81f7;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 16px;
        background: var(--bg);
        color: var(--text);
        font: 14px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
      }
      h1 { font-size: 20px; margin: 0 0 4px; }
      h2 { font-size: 16px; margin: 0 0 12px; }
      p.sub { color: var(--muted); margin: 0 0 16px; }
      .wrap { max-width: 1060px; margin: 0 auto; }
      .grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
      .card {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 16px;
      }
      label { display: block; color: var(--muted); margin-bottom: 4px; font-size: 13px; }
      input, select {
        width: 100%;
        padding: 8px 10px;
        margin-bottom: 10px;
        background: #0d1117;
        color: var(--text);
        border: 1px solid var(--border);
        border-radius: 6px;
      }
      button {
        padding: 8px 12px;
        margin: 0 6px 6px 0;
        background: var(--accent);
        color: #fff;
        border: 0;
        border-radius: 6px;
        cursor: pointer;
        font-size: 13px;
      }
      button.secondary { background: #21262d; border: 1px solid var(--border); }
      button:disabled { opacity: 0.55; cursor: not-allowed; }
      table { width: 100%; border-collapse: collapse; font-size: 13px; }
      th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); }
      th { color: var(--muted); font-weight: 500; }
      pre {
        margin: 0;
        padding: 10px;
        max-height: 320px;
        overflow: auto;
        background: #0d1117;
        border: 1px solid var(--border);
        border-radius: 6px;
        font-size: 12px;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: flex-end; }
      .row > div { flex: 1 1 160px; }
      .status { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; }
      .status.ok { background: rgba(63, 185, 80, 0.15); color: var(--ok); }
      .status.warn { background: rgba(210, 153, 34, 0.15); color: var(--warn); }
      .status.err { background: rgba(248, 81, 73, 0.15); color: var(--err); }
      .muted { color: var(--muted); }
      .note {
        margin-top: 16px;
        padding: 12px;
        border-left: 3px solid var(--warn);
        background: rgba(210, 153, 34, 0.08);
        color: var(--muted);
      }
      #message { min-height: 20px; margin: 10px 0; font-size: 13px; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <h1>Bar Exchange — панель диагностики</h1>
      <p class="sub">
        v0.1: backend не изменяет цены в iiko, не создаёт заказы и не отправляет команды на кассу.
      </p>

      <div class="card">
        <h2>Доступ</h2>
        <label for="apiKey">Админ-ключ (заголовок <code>__ADMIN_HEADER__</code>)</label>
        <input id="apiKey" type="password" autocomplete="off" placeholder="Введите ADMIN_API_KEY" />
        <div class="row">
          <div>
            <button id="btnSave">Сохранить на сессию</button>
            <button id="btnForget" class="secondary">Забыть ключ</button>
            <button id="btnRefresh" class="secondary">Обновить диагностику</button>
          </div>
        </div>
        <div id="message" class="muted">Ключ хранится только в sessionStorage этой вкладки.</div>
      </div>

      <div class="grid" style="margin-top: 16px">
        <div class="card">
          <h2>Статус системы</h2>
          <table id="statusTable">
            <tbody>
              <tr><td class="muted" colspan="2">Нет данных — введите ключ и обновите.</td></tr>
            </tbody>
          </table>
        </div>

        <div class="card">
          <h2>iiko Cloud API (только чтение)</h2>
          <button id="btnIikoTest">Проверить подключение</button>
          <button id="btnIikoAuthDiag" class="secondary">Диагностика авторизации</button>
          <button id="btnIikoOrgs" class="secondary">Синхронизировать организации</button>
          <button id="btnIikoMenu" class="secondary">Синхронизировать меню</button>
          <label for="orgSelect">Организация</label>
          <select id="orgSelect"><option value="">— загрузите организации —</option></select>
          <button id="btnSelectOrg" class="secondary">Выбрать организацию</button>
          <div id="iikoAuthDiag" style="margin-top: 12px"></div>
        </div>

        <div class="card">
          <h2>Сводка последней синхронизации меню</h2>
          <table id="syncSummaryTable">
            <tbody>
              <tr><td class="muted" colspan="2">Нет данных — выполните синхронизацию меню.</td></tr>
            </tbody>
          </table>
        </div>

        <div class="card">
          <h2>Товары биржи</h2>
          <div class="row">
            <div>
              <label for="search">Поиск (название, размер, SKU, категория)</label>
              <input id="search" type="text" placeholder="Например: джин" />
            </div>
            <div>
              <label for="categorySelect">Категория</label>
              <select id="categorySelect"><option value="">— все категории —</option></select>
            </div>
            <div style="flex: 0 0 auto">
              <button id="btnSearch">Найти</button>
              <button id="btnExchange" class="secondary">Только биржевые</button>
              <button id="btnResetFilters" class="secondary">Сбросить</button>
            </div>
          </div>
          <table id="productsTable">
            <thead>
              <tr>
                <th>Товар</th><th>Размер</th><th>SKU</th><th>Категория</th>
                <th>Цена</th><th>Доступен</th><th>Биржа</th><th></th>
              </tr>
            </thead>
            <tbody>
              <tr><td class="muted" colspan="8">Нет данных.</td></tr>
            </tbody>
          </table>
          <div class="row" style="margin-top: 8px; align-items: center">
            <div style="flex: 0 0 auto">
              <button id="btnPrevPage" class="secondary">← Назад</button>
              <span id="pageInfo" class="muted">стр. 1 / 1</span>
              <button id="btnNextPage" class="secondary">Вперёд →</button>
            </div>
          </div>
        </div>

        <div class="card">
          <h2>Раунды (15 минут)</h2>
          <button id="btnSimulate">Симулировать раунд</button>
          <button id="btnRounds" class="secondary">Обновить список</button>
          <button id="btnTelegram" class="secondary">Тест Telegram</button>
          <div style="max-height: 320px; overflow: auto">
            <table id="roundsTable">
              <thead>
                <tr><th>Раунд</th><th>Статус</th><th>Позиций</th><th></th></tr>
              </thead>
              <tbody>
                <tr><td class="muted" colspan="4">Нет данных.</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="card" style="margin-top: 16px">
        <h2>Ответ последнего запроса</h2>
        <pre id="output">—</pre>
      </div>

      <div class="note">
        Публикация раунда обновляет только цены backend и публичного API для сайта.
        Касса iikoFront получит цены только после реализации плагина (v0.3+).
      </div>
    </div>

    <script>
      (function () {
        'use strict';
        var HEADER = '__ADMIN_HEADER__';
        var STORAGE_KEY = 'barExchangeAdminKey';
        var el = function (id) { return document.getElementById(id); };
        var output = el('output');
        var message = el('message');

        var saved = sessionStorage.getItem(STORAGE_KEY);
        if (saved) { el('apiKey').value = saved; }

        function key() { return el('apiKey').value.trim(); }

        function setMessage(text, kind) {
          message.textContent = text;
          message.className = kind === 'error' ? 'status err' : kind === 'ok' ? 'status ok' : 'muted';
        }

        function show(data) {
          output.textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
        }

        function request(method, path, body) {
          if (!key()) {
            setMessage('Сначала введите админ-ключ.', 'error');
            return Promise.reject(new Error('no key'));
          }
          var headers = {};
          headers[HEADER] = key();
          if (body) { headers['content-type'] = 'application/json'; }
          return fetch(path, {
            method: method,
            headers: headers,
            body: body ? JSON.stringify(body) : undefined,
          }).then(function (response) {
            return response.json().catch(function () { return {}; }).then(function (json) {
              if (!response.ok) {
                var code = json && json.error ? json.error.code : 'HTTP_' + response.status;
                var text = json && json.error ? json.error.message : 'Ошибка запроса';
                setMessage(code + ': ' + text, 'error');
                show(json);
                throw new Error(code);
              }
              setMessage(method + ' ' + path + ' — успешно', 'ok');
              show(json);
              return json;
            });
          });
        }

        function statusClass(value) {
          var text = String(value).toLowerCase();
          if (text === 'ok' || text === 'configured' || text === 'да') return 'ok';
          if (text === 'unavailable' || text === 'error') return 'err';
          return 'warn';
        }

        function flag(value) { return value ? 'да' : 'нет'; }

        function renderStatus(data) {
          var rounds = data.rounds || {};
          var rows = [
            ['API', data.checks && data.checks.api, true],
            ['База данных', data.checks && data.checks.database, true],
            ['iiko Cloud API', data.checks && data.checks.iiko, true],
            ['Организация', (data.organization && data.organization.name) || 'не выбрана', false],
            ['Товаров всего', data.products && data.products.total, false],
            ['Биржевых товаров', data.products && data.products.exchange, false],
            ['Текущее окно', rounds.currentWindow && rounds.currentWindow.roundKey, false],
            ['Следующее окно', rounds.nextWindow && rounds.nextWindow.roundKey, false],
            ['Опубликованный раунд', (rounds.publishedRound && rounds.publishedRound.roundKey) || 'нет', false],
            ['Симулированный раунд', (rounds.nextSimulatedRound && rounds.nextSimulatedRound.roundKey) || 'нет', false],
            ['Режим публикации', data.pricePublisher && data.pricePublisher.mode, false],
            ['Последняя синхронизация меню', (data.sync && data.sync.lastMenuSyncAt) || 'нет', false],
            ['Telegram', flag(data.telegram && data.telegram.configured), true],
            ['iikoFront plugin', flag(data.frontPlugin && data.frontPlugin.enabled), true],
            ['Webhook secret', flag(data.webhook && data.webhook.secretConfigured), true],
          ];
          var body = rows
            .map(function (row) {
              var value = row[1] === undefined || row[1] === null ? '—' : row[1];
              var cell = row[2]
                ? '<span class="status ' + statusClass(value) + '">' + escapeHtml(value) + '</span>'
                : escapeHtml(value);
              return '<tr><th>' + escapeHtml(row[0]) + '</th><td>' + cell + '</td></tr>';
            })
            .join('');
          el('statusTable').querySelector('tbody').innerHTML = body;
        }

        function escapeHtml(value) {
          return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
        }

        function loadDiagnostics() {
          return request('GET', '/api/v1/admin/diagnostics').then(renderDiagnostics);
        }

        function renderDiagnostics(data) {
          renderStatus(data);
          if (data.sync && data.sync.lastSummary) {
            renderSyncSummary(data.sync.lastSummary);
          }
        }

        var productsState = { page: 1, pageSize: 50, exchangeOnly: false };

        function renderProducts(items) {
          var tbody = el('productsTable').querySelector('tbody');
          if (!items || items.length === 0) {
            tbody.innerHTML = '<tr><td class="muted" colspan="8">Ничего не найдено.</td></tr>';
            return;
          }
          tbody.innerHTML = items
            .map(function (item) {
              var price = item.currentExchangePrice !== null && item.currentExchangePrice !== undefined
                ? item.currentExchangePrice
                : item.basePrice;
              var avail = item.isAvailable
                ? '<span class="status ok">да</span>'
                : '<span class="status err">нет</span>';
              var action = item.isExchangeProduct
                ? '<button class="secondary" data-remove="' + item.id + '">Убрать из биржи</button>'
                : '<button data-select="' + item.id + '">Добавить в биржу</button>';
              return (
                '<tr><td>' + escapeHtml(item.displayName || item.name) + '</td>' +
                '<td>' + escapeHtml(item.sizeName || '—') + '</td>' +
                '<td>' + escapeHtml(item.sku || '—') + '</td>' +
                '<td>' + escapeHtml(item.categoryName || '—') + '</td>' +
                '<td>' + escapeHtml(price) + ' ₸</td>' +
                '<td>' + avail + '</td>' +
                '<td>' + (item.isExchangeProduct ? 'да' : 'нет') + '</td>' +
                '<td>' + action + '</td></tr>'
              );
            })
            .join('');
        }

        function renderPagination(pagination) {
          el('pageInfo').textContent =
            'стр. ' + pagination.page + ' / ' + pagination.totalPages +
            ' (всего ' + pagination.total + ')';
          el('btnPrevPage').disabled = pagination.page <= 1;
          el('btnNextPage').disabled = pagination.page >= pagination.totalPages;
        }

        function loadProducts() {
          var params = new URLSearchParams();
          params.set('page', String(productsState.page));
          params.set('pageSize', String(productsState.pageSize));
          params.set('sellableOnly', 'true');
          params.set('availableOnly', 'true');
          params.set('activeOnly', 'true');
          if (el('search').value.trim()) { params.set('search', el('search').value.trim()); }
          var cat = el('categorySelect').value;
          if (cat) { params.set('category', cat); }
          if (productsState.exchangeOnly) { params.set('exchangeOnly', 'true'); }
          return request('GET', '/api/v1/admin/products?' + params.toString()).then(function (data) {
            renderProducts(data.data);
            renderPagination(data.pagination);
          });
        }

        function loadCategories() {
          return request('GET', '/api/v1/admin/products/categories').then(function (data) {
            var select = el('categorySelect');
            var items = data.items || [];
            var current = select.value;
            select.innerHTML = '<option value="">— все категории —</option>' +
              items
                .map(function (item) {
                  return '<option value="' + escapeHtml(item.name) + '">' +
                    escapeHtml(item.name) + ' (' + item.count + ')</option>';
                })
                .join('');
            if (current) { select.value = current; }
          });
        }

        function renderSyncSummary(data) {
          var tbody = el('syncSummaryTable').querySelector('tbody');
          if (!data) {
            tbody.innerHTML = '<tr><td class="muted" colspan="2">Сводка недоступна.</td></tr>';
            return;
          }
          var rows = [
            ['Успех', data.success ? '<span class="status ok">да</span>' : '<span class="status err">нет</span>'],
            ['Категорий в источнике', data.categoryCount],
            ['Товаров в источнике', data.sourceItemCount],
            ['Sellable вариантов извлечено', data.variantsExtracted],
            ['Сохранено/обновлено', data.savedOrUpdate],
            ['Пропущено без размеров', data.skippedNoSizes],
            ['Пропущено hidden', data.skippedHidden],
            ['Пропущено нулевая цена', data.skippedZeroPrice],
            ['Пропущено битая цена', data.skippedMalformedPrice],
            ['Помечено недоступными', data.unavailableCount],
            ['correlationId', data.correlationId || '—'],
            ['Длительность, мс', data.durationMs],
            ['Ошибка', data.error || '—'],
          ];
          tbody.innerHTML = rows
            .map(function (row) {
              return '<tr><th>' + escapeHtml(row[0]) + '</th><td>' + row[1] + '</td></tr>';
            })
            .join('');
        }

        function renderRounds(items) {
          var tbody = el('roundsTable').querySelector('tbody');
          if (!items || items.length === 0) {
            tbody.innerHTML = '<tr><td class="muted" colspan="4">Раундов нет.</td></tr>';
            return;
          }
          tbody.innerHTML = items
            .map(function (item) {
              return (
                '<tr><td>' + escapeHtml(item.roundKey) + '</td><td>' + escapeHtml(item.status) + '</td>' +
                '<td>' + escapeHtml(item.productsCount) + '</td><td>' +
                '<button class="secondary" data-round="' + item.id + '">Открыть</button>' +
                '<button data-approve="' + item.id + '">Утвердить</button>' +
                '<button data-publish="' + item.id + '">Опубликовать</button>' +
                '<button class="secondary" data-rollback="' + item.id + '">Откат</button>' +
                '</td></tr>'
              );
            })
            .join('');
        }

        function loadRounds() {
          return request('GET', '/api/v1/admin/rounds?limit=20').then(function (data) {
            renderRounds(data.items);
          });
        }

        function loadOrganizations() {
          return request('GET', '/api/v1/admin/iiko/organizations').then(function (data) {
            var select = el('orgSelect');
            var items = data.items || [];
            select.innerHTML = items.length
              ? items
                  .map(function (item) {
                    return '<option value="' + escapeHtml(item.iikoOrganizationId) + '">' +
                      escapeHtml(item.name) + (item.isSelected ? ' (выбрана)' : '') + '</option>';
                  })
                  .join('')
              : '<option value="">— организаций нет —</option>';
          });
        }

        function silent(promise) { return promise.catch(function () {}); }

        el('btnSave').addEventListener('click', function () {
          if (!key()) { setMessage('Ключ пустой.', 'error'); return; }
          sessionStorage.setItem(STORAGE_KEY, key());
          setMessage('Ключ сохранён в sessionStorage.', 'ok');
          silent(loadDiagnostics());
        });

        el('btnForget').addEventListener('click', function () {
          sessionStorage.removeItem(STORAGE_KEY);
          el('apiKey').value = '';
          setMessage('Ключ удалён из sessionStorage.', 'ok');
        });

        el('btnRefresh').addEventListener('click', function () { silent(loadDiagnostics()); });
        el('btnIikoTest').addEventListener('click', function () {
          silent(request('POST', '/api/v1/admin/iiko/test-connection'));
        });
        el('btnIikoAuthDiag').addEventListener('click', function () {
          silent(
            request('GET', '/api/v1/admin/iiko/auth-diagnostics').then(renderIikoAuthDiag),
          );
        });

        function stageStatusCell(stage) {
          if (!stage) return '<span class="status warn">не выполнялась</span>';
          var status = stage.httpStatus;
          if (status === null) {
            return stage.success
              ? '<span class="status ok">OK</span>'
              : '<span class="status warn">нет ответа</span>';
          }
          return status >= 200 && status < 300
            ? '<span class="status ok">' + escapeHtml(status) + '</span>'
            : '<span class="status err">' + escapeHtml(status) + '</span>';
        }

        function renderStageTable(title, stage) {
          if (!stage) {
            return (
              '<h2 style="margin-top:12px">' + escapeHtml(title) + '</h2>' +
              '<p class="muted">Стадия не выполнялась (зависит от предыдущей стадии).</p>'
            );
          }
          var rows = [
            ['URL', escapeHtml(stage.finalUrl), false],
            ['Метод', escapeHtml(stage.method), false],
            ['HTTP статус', stageStatusCell(stage), false],
            ['correlationId', stage.correlationId ? escapeHtml(stage.correlationId) : '—', false],
            ['Результат', stage.success
              ? '<span class="status ok">успех</span>'
              : '<span class="status err">ошибка</span>', false],
            ['Ошибка', stage.error ? escapeHtml(stage.error) : '—', false],
            ['Длительность, мс', escapeHtml(stage.durationMs), false],
          ];
          return (
            '<h2 style="margin-top:12px">' + escapeHtml(title) + '</h2>' +
            '<table><tbody>' +
            rows
              .map(function (row) {
                return '<tr><th>' + row[0] + '</th><td>' + row[1] + '</td></tr>';
              })
              .join('') +
            '</tbody></table>'
          );
        }

        function renderIikoAuthDiag(data) {
          var box = el('iikoAuthDiag');
          if (!data) { box.innerHTML = '<p class="muted">Нет данных.</p>'; return; }
          var cfgRows = [
            ['apiLogin настроен', flag(data.apiLoginConfigured), true],
            ['appId настроен', flag(data.appIdConfigured), true],
            ['clientSecret настроен', flag(data.clientSecretConfigured), true],
            ['externalMenuId настроен', flag(data.externalMenuIdConfigured), true],
            ['organizationId настроен', flag(data.organizationIdConfigured), true],
            ['Синхронизация включена', flag(data.syncEnabled), true],
            ['Общая длительность, мс', escapeHtml(data.durationMs), false],
          ];
          var cfgTable =
            '<h2 style="margin-top:12px">Диагностика iiko: auth + menu</h2>' +
            '<table><tbody>' +
            cfgRows
              .map(function (row) {
                var value = row[2]
                  ? '<span class="status ' + statusClass(row[1]) + '">' + escapeHtml(row[1]) + '</span>'
                  : row[1];
                return '<tr><th>' + escapeHtml(row[0]) + '</th><td>' + value + '</td></tr>';
              })
              .join('') +
            '</tbody></table>';
          box.innerHTML = cfgTable +
            renderStageTable('Стадия 1: авторизация (/api/v2/access_token)', data.auth) +
            renderStageTable('Стадия 2: меню (/api/v2/menu)', data.menu);
        }
        el('btnIikoOrgs').addEventListener('click', function () {
          silent(request('POST', '/api/v1/admin/iiko/sync-organizations').then(loadOrganizations));
        });
        el('btnIikoMenu').addEventListener('click', function () {
          silent(
            request('POST', '/api/v1/admin/iiko/sync-menu').then(function (summary) {
              renderSyncSummary(summary);
              return Promise.all([loadCategories(), loadProducts()]);
            }),
          );
        });
        el('btnSelectOrg').addEventListener('click', function () {
          var value = el('orgSelect').value;
          if (!value) { setMessage('Выберите организацию в списке.', 'error'); return; }
          silent(request('POST', '/api/v1/admin/iiko/select-organization', { iikoOrganizationId: value })
            .then(loadDiagnostics));
        });
        el('btnSearch').addEventListener('click', function () {
          productsState.page = 1;
          silent(loadProducts());
        });
        el('btnExchange').addEventListener('click', function () {
          productsState.exchangeOnly = !productsState.exchangeOnly;
          productsState.page = 1;
          silent(loadProducts());
        });
        el('btnResetFilters').addEventListener('click', function () {
          el('search').value = '';
          el('categorySelect').value = '';
          productsState.exchangeOnly = false;
          productsState.page = 1;
          silent(loadProducts());
        });
        el('categorySelect').addEventListener('change', function () {
          productsState.page = 1;
          silent(loadProducts());
        });
        el('btnPrevPage').addEventListener('click', function () {
          if (productsState.page > 1) {
            productsState.page -= 1;
            silent(loadProducts());
          }
        });
        el('btnNextPage').addEventListener('click', function () {
          productsState.page += 1;
          silent(loadProducts());
        });
        el('btnSimulate').addEventListener('click', function () {
          silent(request('POST', '/api/v1/admin/rounds/simulate', {}).then(loadRounds));
        });
        el('btnRounds').addEventListener('click', function () { silent(loadRounds()); });
        el('btnTelegram').addEventListener('click', function () {
          silent(request('POST', '/api/v1/admin/telegram/test'));
        });

        document.addEventListener('click', function (event) {
          var target = event.target;
          if (!target || target.tagName !== 'BUTTON') return;
          var data = target.dataset;
          if (data.select) {
            silent(request('POST', '/api/v1/admin/products/' + data.select + '/select-for-exchange')
              .then(function () { return loadProducts(); }));
          } else if (data.remove) {
            silent(request('POST', '/api/v1/admin/products/' + data.remove + '/remove-from-exchange')
              .then(function () { return loadProducts(); }));
          } else if (data.round) {
            silent(request('GET', '/api/v1/admin/rounds/' + data.round));
          } else if (data.approve) {
            silent(request('POST', '/api/v1/admin/rounds/' + data.approve + '/approve').then(loadRounds));
          } else if (data.publish) {
            silent(request('POST', '/api/v1/admin/rounds/' + data.publish + '/publish').then(loadRounds));
          } else if (data.rollback) {
            silent(request('POST', '/api/v1/admin/rounds/' + data.rollback + '/rollback').then(loadRounds));
          }
        });

        if (saved) {
          silent(loadDiagnostics().then(function () {
            return Promise.all([loadCategories(), loadProducts()]);
          }));
        }
      })();
    </script>
  </body>
</html>
`;
