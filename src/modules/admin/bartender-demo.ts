/** Browser-only menu and checkout. It never calls iiko or the exchange sales API. */
export const BARTENDER_DEMO_SCRIPT = String.raw`
<script>
(function () {
  'use strict';
  var menu = [
    ['Coca-Cola · 250 мл',1100,'Газировка'],['Coca-Cola · 500 мл',1000,'Газировка'],['Coca-Cola · 1 л',1500,'Газировка'],['Coca-Cola · 1,5 л',1800,'Газировка'],['Coca-Cola · 2 л',2300,'Газировка'],
    ['Fanta · 250 мл',1100,'Газировка'],['Fanta · 500 мл',1000,'Газировка'],['Fanta · 1 л',1500,'Газировка'],['Fanta · 1,5 л',1800,'Газировка'],['Fanta · 2 л',2300,'Газировка'],
    ['Sprite · 250 мл',1100,'Газировка'],['Sprite · 500 мл',1000,'Газировка'],['Sprite · 1 л',1500,'Газировка'],['Sprite · 1,5 л',1800,'Газировка'],['Sprite · 2 л',2300,'Газировка'],['Fuse Tea',1500,'Газировка'],
    ['Red Bull Vodka',3200,'Коктейли'],['Red Bull Jäger',3200,'Коктейли'],['Gin Tonic',3200,'Коктейли'],['Red Bull Whisky',3200,'Коктейли'],['Mojito',2800,'Коктейли'],['Long Island',3500,'Коктейли'],['Whisky Sour',3200,'Коктейли'],
    ['Квас',890,'Разливные'],['Лимонад',890,'Разливные'],['Немецкое · 500 мл',1190,'Разливные'],['Немецкое · 3 л',6000,'Разливные'],['Carlsberg · 500 мл',1500,'Разливные'],['Carlsberg · 3 л',8500,'Разливные'],
    ['Gorilla',1500,'Энергетики'],['Dizzy',1500,'Энергетики'],['Red Bull',2000,'Энергетики'],
    ['Borjomi',2000,'Вода'],['Tassay · 250 мл',900,'Вода'],['Tassay · 500 мл',900,'Вода'],['Tassay газ · 500 мл',900,'Вода'],['Tassay · 1 л',1500,'Вода'],['Сарыагаш',1000,'Вода'],
    ['Ягодный',2490,'Лимонады'],['Арбузный',2490,'Лимонады'],['Манго-маракуйя',2490,'Лимонады'],['Киви-лайм',2490,'Лимонады'],['Мохито',2490,'Лимонады'],
    ['Тамерланский чай',2590,'Чай'],['Облепиховый чай',2590,'Чай'],['Малиновый чай',2590,'Чай'],['Смородиновый чай',2590,'Чай'],
    ['Maxi Чай',1500,'Чай'],['Натуральный сок',2500,'Соки'],['Tassay · 500 мл стекло',1000,'Вода']
  ];
  var storageKey = 'xoxo:bartender:demo:v1';
  var seed = { orders: [
    { id: 'demo-1', date: '2026-09-14T20:30:00', targetType: 'client', targetId: 'sultan', items: [{ name: 'Mojito', price: 2800, quantity: 2 }, { name: 'Солёный арахис', price: 1500, quantity: 1 }], total: 7100, cashback: 355 },
    { id: 'demo-2', date: '2026-08-30T19:00:00', targetType: 'client', targetId: 'sultan', items: [{ name: 'Long Island', price: 3500, quantity: 1 }], total: 3500, cashback: 175 }
  ], customers: [{ id: 'sultan', name: 'Советов Султан', phone: '+7 (701) 000-00-00' }], tables: Array.from({ length: 12 }, function (_, i) { return { id: 'table-' + (i + 1), number: i + 1, seats: i < 4 ? 2 : i < 9 ? 4 : 6 }; }) };
  var data;
  try { data = JSON.parse(localStorage.getItem(storageKey)) || seed; } catch (_) { data = seed; }
  if (!data || !Array.isArray(data.orders) || !Array.isArray(data.customers) || !Array.isArray(data.tables)) data = seed;
  data.tables = data.tables.slice(0, 6);
  while (data.tables.length < 6) { var number = data.tables.length + 1; data.tables.push({ id: 'table-' + number, number: number, seats: number <= 2 ? 2 : 4 }); }
  try { localStorage.setItem(storageKey, JSON.stringify(data)); } catch (_) {}
  var cart = [];
  var tab = 'exchange';
  var category = 'Все';
  var query = '';
  var openGroups = {};
  var targetType = 'client';
  var targetId = 'sultan';
  var cartObserver = null;
  var panel = document.getElementById('btDemoPanel');
  var format = function (value) { return new Intl.NumberFormat('ru-RU').format(value) + ' ₸'; };
  function save() { try { localStorage.setItem(storageKey, JSON.stringify(data)); } catch (_) {} }
  function node(tag, className, text) { var element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; }
  function button(label, action, className) { var element = node('button', className, label); element.type = 'button'; element.addEventListener('click', action); return element; }
  function switchTab(next) {
    tab = next;
    document.getElementById('bartenderMode').setAttribute('data-tab', tab);
    document.querySelectorAll('[data-bt-tab]').forEach(function (item) { item.setAttribute('aria-selected', String(item.getAttribute('data-bt-tab') === tab)); });
    document.querySelector('.bt-controls').hidden = tab !== 'exchange';
    document.getElementById('btGrid').hidden = tab !== 'exchange';
    document.getElementById('btGridMessage').hidden = tab !== 'exchange';
    panel.hidden = tab === 'exchange';
    panel.scrollTop = 0;
    render();
  }
  function heading(title, detail) { var head = node('div', 'bt-demo-head'); var copy = node('div'); copy.appendChild(node('h3', '', title)); copy.appendChild(node('p', '', detail)); head.appendChild(copy); panel.appendChild(head); }
  function renderMenu() {
    heading('Меню', 'Выберите напитки и оформите чек');
    var layout = node('div', 'bt-demo-layout');
    var left = node('div');
    var tools = node('div', 'bt-demo-catalog-tools');
    var search = node('input', 'bt-demo-search');
    search.type = 'search';
    search.placeholder = 'Поиск по меню';
    search.setAttribute('aria-label', 'Поиск по меню');
    search.value = query;
    search.addEventListener('input', function () {
      query = search.value;
      render();
      var focus = panel.querySelector('.bt-demo-search');
      focus.focus();
      focus.setSelectionRange(query.length, query.length);
    });
    tools.appendChild(search);
    var filters = node('div', 'bt-filters');
    ['Все', 'Коктейли', 'Разливные', 'Газировка', 'Энергетики', 'Вода', 'Лимонады', 'Чай', 'Соки'].forEach(function (name) {
      var chip = button(name, function () { category = name; render(); });
      chip.setAttribute('aria-pressed', String(category === name));
      filters.appendChild(chip);
    });
    tools.appendChild(filters);
    left.appendChild(tools);
    var list = node('div', 'bt-demo-list');
    var groups = ['Коктейли', 'Разливные', 'Газировка', 'Энергетики', 'Вода', 'Лимонады', 'Чай', 'Соки'];
    function add(index) {
      var found = cart.find(function (row) { return row.index === index; });
      if (found) found.quantity++;
      else cart.push({ index: index, quantity: 1 });
      render();
    }
    function simpleRow(item, index) {
      var row = node('article', 'bt-demo-card');
      var copy = node('div', 'bt-demo-card-copy');
      copy.appendChild(node('strong', '', item[0]));
      row.appendChild(copy);
      var action = node('div', 'bt-demo-card-action');
      action.appendChild(node('span', 'bt-demo-price', format(item[1])));
      var addButton = button('+', function () { add(index); });
      addButton.setAttribute('aria-label', 'Добавить ' + item[0]);
      action.appendChild(addButton);
      row.appendChild(action);
      return row;
    }
    groups.forEach(function (group) {
      if (category !== 'Все' && category !== group) return;
      var matches = menu.map(function (item, index) { return { item: item, index: index }; }).filter(function (entry) {
        return entry.item[2] === group && (!query || entry.item[0].toLowerCase().indexOf(query.toLowerCase()) !== -1);
      });
      if (!matches.length) return;
      list.appendChild(node('div', 'bt-demo-section', group));
      var used = {};
      matches.forEach(function (entry) {
        var item = entry.item;
        var brand = group === 'Газировка' ? ['Coca-Cola', 'Fanta', 'Sprite'].find(function (name) { return item[0].indexOf(name + ' ·') === 0; }) : null;
        if (!brand) { list.appendChild(simpleRow(item, entry.index)); return; }
        if (used[brand]) return;
        used[brand] = true;
        var variants = matches.filter(function (other) { return other.item[0].indexOf(brand + ' ·') === 0; });
        var detail = node('details', 'bt-demo-group');
        detail.open = !!openGroups[brand];
        detail.addEventListener('toggle', function () { openGroups[brand] = detail.open; });
        var summary = node('summary');
        summary.appendChild(node('strong', '', brand));
        var priceLine = node('div', 'bt-demo-card-action');
        priceLine.appendChild(node('span', 'bt-demo-price', 'от ' + format(Math.min.apply(null, variants.map(function (variant) { return variant.item[1]; })))));
        summary.appendChild(priceLine);
        detail.appendChild(summary);
        variants.forEach(function (variant) {
          var size = variant.item[0].split(' · ')[1];
          var row = node('div', 'bt-demo-variant');
          row.appendChild(node('span', '', size));
          var action = node('div', 'bt-demo-card-action');
          action.appendChild(node('span', 'bt-demo-price', format(variant.item[1])));
          var addButton = button('+', function () { add(variant.index); });
          addButton.setAttribute('aria-label', 'Добавить ' + variant.item[0]);
          action.appendChild(addButton);
          row.appendChild(action);
          detail.appendChild(row);
        });
        list.appendChild(detail);
      });
    });
    if (!list.children.length) list.appendChild(node('p', 'bt-demo-empty', 'Позиции не найдены'));
    left.appendChild(list);
    layout.appendChild(left);

    var side = node('aside', 'bt-demo-cart');
    side.appendChild(node('strong', '', 'Новый чек'));
    side.appendChild(node('label', '', 'Оформить на'));
    var type = node('select');
    [['client', 'Гость'], ['table', 'Стол']].forEach(function (entry) {
      var option = node('option', '', entry[1]); option.value = entry[0]; type.appendChild(option);
    });
    type.value = targetType;
    type.setAttribute('aria-label', 'Оформить на гостя или стол');
    type.addEventListener('change', function () { targetType = type.value; targetId = targetType === 'client' ? 'sultan' : 'table-1'; render(); });
    side.appendChild(type);
    side.appendChild(node('label', '', targetType === 'client' ? 'Гость' : 'Стол'));
    var target = node('select');
    (targetType === 'client' ? data.customers : data.tables).forEach(function (entry) {
      var option = node('option', '', targetType === 'client' ? entry.name : 'Стол ' + entry.number + ' · ' + entry.seats + ' места');
      option.value = entry.id;
      target.appendChild(option);
    });
    target.value = targetId;
    target.setAttribute('aria-label', targetType === 'client' ? 'Выбрать гостя' : 'Выбрать стол');
    target.addEventListener('change', function () { targetId = target.value; render(); });
    side.appendChild(target);
    var lines = node('div');
    lines.style.marginTop = '20px';
    cart.forEach(function (cartRow) {
      var item = menu[cartRow.index];
      var line = node('div', 'bt-demo-cart-line');
      line.appendChild(node('span', '', item[0] + ' ×' + cartRow.quantity));
      line.appendChild(node('span', '', format(item[1] * cartRow.quantity)));
      var remove = button('−', function () {
        cartRow.quantity--;
        if (!cartRow.quantity) cart = cart.filter(function (value) { return value !== cartRow; });
        render();
      });
      remove.setAttribute('aria-label', 'Убрать одну порцию ' + item[0]);
      line.appendChild(remove);
      lines.appendChild(line);
    });
    if (!cart.length) lines.appendChild(node('p', 'bt-demo-empty', 'Добавьте позиции из меню'));
    side.appendChild(lines);
    var total = cart.reduce(function (sum, row) { return sum + menu[row.index][1] * row.quantity; }, 0);
    var totalLine = node('div', 'bt-demo-total');
    totalLine.appendChild(node('span', '', 'Итого'));
    totalLine.appendChild(node('span', '', format(total)));
    side.appendChild(totalLine);
    if (targetType === 'client' && targetId === 'sultan') side.appendChild(node('div', 'bt-demo-pill', 'Кэшбэк Султана · 5% · ' + format(Math.round(total * .05))));
    var checkout = button('Пробить чек', function () {
      if (!cart.length) return;
      data.orders.unshift({ id: String(Date.now()), date: new Date().toISOString(), targetType: targetType, targetId: targetId,
        items: cart.map(function (row) { return { name: menu[row.index][0], price: menu[row.index][1], quantity: row.quantity }; }),
        total: total, cashback: targetType === 'client' && targetId === 'sultan' ? Math.round(total * .05) : 0 });
      cart = [];
      save();
      render();
      var notice = node('div', 'bt-demo-success', 'Чек сохранён · ' + format(total));
      panel.querySelector('.bt-demo-cart').appendChild(notice);
    }, 'bt-demo-checkout');
    checkout.disabled = !cart.length;
    side.appendChild(checkout);
    layout.appendChild(side);
    panel.appendChild(layout);
    if (cart.length) {
      var jump = button('Чек · ' + format(total), function () { side.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, 'bt-demo-jump');
      panel.appendChild(jump);
      if ('IntersectionObserver' in window) {
        cartObserver = new IntersectionObserver(function (entries) { jump.hidden = entries[0].isIntersecting; }, { root: panel, threshold: .25 });
        cartObserver.observe(side);
      }
    }
  }
  function countLabel(count, one, few, many) {
    var mod10 = count % 10;
    var mod100 = count % 100;
    return count + ' ' + (mod10 === 1 && mod100 !== 11 ? one : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many);
  }
  function renderClients() {
    heading('Гости', 'Чеки и кэшбэк XOXO');
    var list = node('div', 'bt-demo-people');
    data.customers.forEach(function (client) {
      var orders = data.orders.filter(function (order) { return order.targetType === 'client' && order.targetId === client.id; });
      var card = node('article', 'bt-demo-target bt-demo-person');
      var head = node('div', 'bt-demo-person-head');
      var person = node('div');
      person.appendChild(node('strong', '', client.name));
      person.appendChild(node('p', '', client.phone || 'Телефон не указан'));
      head.appendChild(person);
      var earned = orders.reduce(function (sum, order) { return sum + order.cashback; }, 0);
      var balance = node('div', 'bt-demo-balance');
      balance.appendChild(node('small', '', 'Кэшбэк'));
      balance.appendChild(node('b', '', format(earned)));
      head.appendChild(balance);
      card.appendChild(head);
      var history = node('div', 'bt-demo-history');
      history.appendChild(node('div', 'bt-demo-history-title', countLabel(orders.length, 'чек', 'чека', 'чеков')));
      orders.slice(0, 6).forEach(function (order) {
        var line = node('div', 'bt-demo-history-line');
        var copy = node('div');
        copy.appendChild(node('span', '', new Date(order.date).toLocaleDateString('ru-RU')));
        copy.appendChild(node('small', '', order.items.map(function (item) { return item.name + ' ×' + item.quantity; }).join(', ')));
        line.appendChild(copy);
        line.appendChild(node('b', '', format(order.total)));
        history.appendChild(line);
      });
      card.appendChild(history);
      card.appendChild(button('Новый чек', function () { targetType = 'client'; targetId = client.id; switchTab('menu'); }, 'bt-demo-secondary'));
      list.appendChild(card);
    });
    panel.appendChild(list);
  }
  function renderTables() {
    heading('Столы', 'Выберите стол для нового чека');
    var list = node('div', 'bt-demo-table-grid');
    data.tables.forEach(function (table) {
      var orders = data.orders.filter(function (order) { return order.targetType === 'table' && order.targetId === table.id; });
      var card = node('article', 'bt-demo-target bt-demo-table');
      card.appendChild(node('strong', '', 'Стол ' + table.number));
      card.appendChild(node('p', '', countLabel(table.seats, 'место', 'места', 'мест') + ' · ' + countLabel(orders.length, 'чек', 'чека', 'чеков')));
      if (orders.length) card.appendChild(node('span', 'bt-demo-pill', 'Последний · ' + format(orders[0].total)));
      card.appendChild(button('Открыть чек →', function () { targetType = 'table'; targetId = table.id; switchTab('menu'); }, 'bt-demo-secondary'));
      list.appendChild(card);
    });
    panel.appendChild(list);
  }
  function render() { if (tab === 'exchange') return; var scroll = panel.scrollTop; if (cartObserver) { cartObserver.disconnect(); cartObserver = null; } panel.textContent = ''; if (tab === 'menu') renderMenu(); if (tab === 'clients') renderClients(); if (tab === 'tables') renderTables(); panel.scrollTop = scroll; }
  document.querySelectorAll('[data-bt-tab]').forEach(function (item) { item.addEventListener('click', function () { switchTab(item.getAttribute('data-bt-tab')); }); });
})();
</script>`;
