import { describe, expect, it, vi } from 'vitest';
import { RoundsService } from '../src/modules/rounds/rounds.service.js';

describe('exchange audit: rollback consistency', () => {
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
