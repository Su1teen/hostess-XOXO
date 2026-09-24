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
    ['Тамерланский чай',2590,'Чай'],['Облепиховый чай',2590,'Чай'],['Малиновый чай',2590,'Чай'],['Смородиновый чай',2590,'Чай']
  ];
  var storageKey = 'xoxo:bartender:demo:v1';
  var seed = { orders: [
    { id: 'demo-1', date: '2026-09-14T20:30:00', targetType: 'client', targetId: 'sultan', items: [{ name: 'Mojito', price: 2800, quantity: 2 }, { name: 'Солёный арахис', price: 1500, quantity: 1 }], total: 7100, cashback: 355 },
    { id: 'demo-2', date: '2026-08-30T19:00:00', targetType: 'client', targetId: 'sultan', items: [{ name: 'Long Island', price: 3500, quantity: 1 }], total: 3500, cashback: 175 }
  ], customers: [{ id: 'sultan', name: 'Советов Султан', phone: '+7 (701) 000-00-00' }], tables: Array.from({ length: 12 }, function (_, i) { return { id: 'table-' + (i + 1), number: i + 1, seats: i < 4 ? 2 : i < 9 ? 4 : 6 }; }) };
  var data;
  try { data = JSON.parse(localStorage.getItem(storageKey)) || seed; } catch (_) { data = seed; }
  if (!data || !Array.isArray(data.orders) || !Array.isArray(data.customers) || !Array.isArray(data.tables)) data = seed;
  var cart = [];
  var tab = 'exchange';
  var category = 'Все';
  var query = '';
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
    render();
  }
  function heading(title, detail) { var head = node('div', 'bt-demo-head'); var copy = node('div'); copy.appendChild(node('h3', '', title)); copy.appendChild(node('p', '', detail)); head.appendChild(copy); panel.appendChild(head); }
  function renderMenu() {
    heading('Меню и чек', 'Выберите позиции, затем гостя или стол. Чек сохраняется в этом браузере.');
    var layout = node('div', 'bt-demo-layout'); var left = node('div'); var list = node('div', 'bt-demo-list');
    var search = node('input', 'bt-demo-search'); search.type = 'search'; search.placeholder = 'Найти напиток'; search.value = query; search.addEventListener('input', function () { query = search.value; render(); var focus = panel.querySelector('.bt-demo-search'); focus.focus(); focus.setSelectionRange(query.length, query.length); }); left.appendChild(search);
    var filters = node('div', 'bt-filters'); filters.style.cssText = 'display:flex;overflow-x:auto;gap:6px;margin:12px 0 16px';
    ['Все','Газировка','Коктейли','Разливные','Энергетики','Вода','Лимонады','Чай'].forEach(function (name) { var chip = button(name, function () { category = name; render(); }); chip.setAttribute('aria-pressed', String(category === name)); filters.appendChild(chip); }); left.appendChild(filters);
    menu.forEach(function (item, index) { if (category !== 'Все' && item[2] !== category) return; if (query && item[0].toLowerCase().indexOf(query.toLowerCase()) === -1) return; var card = node('article', 'bt-demo-card'); card.appendChild(node('strong', '', item[0])); card.appendChild(node('small', '', item[2])); card.appendChild(button('+ ' + format(item[1]), function () { var found = cart.find(function (row) { return row.index === index; }); if (found) found.quantity++; else cart.push({ index: index, quantity: 1 }); render(); })); list.appendChild(card); });
    if (!list.children.length) list.appendChild(node('p', '', 'Ничего не найдено'));
    left.appendChild(list); layout.appendChild(left);
    var side = node('aside', 'bt-demo-cart'); side.appendChild(node('strong', '', 'Новый чек'));
    var typeLabel = node('label', '', 'Кому пробить'); side.appendChild(typeLabel);
    var type = node('select'); [['client','Гостю'],['table','Столу']].forEach(function (entry) { var option = node('option', '', entry[1]); option.value = entry[0]; type.appendChild(option); }); type.value = targetType; type.addEventListener('change', function () { targetType = type.value; targetId = targetType === 'client' ? 'sultan' : 'table-1'; render(); }); side.appendChild(type);
    var targetLabel = node('label', '', targetType === 'client' ? 'Гость' : 'Стол'); side.appendChild(targetLabel);
    var target = node('select'); (targetType === 'client' ? data.customers : data.tables).forEach(function (entry) { var option = node('option', '', targetType === 'client' ? entry.name : 'Стол ' + entry.number + ' · ' + entry.seats + ' места'); option.value = entry.id; target.appendChild(option); }); target.value = targetId; target.addEventListener('change', function () { targetId = target.value; }); side.appendChild(target);
    var lines = node('div'); lines.style.marginTop = '18px'; cart.forEach(function (row) { var item = menu[row.index]; var line = node('div', 'bt-demo-cart-line'); line.appendChild(node('span', '', item[0] + ' ×' + row.quantity)); line.appendChild(node('span', '', format(item[1] * row.quantity))); line.appendChild(button('−', function () { row.quantity--; if (!row.quantity) cart = cart.filter(function (value) { return value !== row; }); render(); })); lines.appendChild(line); }); if (!cart.length) lines.appendChild(node('p', '', 'Выберите позиции из меню')); side.appendChild(lines);
    var total = cart.reduce(function (sum, row) { return sum + menu[row.index][1] * row.quantity; }, 0); var totalLine = node('div', 'bt-demo-total'); totalLine.appendChild(node('span', '', 'Итого')); totalLine.appendChild(node('span', '', format(total))); side.appendChild(totalLine);
    if (targetType === 'client' && targetId === 'sultan') side.appendChild(node('p', 'bt-demo-pill', 'Султан Советов · кэшбэк 5%: ' + format(Math.round(total * .05))));
    var checkout = button('Пробить чек', function () { if (!cart.length) return; data.orders.unshift({ id: String(Date.now()), date: new Date().toISOString(), targetType: targetType, targetId: targetId, items: cart.map(function (row) { return { name: menu[row.index][0], price: menu[row.index][1], quantity: row.quantity }; }), total: total, cashback: targetType === 'client' && targetId === 'sultan' ? Math.round(total * .05) : 0 }); cart = []; save(); render(); window.alert('Чек сохранён в демо · ' + format(total)); }, 'bt-demo-checkout'); checkout.disabled = !cart.length; side.appendChild(checkout); layout.appendChild(side); panel.appendChild(layout);
    if (cart.length) { var jump = button('Чек · ' + cart.reduce(function (sum, row) { return sum + row.quantity; }, 0) + ' поз. · ' + format(total), function () { side.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, 'bt-demo-jump'); panel.appendChild(jump); cartObserver = new IntersectionObserver(function (entries) { jump.hidden = entries[0].isIntersecting; }, { root: panel, threshold: .25 }); cartObserver.observe(side); }
  }
  function renderClients() { heading('Гости', 'История чеков и кэшбэк XOXO'); data.customers.forEach(function (client) { var orders = data.orders.filter(function (order) { return order.targetType === 'client' && order.targetId === client.id; }); var card = node('article', 'bt-demo-target'); card.appendChild(node('strong', '', client.name)); card.appendChild(node('p', '', client.phone || 'Телефон не указан')); card.appendChild(node('span', 'bt-demo-pill', orders.length + ' чеков · кэшбэк ' + format(orders.reduce(function (sum, order) { return sum + order.cashback; }, 0)))); orders.slice(0, 4).forEach(function (order) { card.appendChild(node('p', '', new Date(order.date).toLocaleDateString('ru-RU') + ' · ' + order.items.map(function (item) { return item.name + ' ×' + item.quantity; }).join(', ') + ' · ' + format(order.total))); }); panel.appendChild(card); }); }
  function renderTables() { heading('Столы', 'Откройте стол, чтобы пробить позиции из меню'); var list = node('div', 'bt-demo-list'); data.tables.forEach(function (table) { var orders = data.orders.filter(function (order) { return order.targetType === 'table' && order.targetId === table.id; }); var card = node('article', 'bt-demo-target'); card.appendChild(node('strong', '', 'Стол ' + table.number)); card.appendChild(node('p', '', table.seats + ' места · ' + orders.length + ' чеков')); if (orders.length) card.appendChild(node('span', 'bt-demo-pill', 'Последний чек ' + format(orders[0].total))); card.appendChild(button('Пробить на стол', function () { targetType = 'table'; targetId = table.id; switchTab('menu'); })); list.appendChild(card); }); panel.appendChild(list); }
  function render() { if (tab === 'exchange') return; if (cartObserver) { cartObserver.disconnect(); cartObserver = null; } panel.textContent = ''; if (tab === 'menu') renderMenu(); if (tab === 'clients') renderClients(); if (tab === 'tables') renderTables(); }
  document.querySelectorAll('[data-bt-tab]').forEach(function (item) { item.addEventListener('click', function () { switchTab(item.getAttribute('data-bt-tab')); }); });
})();
</script>`;
