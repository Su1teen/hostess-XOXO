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
      .span-all { grid-column: 1 / -1; }
      .table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
      .table-scroll table { min-width: 720px; }
      .table-scroll th, .table-scroll td { white-space: nowrap; }
      .table-scroll td.wrap-cell { white-space: normal; word-break: break-word; }
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

      /* ---------- Режим «Бармен» ---------- */
      .bartender-entry {
        display: block;
        width: 100%;
        margin: 0 0 16px;
        padding: 14px 18px;
        font-size: 16px;
        font-weight: 600;
        letter-spacing: 0.02em;
        background: #1f6feb;
      }
      body.bartender-active .wrap { display: none; }
      body.bartender-active { padding: 0; overflow: hidden; }
      #bartenderMode {
        position: fixed;
        inset: 0;
        z-index: 50;
        display: flex;
        flex-direction: column;
        background: #0b0e13;
        overflow: hidden;
      }
      #bartenderMode[hidden] { display: none; }
      .bt-login {
        margin: auto;
        width: min(360px, calc(100% - 32px));
        padding: 24px;
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 12px;
      }
      .bt-login h2 { font-size: 18px; }
      .bt-login input { font-size: 22px; letter-spacing: 0.35em; text-align: center; padding: 12px; }
      .bt-login button { width: 100%; padding: 12px; font-size: 15px; }
      #bartenderWorkspace { display: flex; flex-direction: column; min-height: 0; flex: 1; }
      #bartenderWorkspace[hidden] { display: none; }
      .bt-top {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
        padding: 10px 14px;
        border-bottom: 1px solid var(--border);
        background: #10141b;
      }
      .bt-top h2 { margin: 0; font-size: 17px; }
      .bt-meta { display: flex; flex-wrap: wrap; gap: 8px; font-size: 12px; color: var(--muted); }
      .bt-top .bt-actions { margin-left: auto; display: flex; flex-wrap: wrap; }
      .bt-top button { margin: 0 0 0 6px; }
      .bt-controls {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
        padding: 10px 14px;
        border-bottom: 1px solid var(--border);
      }
      .bt-controls input[type='search'] {
        flex: 1 1 240px;
        margin: 0;
        padding: 10px 12px;
        font-size: 15px;
      }
      .bt-filters { display: flex; flex-wrap: wrap; gap: 6px; }
      .bt-filters button { margin: 0; background: #21262d; border: 1px solid var(--border); }
      .bt-filters button[aria-pressed='true'] { background: #1f6feb; border-color: #1f6feb; }
      .bt-grid {
        flex: 1;
        min-height: 0;
        overflow: auto;
        display: grid;
        gap: 10px;
        grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
        padding: 12px 14px 24px;
        align-content: start;
      }
      .bt-card {
        background: #141922;
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 12px;
      }
      .bt-card h3 { margin: 0; font-size: 16px; }
      .bt-card .bt-cat { font-size: 12px; color: var(--muted); margin-bottom: 8px; }
      .bt-prices { display: flex; flex-wrap: wrap; gap: 10px 16px; margin-bottom: 8px; }
      .bt-prices div { font-size: 12px; color: var(--muted); }
      .bt-prices b { display: block; font-size: 15px; color: var(--text); font-weight: 600; }
      .bt-prices .bt-now b { font-size: 22px; color: #58a6ff; }
      .bt-sale-primary { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
      .bt-sale-primary .bt-do-sale {
        flex: 1; padding: 14px 12px; font-size: 17px; font-weight: 600;
        background: #238636; border: 1px solid #2ea043; color: #fff; cursor: pointer;
      }
      .bt-sale-primary .bt-do-sale:disabled { opacity: 0.6; cursor: wait; }
      .bt-sale-primary .bt-count { font-size: 13px; color: var(--muted); white-space: nowrap; }
      .bt-sale-primary .bt-count b { color: var(--text); font-size: 18px; }
      .bt-sales { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
      .bt-sales button { margin: 0; min-width: 44px; min-height: 44px; padding: 8px 14px; font-size: 14px; background: #21262d; border: 1px solid var(--border); cursor: pointer; }
      .bt-sales button:disabled { opacity: 0.6; cursor: wait; }
      .bt-sales input { width: 72px; min-height: 44px; margin: 0; padding: 8px 6px; text-align: center; font-size: 15px; }
      .bt-sales .bt-total-label, .bt-sales .bt-delta-label { flex-basis: 100%; font-size: 12px; color: var(--muted); }
      .bt-sales .bt-delta-input { width: 72px; }
      .bt-state { margin-top: 6px; font-size: 12px; color: var(--muted); }
      .bt-state.err { color: var(--err); }
      .bt-state.ok { color: var(--ok); }
      .bt-card button:focus-visible, .bt-card input:focus-visible { outline: 2px solid #58a6ff; outline-offset: 2px; }
      @media (max-width: 700px) {
        .bt-grid { grid-template-columns: minmax(0, 1fr); padding: 10px 8px 20px; }
        .bt-top, .bt-controls { padding-left: 10px; padding-right: 10px; }
        .bt-top .bt-actions { margin-left: 0; width: 100%; }
        .bt-top .bt-actions button { margin-left: 0; margin-right: 6px; }
        .bt-card { min-width: 0; }
      }
      @media (max-width: 520px) {
        .bt-sale-primary { align-items: stretch; }
        .bt-sale-primary .bt-count { align-self: center; }
      }
      @media (max-width: 360px) {
        .bt-sales { gap: 4px; }
        .bt-sales .bt-delta-label { margin-top: 2px; }
        .bt-sales .bt-delta-input { flex: 1; min-width: 64px; }
        .bt-sales button { padding-left: 10px; padding-right: 10px; }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <h1>Bar Exchange — панель диагностики</h1>
      <p class="sub">
        v0.1: backend не изменяет цены в iiko, не создаёт заказы и не отправляет команды на кассу.
      </p>

      <button id="btnBartenderOpen" class="bartender-entry" type="button">
        Бармен — рабочая панель расчёта цен
      </button>

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
          <h2>Диагностика формата цены iiko</h2>
          <table id="parserSampleTable">
            <tbody>
              <tr><td class="muted" colspan="2">Нет данных — выполните синхронизацию меню.</td></tr>
            </tbody>
          </table>
        </div>

        <div class="card span-all">
          <h2>Каталог iiko</h2>
          <p class="muted">Напитки-кандидаты не добавляются на биржу автоматически.</p>
          <div class="row">
            <div>
              <label for="catalogScope">Фильтр каталога</label>
              <select id="catalogScope">
                <option value="candidates">Напитки-кандидаты</option>
                <option value="all">Весь каталог</option>
                <option value="exchange">Только товары биржи</option>
              </select>
            </div>
            <div>
              <label for="search">Поиск</label>
              <input id="search" type="text" placeholder="Название, размер, SKU, категория" />
            </div>
            <div>
              <label for="categorySelect">Категория</label>
              <select id="categorySelect"><option value="">— все категории —</option></select>
            </div>
            <div style="flex: 0 0 auto">
              <button id="btnSearch">Найти</button>
              <button id="btnResetFilters" class="secondary">Сбросить</button>
            </div>
          </div>
          <div class="table-scroll">
            <table id="productsTable">
              <thead>
                <tr>
                  <th>Название</th><th>Размер</th><th>SKU</th><th>Категория</th>
                  <th>Текущая цена iiko</th><th>Напиток-кандидат</th><th>Выбран для биржи</th>
                  <th>iiko item ID</th><th>iiko size ID</th><th></th>
                </tr>
              </thead>
              <tbody>
                <tr><td class="muted" colspan="10">Нет данных.</td></tr>
              </tbody>
            </table>
          </div>
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

    <div id="bartenderMode" hidden>
      <div id="bartenderLogin" class="bt-login">
        <h2>Панель бармена</h2>
        <p class="muted">Введите PIN смены.</p>
        <label for="bartenderPin">PIN</label>
        <input id="bartenderPin" type="password" inputmode="numeric" autocomplete="off" />
        <button id="btnBartenderLogin" type="button">Войти</button>
        <button id="btnBartenderCancel" class="secondary" type="button">Вернуться в админку</button>
        <div id="bartenderLoginMsg" class="muted"></div>
      </div>

      <div id="bartenderWorkspace" hidden>
        <div class="bt-top">
          <h2>Бармен — продажи</h2>
          <div class="bt-meta">
            <span id="btConn" class="status warn">подключение…</span>
            <span id="btRound">раунд: —</span>
            <span id="btUpdated">обновлено: —</span>
          </div>
          <div class="bt-actions">
            <button id="btnBtRefresh" class="secondary" type="button">Обновить</button>
            <button id="btnBtFullscreen" class="secondary" type="button">На весь экран</button>
            <button id="btnBtAdmin" class="secondary" type="button">В админку</button>
            <button id="btnBtLogout" class="secondary" type="button">Выйти</button>
          </div>
        </div>
        <div class="bt-controls">
          <input id="btSearch" type="search" placeholder="Поиск: название или категория" autocomplete="off" />
          <div id="btFilters" class="bt-filters"></div>
        </div>
        <div id="btGrid" class="bt-grid"></div>
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
            ['Напитков-кандидатов', data.products && data.products.drinkCandidates, false],
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

        var productsState = { page: 1, pageSize: 50 };

        function renderProducts(items) {
          var tbody = el('productsTable').querySelector('tbody');
          if (!items || items.length === 0) {
            tbody.innerHTML = '<tr><td class="muted" colspan="10">Ничего не найдено.</td></tr>';
            return;
          }
          tbody.innerHTML = items
            .map(function (item) {
              var price = item.currentKnownIikoPrice === null ? '—' : item.currentKnownIikoPrice + ' ₸';
              var action = item.isExchangeProduct
                ? '<button class="secondary" data-remove="' + item.id + '">Убрать из биржи</button>'
                : '<button data-select="' + item.id + '">Добавить в биржу</button>';
              return (
                '<tr><td class="wrap-cell">' + escapeHtml(item.name) + '</td>' +
                '<td>' + escapeHtml(item.sizeName || '—') + '</td>' +
                '<td>' + escapeHtml(item.sku || '—') + '</td>' +
                '<td>' + escapeHtml(item.categoryName || '—') + '</td>' +
                '<td>' + escapeHtml(price) + '</td>' +
                '<td>' + flag(item.isDrinkCandidate) + '</td>' +
                '<td>' + flag(item.isExchangeProduct) + '</td>' +
                '<td>' + escapeHtml(item.iikoItemIdShort) + '</td>' +
                '<td>' + escapeHtml(item.iikoSizeIdShort || '—') + '</td>' +
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

        function applyCatalogScope(params) {
          var scope = el('catalogScope').value;
          params.set('drinkCandidatesOnly', scope === 'candidates' ? 'true' : 'false');
          params.set('sellableOnly', scope === 'candidates' ? 'true' : 'false');
          params.set('availableOnly', scope === 'candidates' ? 'true' : 'false');
          params.set('activeOnly', scope === 'candidates' ? 'true' : 'false');
          params.set('exchangeOnly', scope === 'exchange' ? 'true' : 'false');
          return params;
        }

        function loadProducts() {
          var params = applyCatalogScope(new URLSearchParams());
          params.set('page', String(productsState.page));
          params.set('pageSize', String(productsState.pageSize));
          if (el('search').value.trim()) { params.set('search', el('search').value.trim()); }
          var cat = el('categorySelect').value;
          if (cat) { params.set('category', cat); }
          return request('GET', '/api/v1/admin/products?' + params.toString()).then(function (data) {
            renderProducts(data.data);
            renderPagination(data.pagination);
          });
        }

        function loadCategories() {
          var params = new URLSearchParams();
          var candidates = el('catalogScope').value === 'candidates';
          params.set('drinkCandidatesOnly', candidates ? 'true' : 'false');
          params.set('sellableOnly', candidates ? 'true' : 'false');
          params.set('availableOnly', candidates ? 'true' : 'false');
          return request('GET', '/api/v1/admin/products/categories?' + params.toString()).then(function (data) {
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
            ['Товаров в источнике', data.sourceItemCount],
            ['Категорий напитков', data.drinkCategoryCount],
            ['Напитков-кандидатов', data.drinkCandidateCount],
            ['Кандидатов с числовой ценой', data.candidateWithFinitePriceCount],
            ['Кандидатов с положительной ценой', data.candidateWithPositivePriceCount],
            ['Сохранено (новых)', data.savedCount],
            ['Обновлено', data.updatedCount],
            ['Кандидатов с нулевой ценой', data.zeroPriceCandidateCount],
            ['Пропущено без item ID', data.skippedWithoutItemIdCount],
            ['Пропущено без цены', data.skippedWithoutPriceCount],
            ['Не напитки', data.nonDrinkItemCount],
            ['Помечено недоступными', data.unavailableCount],
            ['Товары биржи', 'выбираются администратором отдельно'],
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

        function renderParserSample(data) {
          var tbody = el('parserSampleTable').querySelector('tbody');
          var sample = data && data.samples && data.samples[0];
          if (!sample) {
            tbody.innerHTML = '<tr><td class="muted" colspan="2">Samples отсутствуют.</td></tr>';
            return;
          }
          var rows = [
            ['Товар', sample.itemName || '—'],
            ['Размер', sample.sizeName || '—'],
            ['Сырое значение цены', JSON.stringify(sample.priceValue)],
            ['Тип значения', sample.priceValueType],
            ['Number(value)', sample.javascriptNumberConversion === null ? '—' : sample.javascriptNumberConversion],
            ['Выбранное поле цены', sample.selectedPriceField || '—'],
            ['Преобразованная положительная цена', sample.coercedPositivePrice === null ? '—' : sample.coercedPositivePrice],
            ['Postman predicate', flag(sample.positiveByPostmanRule)],
            ['Первый price record', JSON.stringify(sample.firstPriceRaw)],
          ];
          tbody.innerHTML = rows
            .map(function (row) {
              return '<tr><th>' + escapeHtml(row[0]) + '</th><td>' + escapeHtml(row[1]) + '</td></tr>';
            })
            .join('');
        }

        function loadParserSample() {
          return request('GET', '/api/v1/admin/iiko/parser-sample').then(renderParserSample);
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
            renderStageTable('Стадия 2: полное меню (/api/2/menu/by_id)', data.menu);
        }
        el('btnIikoOrgs').addEventListener('click', function () {
          silent(request('POST', '/api/v1/admin/iiko/sync-organizations').then(loadOrganizations));
        });
        el('btnIikoMenu').addEventListener('click', function () {
          silent(
            request('POST', '/api/v1/admin/iiko/sync-menu').then(function (summary) {
              renderSyncSummary(summary);
              return Promise.all([loadCategories(), loadProducts(), loadParserSample()]);
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
        el('catalogScope').addEventListener('change', function () {
          productsState.page = 1;
          el('categorySelect').value = '';
          silent(Promise.all([loadCategories(), loadProducts()]));
        });
        el('btnResetFilters').addEventListener('click', function () {
          el('catalogScope').value = 'candidates';
          el('search').value = '';
          el('categorySelect').value = '';
          productsState.page = 1;
          silent(Promise.all([loadCategories(), loadProducts()]));
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
            return Promise.all([loadCategories(), loadProducts(), loadParserSample()]);
          }));
        }
      })();
    </script>

    <!-- Режим «Бармен»: независимая сессия по PIN, админ-ключ здесь не используется. -->
    <script>
      (function () {
        'use strict';
        var BASE = '/api/v1/bartender';
        var TOKEN_KEY = 'barExchangeBartenderToken';
        var EXPIRES_KEY = 'barExchangeBartenderExpires';
        var BASE_FILTERS = ['Все', 'Крепкий алкоголь', 'Бутылочное пиво', 'Коктейли'];

        var el = function (id) { return document.getElementById(id); };
        var mode = el('bartenderMode');
        var loginBox = el('bartenderLogin');
        var workspace = el('bartenderWorkspace');
        var loginMsg = el('bartenderLoginMsg');
        var grid = el('btGrid');
        var money = new Intl.NumberFormat('ru-RU');
        var state = { products: [], filter: 'Все', query: '', cards: {}, timer: null, roundEndsAt: null };

        function token() { return sessionStorage.getItem(TOKEN_KEY) || ''; }

        function setSession(value, expiresAt) {
          if (value) {
            sessionStorage.setItem(TOKEN_KEY, value);
            sessionStorage.setItem(EXPIRES_KEY, expiresAt || '');
          } else {
            sessionStorage.removeItem(TOKEN_KEY);
            sessionStorage.removeItem(EXPIRES_KEY);
          }
        }

        function api(method, path, body) {
          var headers = { 'x-bartender-token': token() };
          if (body) { headers['content-type'] = 'application/json'; }
          return fetch(BASE + path, {
            method: method,
            headers: headers,
            body: body ? JSON.stringify(body) : undefined,
          }).then(function (response) {
            return response.json().catch(function () { return {}; }).then(function (json) {
              if (response.status === 401 || response.status === 403) {
                setSession('');
                showLogin('Сессия истекла, войдите снова.');
                throw new Error('UNAUTHORIZED');
              }
              if (!response.ok) {
                var text = errorText(json, 'Ошибка запроса');
                setConnection(false);
                throw new Error(text);
              }
              setConnection(true);
              return json;
            });
          });
        }

        function errorText(json, fallback) {
          if (json) {
            if (json.error && typeof json.error === 'object' && json.error.message) return json.error.message;
            if (typeof json.message === 'string' && json.message) return json.message;
          }
          return fallback;
        }

        function setConnection(ok) {
          var node = el('btConn');
          node.className = 'status ' + (ok ? 'ok' : 'err');
          node.textContent = ok ? 'связь есть' : 'нет связи';
        }

        function openMode() {
          document.body.classList.add('bartender-active');
          mode.hidden = false;
          if (token()) { showWorkspace(); } else { showLogin(''); }
        }

        function closeMode() {
          stopPolling();
          document.body.classList.remove('bartender-active');
          mode.hidden = true;
        }

        function showLogin(text) {
          stopPolling();
          workspace.hidden = true;
          loginBox.hidden = false;
          loginMsg.textContent = text || '';
          loginMsg.className = text ? 'status err' : 'muted';
          el('bartenderPin').value = '';
          el('bartenderPin').focus();
        }

        function showWorkspace() {
          loginBox.hidden = true;
          workspace.hidden = false;
          renderFilters();
          refresh();
          startPolling();
        }

        function startPolling() {
          stopPolling();
          state.timer = window.setInterval(refresh, 20000);
        }

        function stopPolling() {
          if (state.timer) { window.clearInterval(state.timer); state.timer = null; }
        }

        function login() {
          var pin = el('bartenderPin').value.trim();
          if (!pin) { showLogin('Введите PIN.'); return; }
          fetch(BASE + '/auth', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ pin: pin }),
          }).then(function (response) {
            return response.json().catch(function () { return {}; }).then(function (json) {
              el('bartenderPin').value = '';
              if (!response.ok) {
                showLogin(errorText(json, 'Не удалось войти.'));
                return;
              }
              setSession(json.token, json.expiresAt);
              showWorkspace();
            });
          }).catch(function () { showLogin('Сеть недоступна.'); });
        }

        function logout() {
          var current = token();
          setSession('');
          showLogin('Вы вышли из панели.');
          if (!current) { return; }
          fetch(BASE + '/logout', { method: 'POST', headers: { 'x-bartender-token': current } })
            .catch(function () {});
        }

        function refresh() {
          return Promise.all([
            api('GET', '/exchange/products'),
            api('GET', '/exchange/status'),
          ]).then(function (results) {
            var products = results[0].products || [];
            products.forEach(function (product) {
              var card = cardState(product.id);
              if (!card.updatePending && !card.quantityEditing) {
                card.confirmedQuantity = product.salesQuantity;
                card.quantityDraft = String(product.salesQuantity);
              }
            });
            state.products = products;
            renderStatus(results[1]);
            renderFilters();
            renderGrid();
          }).catch(function () {});
        }

        function renderStatus(status) {
          var round = status.currentRound;
          state.roundEndsAt = round ? round.endsAt : null;
          el('btRound').textContent = 'раунд: ' + (round ? round.roundKey : '—') +
            (status.secondsRemaining === null || status.secondsRemaining === undefined
              ? ''
              : ' (' + Math.ceil(status.secondsRemaining / 60) + ' мин)');
          el('btUpdated').textContent = 'обновлено: ' + time(status.generatedAt) +
            ' · позиций: ' + status.activeProducts +
            ' · продаж в раунде: ' + status.currentRoundSales +
            ' · расчёт: ' + (status.running ? 'идёт' : 'пауза');
        }

        function categories() {
          var list = BASE_FILTERS.slice();
          state.products.forEach(function (product) {
            if (list.indexOf(product.category) === -1) { list.push(product.category); }
          });
          return list;
        }

        function renderFilters() {
          var box = el('btFilters');
          box.textContent = '';
          categories().forEach(function (name) {
            var button = document.createElement('button');
            button.type = 'button';
            button.textContent = name;
            button.setAttribute('aria-pressed', String(name === state.filter));
            button.addEventListener('click', function () {
              state.filter = name;
              renderFilters();
              renderGrid();
            });
            box.appendChild(button);
          });
        }

        function visibleProducts() {
          var query = state.query.trim().toLowerCase();
          return state.products.filter(function (product) {
            if (state.filter !== 'Все' && product.category !== state.filter) { return false; }
            if (!query) { return true; }
            return (product.name + ' ' + product.category).toLowerCase().indexOf(query) !== -1;
          });
        }

        function cardState(id) {
          if (!state.cards[id]) {
            state.cards[id] = {
              confirmedQuantity: 0,
              quantityDraft: '0',
              deltaDraft: '1',
              quantityEditing: false,
              updatePending: false,
              deltaConfirmed: '1',
              note: '',
              kind: '',
            };
          }
          return state.cards[id];
        }

        function discountLabel(value) {
          var rounded = Math.round(Number(value));
          return rounded < 0
            ? 'Наценка: +' + Math.abs(rounded) + '%'
            : 'Скидка: ' + rounded + '%';
        }

        function levelLabel(value) {
          var level = Number(value);
          return (level > 0 ? '+' : '') + Math.round(level) + '%';
        }

        function price(value) { return money.format(Number(value)) + ' ₸'; }

        function time(value) {
          if (!value) { return '—'; }
          var date = new Date(value);
          return isNaN(date.getTime()) ? '—' : date.toLocaleTimeString('ru-RU', { hour12: false });
        }

        function renderGrid() {
          var products = visibleProducts();
          grid.textContent = '';
          if (products.length === 0) {
            var empty = document.createElement('p');
            empty.className = 'muted';
            empty.textContent = 'Ничего не найдено.';
            grid.appendChild(empty);
            return;
          }
          products.forEach(function (product) { grid.appendChild(renderCard(product)); });
        }

        function renderCard(product) {
          var card = cardState(product.id);
          var node = document.createElement('div');
          node.className = 'bt-card';

          var title = document.createElement('h3');
          title.textContent = product.name;
          node.appendChild(title);

          var meta = document.createElement('div');
          meta.className = 'bt-cat';
          meta.textContent = product.category + (product.volumeMl ? ' · ' + product.volumeMl + ' мл' : '');
          node.appendChild(meta);

          var prices = document.createElement('div');
          prices.className = 'bt-prices';
          prices.appendChild(priceCell('Меню', price(product.originalPrice), ''));
          prices.appendChild(priceCell('Минимум', price(product.minPrice), ''));
          prices.appendChild(priceCell('Сейчас', price(product.currentPrice), 'bt-now'));
          prices.appendChild(priceCell('Уровень', levelLabel(product.priceLevelPercent), ''));
          prices.appendChild(priceCell('Скидка', discountLabel(product.currentDiscountPercent), ''));
          if (Number(product.currentPrice) === Number(product.minPrice)) {
            prices.appendChild(priceCell('Статус', 'Минимальная цена', 'status warn'));
          }
          node.appendChild(prices);

          var roundInfo = document.createElement('div');
          roundInfo.className = 'bt-cat';
          roundInfo.textContent = 'Раунд до: ' + time(state.roundEndsAt);
          node.appendChild(roundInfo);

          var salePrimary = document.createElement('div');
          salePrimary.className = 'bt-sale-primary';
          var saleBtn = document.createElement('button');
          saleBtn.type = 'button';
          saleBtn.className = 'bt-do-sale';
          saleBtn.textContent = 'Продано +1';
          saleBtn.disabled = card.updatePending;
          saleBtn.addEventListener('click', function () {
            if (card.updatePending) { return; }
            card.updatePending = true;
            saleBtn.disabled = true;
            saleBtn.textContent = 'Запись...';
            api('POST', '/exchange/products/' + product.id + '/sales/increment', { quantity: 1 })
              .then(function (result) {
                product.salesQuantity = result.quantity || result.salesQuantity || 0;
                card.confirmedQuantity = product.salesQuantity;
                card.quantityDraft = String(product.salesQuantity);
                card.quantityEditing = false;
                var msg = 'Продажа записана: ' + price(result.priceAtSale) +
                  ' · ' + discountLabel(result.discountPercentAtSale) +
                  ' · до ' + time(result.roundEndsAt);
                note(card, msg, 'ok');
              })
              .catch(function (error) { note(card, error.message, 'err'); })
              .finally(function () {
                card.updatePending = false;
                renderGrid();
              });
          });
          salePrimary.appendChild(saleBtn);
          var saleCounter = document.createElement('span');
          saleCounter.className = 'bt-count';
          saleCounter.appendChild(document.createTextNode('продажи: '));
          var saleCounterValue = document.createElement('b');
          saleCounterValue.textContent = String(product.salesQuantity);
          saleCounter.appendChild(saleCounterValue);
          salePrimary.appendChild(saleCounter);
          node.appendChild(salePrimary);

          var saleSecondary = document.createElement('div');
          saleSecondary.className = 'bt-sales';
          var quantityLabel = document.createElement('span');
          quantityLabel.className = 'bt-total-label';
          quantityLabel.textContent = 'Продано в текущем раунде';
          saleSecondary.appendChild(quantityLabel);
          var minus = document.createElement('button');
          minus.type = 'button';
          minus.textContent = '−';
          minus.setAttribute('aria-label', 'Убавить количество продаж');
          minus.disabled = card.updatePending;
          var quantity = document.createElement('input');
          quantity.type = 'number';
          quantity.min = '0';
          quantity.max = '9999';
          quantity.step = '1';
          quantity.inputMode = 'numeric';
          quantity.setAttribute('aria-label', 'Итоговое количество продаж');
          quantity.value = card.quantityEditing ? card.quantityDraft : String(card.confirmedQuantity);
          quantity.disabled = card.updatePending;
          quantity.addEventListener('input', function () {
            card.quantityEditing = true;
            card.quantityDraft = quantity.value;
          });
          quantity.addEventListener('change', function () { saveQuantity(product, card, quantity.value); });
          quantity.addEventListener('blur', function () {
            if (card.quantityEditing) { saveQuantity(product, card, quantity.value); }
          });
          quantity.addEventListener('keydown', function (event) {
            if (event.key === 'Enter') {
              event.preventDefault();
              saveQuantity(product, card, quantity.value);
            }
          });
          var plus = document.createElement('button');
          plus.type = 'button';
          plus.textContent = '+';
          plus.setAttribute('aria-label', 'Добавить количество продаж');
          plus.disabled = card.updatePending;
          var delta = document.createElement('input');
          delta.type = 'number';
          delta.min = '1';
          delta.max = '9999';
          delta.step = '1';
          delta.inputMode = 'numeric';
          delta.className = 'bt-delta-input';
          delta.setAttribute('aria-label', 'Количество для изменения');
          var deltaLabel = document.createElement('span');
          deltaLabel.className = 'bt-delta-label';
          deltaLabel.textContent = 'Изменить на:';
          delta.value = card.deltaDraft;
          delta.disabled = card.updatePending;
          var decrease = document.createElement('button');
          decrease.type = 'button';
          var increase = document.createElement('button');
          increase.type = 'button';
          function deltaValue() {
            var value = Number(delta.value);
            if (!Number.isSafeInteger(value) || value < 1 || value > 9999) {
              card.deltaDraft = card.deltaConfirmed;
              note(card, 'Изменение должно быть целым числом от 1 до 9999.', 'err');
              return null;
            }
            card.deltaDraft = String(value);
            card.deltaConfirmed = String(value);
            return value;
          }
          function refreshDeltaLabels() {
            var value = delta.value || 'N';
            decrease.textContent = 'Убавить ' + value;
            increase.textContent = 'Добавить ' + value;
          }
          delta.addEventListener('input', function () {
            card.deltaDraft = delta.value;
            refreshDeltaLabels();
          });
          delta.addEventListener('change', function () {
            var value = deltaValue();
            if (value !== null) { delta.value = String(value); }
            refreshDeltaLabels();
          });
          function changeByDelta(direction) {
            var value = deltaValue();
            if (value === null) { return; }
            if (card.updatePending) { return; }
            card.updatePending = true;
            delta.disabled = true;
            minus.disabled = true;
            plus.disabled = true;
            decrease.disabled = true;
            increase.disabled = true;
            var endpoint = direction > 0 ? 'increment' : 'decrement';
            api('POST', '/exchange/products/' + product.id + '/sales/' + endpoint, { quantity: value })
              .then(function (result) {
                product.salesQuantity = result.quantity || result.salesQuantity || 0;
                card.confirmedQuantity = product.salesQuantity;
                card.quantityDraft = String(product.salesQuantity);
                card.quantityEditing = false;
                note(card, 'Сохранено · ' + time(new Date()), 'ok');
              })
              .catch(function (error) {
                card.quantityDraft = String(card.confirmedQuantity);
                note(card, error.message, 'err');
              })
              .finally(function () {
                card.updatePending = false;
                renderGrid();
              });
          }
          minus.addEventListener('click', function () { changeByDelta(-1); });
          plus.addEventListener('click', function () { changeByDelta(1); });
          decrease.textContent = 'Убавить ' + (delta.value || 'N');
          increase.textContent = 'Добавить ' + (delta.value || 'N');
          decrease.addEventListener('click', function () { changeByDelta(-1); });
          increase.addEventListener('click', function () { changeByDelta(1); });
          saleSecondary.appendChild(minus);
          saleSecondary.appendChild(quantity);
          saleSecondary.appendChild(plus);
          saleSecondary.appendChild(deltaLabel);
          saleSecondary.appendChild(delta);
          saleSecondary.appendChild(decrease);
          saleSecondary.appendChild(increase);
          node.appendChild(saleSecondary);

          var stateLine = document.createElement('div');
          stateLine.className = 'bt-state ' + (card.kind || '');
          stateLine.textContent = card.note || 'Цена фиксирована до конца текущего раунда.';
          node.appendChild(stateLine);

          return node;
        }

        function priceCell(label, value, extraClass) {
          var cell = document.createElement('div');
          if (extraClass) { cell.className = extraClass; }
          cell.appendChild(document.createTextNode(label));
          var strong = document.createElement('b');
          strong.textContent = value;
          cell.appendChild(strong);
          return cell;
        }

        function saveQuantity(product, card, rawValue) {
          if (card.updatePending) { return; }
          var value = rawValue === '' ? 0 : Number(rawValue);
          if (!Number.isSafeInteger(value) || value < 0 || value > 9999) {
            card.quantityEditing = false;
            card.quantityDraft = String(card.confirmedQuantity);
            note(card, 'Количество должно быть целым числом от 0 до 9999.', 'err');
            return;
          }
          card.updatePending = true;
          card.quantityEditing = false;
          card.quantityDraft = String(value);
          api('PUT', '/exchange/products/' + product.id + '/sales/quantity', { quantity: value })
            .then(function (result) {
              product.salesQuantity = result.quantity;
              card.confirmedQuantity = result.quantity;
              card.quantityDraft = String(result.quantity);
              note(card, 'Сохранено · до ' + time(result.roundEndsAt), 'ok');
            })
            .catch(function (error) {
              card.quantityEditing = false;
              card.quantityDraft = String(card.confirmedQuantity);
              note(card, error.message, 'err');
            })
            .finally(function () {
              card.updatePending = false;
              renderGrid();
            });
        }

        function note(card, text, kind) {
          card.note = text;
          card.kind = kind;
          renderGrid();
        }

        function replaceProduct(updated) {
          state.products = state.products.map(function (product) {
            return product.id === updated.id ? updated : product;
          });
        }

        el('btnBartenderOpen').addEventListener('click', openMode);
        el('btnBartenderCancel').addEventListener('click', closeMode);
        el('btnBtAdmin').addEventListener('click', closeMode);
        el('btnBartenderLogin').addEventListener('click', login);
        el('bartenderPin').addEventListener('keydown', function (event) {
          if (event.key === 'Enter') { login(); }
        });
        el('btnBtLogout').addEventListener('click', logout);
        el('btnBtRefresh').addEventListener('click', function () { refresh(); });
        el('btnBtFullscreen').addEventListener('click', function () {
          if (document.fullscreenElement) {
            document.exitFullscreen();
          } else if (mode.requestFullscreen) {
            mode.requestFullscreen();
          }
        });
        el('btSearch').addEventListener('input', function (event) {
          state.query = event.target.value;
          renderGrid();
        });

        if (token()) { openMode(); }
      })();
    </script>
  </body>
</html>
`;
