/** Shift view backed exclusively by Command Center. No browser order/wallet storage. */
export const BARTENDER_OPERATIONS_SCRIPT = String.raw`
<script>
(function () {
  'use strict';
  var tab = 'exchange', scope = 'active', query = '', onlyBar = false;
  var orders = [], menu = [], updatedAt = null, error = '', busy = false, generation = 0;
  var panel = document.getElementById('btDemoPanel');
  var mode = document.getElementById('bartenderMode');
  var workspace = document.getElementById('bartenderWorkspace');
  var statuses = {new:'Новый',accepted:'Принят',preparing:'Готовится',delivered:'Доставлен',closed:'Закрыт',cancelled:'Отменён'};
  function money(value) { var amount = BigInt(value || '0'); return new Intl.NumberFormat('ru-RU').format(amount / 100n) + (amount % 100n ? ',' + String(amount % 100n).padStart(2,'0') : '') + ' ₸'; }
  function time(value) { return new Date(value).toLocaleString('ru-RU', {timeZone:'Asia/Almaty',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}); }
  function node(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
  function button(label, action, cls) { var b = node('button',cls,label); b.type='button'; b.addEventListener('click',action); return b; }
  function active() { return !document.hidden && !mode.hidden && !workspace.hidden && tab !== 'exchange'; }
  function token() { return sessionStorage.getItem('barExchangeBartenderToken') || ''; }
  function reset() { generation++; orders=[]; menu=[]; updatedAt=null; error=''; busy=false; panel.textContent=''; }
  function load() {
    if (!active() || !token() || busy) return;
    busy=true;
    var requestGeneration=++generation, requestToken=token();
    var path=tab==='menu'?'menu':'orders?scope='+scope;
    fetch('/api/v1/bartender/dining/'+path,{headers:{'x-bartender-token':requestToken},cache:'no-store',signal:AbortSignal.timeout(8000)})
      .then(function(r) { if (!r.ok) { if (r.status===401 || r.status===403) { reset(); throw new Error('Сессия истекла. Войдите снова.'); } throw new Error('Не удалось обновить данные. Проверьте соединение.'); } return r.json(); })
      .then(function(data) { if(requestGeneration!==generation || requestToken!==token()) return; if(path==='menu') menu=data.items; else orders=data.orders; error=data.hasMore?'Показаны последние 100 заказов. Полная история — в Command Center.':''; updatedAt=data.generatedAt; render(); })
      .catch(function(e) { if(requestGeneration!==generation || requestToken!==token()) return; error=e.message; render(); })
      .finally(function() { if(requestGeneration===generation) busy=false; });
  }
  function switchTab(next) {
    generation++; busy=false; tab=next; query=''; error=''; updatedAt=null;
    mode.setAttribute('data-tab',tab);
    document.querySelectorAll('[data-bt-tab]').forEach(function(b) {b.setAttribute('aria-selected',String(b.getAttribute('data-bt-tab')===tab));});
    document.querySelector('.bt-controls').hidden=tab!=='exchange';
    document.getElementById('btGrid').hidden=tab!=='exchange';
    document.getElementById('btGridMessage').hidden=tab!=='exchange';
    panel.hidden=tab==='exchange'; panel.scrollTop=0;
    render(); load();
  }
  function heading(title) {
    var head=node('header','bt-ops-head'); var copy=node('div'); copy.appendChild(node('h3','',title));
    copy.appendChild(node('p','',updatedAt?'Обновлено '+time(updatedAt)+' · каждые 15 секунд':'Получаем данные Command Center…')); head.appendChild(copy);
    head.appendChild(button('Обновить',load,'bt-ops-refresh')); panel.appendChild(head);
    if(error) { var msg=node('p','bt-ops-warning',error+(updatedAt?' Отображается последнее успешное обновление.':'')); msg.setAttribute('role','status'); panel.appendChild(msg); }
    var link=node('a','bt-ops-link','Открыть Command Center ↗'); link.href='https://hostess-command-center-production.up.railway.app'; link.target='_blank'; link.rel='noopener noreferrer'; panel.appendChild(link);
  }
  function tools() {
    var row=node('div','bt-ops-tools'); var search=node('input','bt-demo-search'); search.type='search'; search.placeholder=tab==='menu'?'Поиск по меню':'Стол, гость или номер заказа'; search.setAttribute('aria-label',search.placeholder); search.value=query;
    search.addEventListener('input',function(){query=search.value; render(); var next=panel.querySelector('input');next.focus();next.setSelectionRange(query.length,query.length);}); row.appendChild(search);
    if(tab!=='menu') { var select=node('select'); select.setAttribute('aria-label','Период заказов'); [['active','Активные заказы'],['recent','Последние заказы']].forEach(function(v){var option=node('option','',v[1]);option.value=v[0];option.selected=scope===v[0];select.appendChild(option);}); select.addEventListener('change',function(){scope=select.value;orders=[];updatedAt=null;generation++;busy=false;render();load();});row.appendChild(select);
      var bar=button(onlyBar?'Все позиции':'Только биржевые напитки',function(){onlyBar=!onlyBar;render();},'bt-ops-refresh');bar.setAttribute('aria-pressed',String(onlyBar));row.appendChild(bar); }
    panel.appendChild(row);
  }
  function orderCard(order) {
    var card=node('details','bt-order'); card.dataset.order=order.id;
    var summary=node('summary'); var lead=node('div'); lead.appendChild(node('strong','',order.tableName+' · №'+order.number)); lead.appendChild(node('small','',order.zoneName+' · '+time(order.acceptedAt))); summary.appendChild(lead);
    var side=node('div');side.appendChild(node('span','bt-order-status '+order.status,statuses[order.status]||order.status));side.appendChild(node('b','',money(order.payableMinor)));summary.appendChild(side);card.appendChild(summary);
    var body=node('div','bt-order-body');body.appendChild(node('p','bt-order-guest',order.guestName||'Гость без аккаунта'));
    var list=node('ul','bt-order-items');order.items.filter(function(i){return !onlyBar||i.itemType==='EXCHANGE';}).forEach(function(i){var line=node('li');var label=node('div');label.appendChild(node('strong','',i.name));label.appendChild(node('small','',(i.itemType==='EXCHANGE'?'Биржа · ':'Меню · ')+i.quantity+' × '+money(i.unitPriceMinor)));line.appendChild(label);line.appendChild(node('span','',money(i.totalMinor)));list.appendChild(line);});body.appendChild(list);
    if(onlyBar) body.appendChild(node('p','bt-ops-note','Показаны биржевые позиции. Итоги ниже относятся ко всему заказу.'));
    var totals=node('dl','bt-order-totals');[['Сумма заказа',order.subtotalMinor],['Списано бонусов',order.discountMinor],['К получению',order.payableMinor],['Кэшбэк по заказу',order.cashbackMinor]].forEach(function(v){totals.appendChild(node('dt','',v[0]));totals.appendChild(node('dd','',money(v[1])));});body.appendChild(totals);
    if(order.cashbackExpiresAt) body.appendChild(node('p','bt-ops-note','Срок бонусов: '+time(order.cashbackExpiresAt)));
    var payment=order.status==='cancelled'?'Заказ отменён · исходные суммы сохранены для истории':order.manualPaymentAt?'Получение оплаты отмечено сотрудником '+time(order.manualPaymentAt):'Оплата при обслуживании · получение денег ещё не отмечено';body.appendChild(node('p','bt-ops-note',payment));
    body.appendChild(node('p','bt-ops-note','Статус заказа, оплату и бонусы изменяют в Command Center. QR-продажи уже учитываются автоматически.'));card.appendChild(body);return card;
  }
  function filtered() {var q=query.toLocaleLowerCase('ru');return orders.filter(function(o){return (!onlyBar||o.items.some(function(i){return i.itemType==='EXCHANGE';}))&&(!q||[o.number,o.tableCode,o.tableName,o.zoneName,o.guestName].join(' ').toLocaleLowerCase('ru').includes(q));});}
  function renderOrders() {
    var list=filtered();if(!list.length){panel.appendChild(node('p','bt-ops-empty',updatedAt?'Заказов по выбранным условиям пока нет.':'Загрузка заказов…'));return;}
    if(tab==='tables'||tab==='clients'){
      var groups=new Map();list.forEach(function(o){var key=tab==='tables'?o.diningSessionId:(o.guestId||o.id);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(o);});
      groups.forEach(function(items){var group=node('section','bt-ops-group');var first=items[0];group.appendChild(node('h4','',tab==='tables'?first.tableName+' · '+first.zoneName:(first.guestName||'Гость без аккаунта')));var total=items.filter(function(o){return o.status!=='cancelled';}).reduce(function(sum,o){return sum+BigInt(o.payableMinor);},0n);group.appendChild(node('p','bt-ops-note',items.length+' заказ(а) · '+money(total.toString())+' по показанным заказам'+(tab==='tables'?' · один визит':'')));items.forEach(function(o){group.appendChild(orderCard(o));});panel.appendChild(group);});
    }else list.forEach(function(o){panel.appendChild(orderCard(o));});
  }
  function renderMenu() {
    var items=menu.filter(function(i){return (i.name+' '+i.category).toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru'));});
    if(!items.length){panel.appendChild(node('p','bt-ops-empty',updatedAt?'Опубликованных позиций нет. Каталог ведётся в Command Center.':'Загрузка меню…'));return;}
    var grid=node('div','bt-ops-menu');items.forEach(function(i){var card=node('article','bt-ops-product');if(i.imageUrl&&/^https:\/\//.test(i.imageUrl)){var img=node('img');img.src=i.imageUrl;img.alt=i.name;img.loading='lazy';img.referrerPolicy='no-referrer';card.appendChild(img);}var copy=node('div');copy.appendChild(node('small','',i.category+(i.portion?' · '+i.portion:'')));copy.appendChild(node('h4','',i.name));copy.appendChild(node('p','',i.description||''));copy.appendChild(node('b','',money(i.priceMinor)));if(!i.isAvailable)copy.appendChild(node('span','bt-order-status','Недоступно'));card.appendChild(copy);grid.appendChild(card);});panel.appendChild(grid);
  }
  function render() {
    if(tab==='exchange')return;
    var scroll=panel.scrollTop,open=new Set(Array.from(panel.querySelectorAll('details[open]')).map(function(d){return d.dataset.order;}));panel.textContent='';
    heading({orders:'QR-заказы',menu:'Меню XOXO',clients:'Гости и заказы',tables:'Заказы по визитам'}[tab]);tools();
    if(tab==='menu')renderMenu();else renderOrders();panel.querySelectorAll('details').forEach(function(d){d.open=open.has(d.dataset.order);});panel.scrollTop=scroll;
  }
  document.querySelectorAll('[data-bt-tab]').forEach(function(b){b.addEventListener('click',function(){switchTab(b.getAttribute('data-bt-tab'));});});
  document.getElementById('btnBtLogout').addEventListener('click',reset);
  document.addEventListener('visibilitychange',function(){if(!document.hidden)load();});
  new MutationObserver(function(){if(workspace.hidden)reset();else load();}).observe(workspace,{attributes:true,attributeFilter:['hidden']});
  window.setInterval(load,15000);
})();
</script>`;
