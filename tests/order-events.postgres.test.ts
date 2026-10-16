import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env.js';
import { OrderEventsService, orderEventSchema } from '../src/modules/command-center/order-events.service.js';
import { orderEventsRoutes } from '../src/modules/command-center/order-events.routes.js';
import { RoundsService } from '../src/modules/rounds/rounds.service.js';
import { SalesService } from '../src/modules/sales/sales.service.js';
import { BartenderService } from '../src/modules/bartender/bartender.service.js';
import { ExchangeService } from '../src/modules/exchange/exchange.service.js';
import { publicRoutes } from '../src/modules/public-api/public.routes.js';
import { commandCenterRoutes } from '../src/modules/command-center/command.routes.js';
import { AuditService } from '../src/services/audit.service.js';

const url = process.env.QR_TEST_DATABASE_URL;
// Hard guard: this suite deletes fixtures, and must never accept an application DB.
if (url && !new URL(url).pathname.endsWith('/qr_integration_test')) throw new Error('Use isolated qr_integration_test database only');
describe.skipIf(!url)('QR events on real PostgreSQL', () => {
  const prisma = new PrismaClient({datasources:{db:{url:url ?? 'postgresql://localhost:1/qr_integration_test'}}});
  const env = parseEnv({DATABASE_URL:url ?? 'postgresql://localhost:1/qr_integration_test',ADMIN_API_KEY:'0123456789abcdef',QR_ORDER_EVENTS_ENABLED:'true',COMMAND_CENTER_SERVICE_KEY:'test-service-key-at-least-32-characters',ROUND_SCHEDULER_ENABLED:'false'});
  const logger = {info:()=>{},warn:()=>{},error:()=>{}};
  const audit = new AuditService(prisma,logger);
  const rounds = new RoundsService(prisma,env,audit,logger);
  const service = new OrderEventsService(prisma);
  let roundId='', productId='', organizationId='';
  const start = new Date('2026-10-16T13:00:00.000Z');
  const at = (minutes:number) => new Date(start.getTime()+minutes*60_000);
  function event(overrides:Record<string,unknown>={}) {
    return orderEventSchema.parse({eventId:randomUUID(),eventType:'ORDER_ACCEPTED',venueCode:'xoxo',orderId:randomUUID(),orderItemId:randomUUID(),exchangeProductId:productId,roundId,quantity:3,unitPrice:'1590.00',occurredAt:at(5).toISOString(),...overrides});
  }
  async function publish() { return rounds.transitionRound(at(15)); }
  beforeAll(async()=>{ await prisma.$connect(); });
  beforeEach(async()=>{
    await prisma.exchangeOrderDelivery.deleteMany(); await prisma.exchangeOrderEvent.deleteMany();
    await prisma.exchangeSale.deleteMany(); await prisma.roundPrice.deleteMany(); await prisma.priceRound.deleteMany();
    await prisma.exchangeProduct.deleteMany(); await prisma.auditLog.deleteMany(); await prisma.organization.deleteMany();
    organizationId=(await prisma.organization.create({data:{iikoOrganizationId:'qr-test',name:'XOXO test',isSelected:true}})).id;
    productId=(await prisma.exchangeProduct.create({data:{slug:'qr-test-drink',name:'Test drink',category:'Drinks',originalPrice:2000,startPrice:1590,currentPrice:1590,minPrice:1590,maxPrice:3000}})).id;
    roundId=(await prisma.priceRound.create({data:{organizationId,roundKey:'qr-origin',startsAt:start,endsAt:at(15),timezone:'Asia/Almaty',status:'PUBLISHED',publishedAt:start,algorithmVersion:'test',triggerSource:'TEST',prices:{create:{exchangeProductId:productId,price:1590,publishedPrice:1590,calculatedPrice:1590,minPrice:1590,maxPrice:3000,priceStep:50,changePercent:0,calculationInput:{},calculationResult:{},status:'PUBLISHED'}}}})).id;
  });
  afterAll(async()=>{ await prisma.$disconnect(); });
  it('counts three units once across event ID, semantic duplicate and alias retries',async()=>{
    const input=event();
    expect(await service.ingest(input,at(6))).toMatchObject({accepted:true,alreadyProcessed:false});
    expect(await service.ingest(input,at(7))).toMatchObject({alreadyProcessed:true});
    const alias={...input,eventId:randomUUID()};
    expect(await service.ingest(alias,at(7))).toMatchObject({alreadyProcessed:true,eventId:alias.eventId});
    await expect(service.ingest({...alias,quantity:4},at(8))).rejects.toMatchObject({code:'EVENT_ID_CONFLICT'});
    expect(await prisma.exchangeOrderEvent.count()).toBe(1);
    const next=await publish();
    expect(Number(next!.prices[0]!.salesQuantity)).toBe(3);
    expect((await prisma.exchangeOrderEvent.findFirstOrThrow()).unitPriceSnapshot.toFixed(2)).toBe('1590.00');
    expect((await prisma.exchangeOrderEvent.findFirstOrThrow()).appliedToRoundId).toBe(next!.id);
    expect(await prisma.exchangeSale.count()).toBe(0);
  });
  it('serializes concurrent duplicate delivery and round publication at the boundary',async()=>{
    const input=event({occurredAt:at(14.999).toISOString()});
    const acks=await Promise.all(Array.from({length:8},()=>service.ingest(input,at(15))));
    expect(acks.filter(a=>!a.alreadyProcessed)).toHaveLength(1);
    const [one,two]=await Promise.all([publish(),publish()]);
    expect(one!.id).toBe(two!.id);
    expect(Number(one!.prices[0]!.salesQuantity)).toBe(3);
  });
  it('rejects conflicting payload and semantic identity reuse',async()=>{
    const input=event(); await service.ingest(input,at(6));
    await expect(service.ingest({...input,quantity:4},at(7))).rejects.toMatchObject({code:'EVENT_ID_CONFLICT',retryable:false});
    await expect(service.ingest({...input,eventId:randomUUID(),orderId:randomUUID()},at(7))).rejects.toMatchObject({code:'ORDER_ITEM_CONFLICT'});
  });
  it.each(['product','round','price','time'])('rejects invalid %s without storing demand',async kind=>{
    const invalid=event(kind==='product'?{exchangeProductId:randomUUID()}:kind==='round'?{roundId:randomUUID()}:kind==='price'?{unitPrice:'1000.00'}:{occurredAt:at(15).toISOString()});
    await expect(service.ingest(invalid,at(16))).rejects.toMatchObject({retryable:false});
    expect(await prisma.exchangeOrderEvent.count()).toBe(0);
  });
  it('compensates a full cancellation once without negative demand',async()=>{
    const input=event(); await service.ingest(input,at(6));
    const cancel={...input,eventId:randomUUID(),eventType:'ORDER_CANCELLED' as const,occurredAt:at(8).toISOString()};
    await service.ingest(cancel,at(8)); await service.ingest(cancel,at(9));
    const next=await publish(); expect(Number(next!.prices[0]!.salesQuantity)).toBe(0);
    expect((await service.diagnostics(roundId)).reconciliation[0]?.qrQuantity).toBe(0);
  });
  it('retries cancellation preceding acceptance and rejects unknown order/mismatched quantity',async()=>{
    const input=event(); const cancel={...input,eventId:randomUUID(),eventType:'ORDER_CANCELLED' as const,occurredAt:at(8).toISOString()};
    await expect(service.ingest(cancel,at(8))).rejects.toMatchObject({code:'ACCEPTANCE_NOT_RECEIVED',retryable:true});
    await service.ingest(input,at(9));
    await expect(service.ingest({...cancel,quantity:2},at(9))).rejects.toMatchObject({code:'CANCELLATION_MISMATCH'});
    await expect(service.ingest({...cancel,orderId:randomUUID()},at(9))).rejects.toMatchObject({code:'CANCELLATION_MISMATCH'});
    expect(await service.ingest(cancel,at(9))).toMatchObject({accepted:true});
  });
  it('carries late delivery into the next unpublished round without changing published history',async()=>{
    const first=await publish(); const before=await prisma.roundPrice.findMany({where:{roundId:first!.id}});
    const input=event({occurredAt:at(14.99).toISOString()}); await service.ingest(input,at(15.05));
    expect((await prisma.exchangeOrderEvent.findFirstOrThrow()).roundId).toBe(roundId);
    const second=await rounds.transitionRound(at(30)); expect(Number(second!.prices[0]!.salesQuantity)).toBe(3);
    expect(await prisma.roundPrice.findMany({where:{roundId:first!.id}})).toEqual(before);
    const third=await rounds.transitionRound(at(45)); expect(Number(third!.prices[0]!.salesQuantity)).toBe(0);
  });
  it('makes a post-consumption cancellation historical only and persists after client restart',async()=>{
    const input=event(); await service.ingest(input,at(6)); const first=await publish();
    await prisma.$disconnect(); await prisma.$connect();
    expect(await new OrderEventsService(prisma).ingest(input,at(16))).toMatchObject({alreadyProcessed:true});
    await service.ingest({...input,eventId:randomUUID(),eventType:'ORDER_CANCELLED',occurredAt:at(17).toISOString()},at(17));
    const second=await rounds.transitionRound(at(30)); expect(Number(second!.prices[0]!.salesQuantity)).toBe(0);
    expect(Number((await rounds.getRound(first!.id)).prices[0]!.salesQuantity)).toBe(3);
    expect(await prisma.exchangeOrderEvent.count({where:{processingStatus:'HISTORICAL_ONLY'}})).toBe(1);
  });
  it('keeps an existing published round immutable and carries pending demand forward',async()=>{
    const input=event(); await service.ingest(input,at(6));
    const existing=await prisma.priceRound.create({data:{organizationId,roundKey:'2026-10-16-18-15-Asia-Almaty',startsAt:at(15),endsAt:at(30),timezone:'Asia/Almaty',status:'PUBLISHED',publishedAt:at(15),algorithmVersion:'test',triggerSource:'TEST'}});
    expect((await publish())!.id).toBe(existing.id);
    expect(await prisma.exchangeOrderEvent.count({where:{processingStatus:'PENDING'}})).toBe(1);
    expect(Number((await rounds.transitionRound(at(30)))!.prices[0]!.salesQuantity)).toBe(3);
  });
  it('classifies HTTP conflict errors and exposes only authenticated diagnostics',async()=>{
    const app=fastify(); app.decorate('env',env); app.decorate('prisma',prisma); await app.register(orderEventsRoutes);
    const input=event(); const headers={'x-command-center-key':env.COMMAND_CENTER_SERVICE_KEY!};
    expect((await app.inject({method:'POST',url:'/api/v1/command-center/order-events',headers,payload:input})).statusCode).toBe(200);
    const response=await app.inject({method:'POST',url:'/api/v1/command-center/order-events',headers,payload:{...input,quantity:5}});
    expect(response.statusCode).toBe(409); expect(response.json().error.retryable).toBe(false);
    const diag=await app.inject({url:'/api/v1/command-center/order-events/diagnostics?roundId='+roundId,headers});
    expect(diag.json().rejectedAttempts).toBe(1);
    expect((await app.inject({url:'/api/v1/command-center/order-events/diagnostics'})).statusCode).toBe(401);
    await app.close();
  });
  it('regresses manual increment/decrement, bartender, snapshot and combined demand',async()=>{
    const activeStart=new Date(Date.now()-5*60_000), activeEnd=new Date(Date.now()+10*60_000);
    await prisma.priceRound.update({where:{id:roundId},data:{startsAt:activeStart,endsAt:activeEnd}});
    const manual=new SalesService(prisma); await manual.increment(roundId,productId,2); await manual.increment(roundId,productId,3); await manual.decrement(roundId,productId,1);
    const input=event({occurredAt:new Date().toISOString()}); await service.ingest(input);
    const exchange=new ExchangeService(prisma,rounds,logger); const bartender=new BartenderService(prisma,exchange,audit,logger);
    expect((await bartender.listProducts()).products[0]).toMatchObject({salesQuantity:4,manualSalesQuantity:4,qrSalesQuantity:3});
    const app=fastify(); app.decorate('env',env); app.decorate('prisma',prisma); app.decorate('services',{rounds,exchange} as never);
    await app.register(publicRoutes); await app.register(commandCenterRoutes);
    expect((await app.inject({url:'/api/v1/public/snapshot'})).json()).toMatchObject({status:'ok',currentRound:{id:roundId},products:[{id:productId,price:1590}]});
    for (const path of ['current-round','products']) expect((await app.inject({url:'/api/v1/public/'+path})).statusCode).toBe(200);
    const stats=await app.inject({url:'/api/v1/command-center/sales',headers:{'x-command-center-key':env.COMMAND_CENTER_SERVICE_KEY!}});
    expect(stats.json().kpis).toMatchObject({itemsSold:7,ordersCount:null,averageCheck:null,qrOrdersCount:1});
    await app.close();
    const next=await rounds.transitionRound(new Date(activeEnd.getTime()+15*60_000));
    expect(Number(next!.prices[0]!.salesQuantity)).toBe(7);
  });
  it('returns a retryable HTTP error against an actually unavailable PostgreSQL port',async()=>{
    const offline=new PrismaClient({datasources:{db:{url:'postgresql://postgres:test@127.0.0.1:1/qr_integration_test?connect_timeout=1'}}});
    const app=fastify(); app.decorate('env',env); app.decorate('prisma',offline); await app.register(orderEventsRoutes);
    const response=await app.inject({method:'POST',url:'/api/v1/command-center/order-events',headers:{'x-command-center-key':env.COMMAND_CENTER_SERVICE_KEY!},payload:event()});
    expect(response.statusCode).toBe(503); expect(response.json().error.retryable).toBe(true);
    await app.close(); await offline.$disconnect();
  });
});
