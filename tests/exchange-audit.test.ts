import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { applyQrPreview } from '../src/modules/command-center/order-events.service.js';
import { RoundsService } from '../src/modules/rounds/rounds.service.js';

const cutoff = new Date('2026-10-16T13:15:00Z');
const accepted = {id:'accepted',eventType:'ORDER_ACCEPTED',exchangeProductId:'drink',quantity:3,processingStatus:'PENDING'};
const prices = [{calculationInput:{qrDemandEventIds:['accepted']}}];
function fixture(events: unknown[]) {
  const tx={exchangeOrderEvent:{findMany:vi.fn(async()=>events),findUnique:vi.fn(async()=>accepted),count:vi.fn(async()=>1),updateMany:vi.fn(async()=>({count:1}))}};
  return tx;
}
describe('exchange audit: preview consistency',()=>{
  it('rejects a cancellation that arrived after the captured acceptance',async()=>{
    const tx=fixture([accepted,{...accepted,id:'cancelled',eventType:'ORDER_CANCELLED'}]);
    await expect(applyQrPreview(tx as never,'next',prices,cutoff)).rejects.toMatchObject({code:'CONFLICT'});
    expect(tx.exchangeOrderEvent.updateMany).not.toHaveBeenCalled();
  });
  it('rejects a new acceptance after an empty preview',async()=>{
    const tx=fixture([accepted]);
    await expect(applyQrPreview(tx as never,'next',[{calculationInput:{qrDemandEventIds:[]}}],cutoff)).rejects.toMatchObject({code:'CONFLICT'});
  });
  it('applies unchanged captured input exactly once',async()=>{
    const tx=fixture([accepted]);
    await applyQrPreview(tx as never,'next',prices,cutoff);
    expect(tx.exchangeOrderEvent.updateMany).toHaveBeenCalledWith(expect.objectContaining({where:{id:{in:['accepted']}},data:expect.objectContaining({processingStatus:'APPLIED',appliedToRoundId:'next'})}));
  });
  it('rejects an event already consumed by another transition',async()=>{
    const tx=fixture([]);
    await expect(applyQrPreview(tx as never,'next',prices,cutoff)).rejects.toMatchObject({code:'CONFLICT'});
    expect(tx.exchangeOrderEvent.updateMany).not.toHaveBeenCalled();
  });
  it('blocks manual preview publication while source counters remain unclosed',async()=>{
    const round={id:'next',status:'APPROVED',startsAt:cutoff,organizationId:'org',prices:[{id:'price',calculationInput:{} as Prisma.JsonValue}]};
    const tx={$executeRaw:vi.fn(),priceRound:{findUniqueOrThrow:vi.fn(async()=>round)},exchangeSale:{count:vi.fn(async()=>1)},roundPrice:{update:vi.fn()}};
    const prisma={priceRound:{findUnique:vi.fn(async()=>round)},$transaction:async(fn:(value:unknown)=>unknown)=>fn(tx)};
    const service=new RoundsService(prisma as never,{} as never,{} as never);
    await expect(service.publishRound('next')).rejects.toMatchObject({code:'CONFLICT'});
    expect(tx.$executeRaw).toHaveBeenCalled();
    expect(tx.roundPrice.update).not.toHaveBeenCalled();
  });
  it('rechecks rollback state under the shared transition lock',async()=>{
    const round={id:'round',status:'PUBLISHED',organizationId:'org',prices:[]};
    const tx={$executeRaw:vi.fn(),priceRound:{findUniqueOrThrow:vi.fn(async()=>({...round,status:'CLOSED'})),findFirst:vi.fn(),update:vi.fn()}};
    const prisma={priceRound:{findUnique:vi.fn(async()=>round)},$transaction:async(fn:(value:unknown)=>unknown)=>fn(tx)};
    const service=new RoundsService(prisma as never,{} as never,{} as never);
    await expect(service.rollbackRound('round')).rejects.toMatchObject({code:'INVALID_ROUND_TRANSITION'});
    expect(tx.$executeRaw).toHaveBeenCalled();
    expect(tx.priceRound.findFirst).not.toHaveBeenCalled();
    expect(tx.priceRound.update).not.toHaveBeenCalled();
  });
});
