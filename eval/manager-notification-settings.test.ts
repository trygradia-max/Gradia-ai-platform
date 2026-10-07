import {afterEach,expect,it,vi} from 'vitest'
const mocks=vi.hoisted(()=>({requireShop:vi.fn(async()=>({id:'owned-shop'})),rpc:vi.fn(),client:vi.fn()}))
vi.mock('@/lib/shop',()=>({requireShop:mocks.requireShop}))
vi.mock('@/lib/supabase/server',()=>({createClient:mocks.client}))
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}))
import {getManagerNotifications,saveManagerNotifications} from '@/app/actions/manager-notifications'
const settings={mode:'off',timezone:'UTC',quiet_start:21,quiet_end:8,digest_hour:9,revision:0}
afterEach(()=>vi.clearAllMocks())
it.each([{shop_id:'foreign'}, {mode:'autonomous'}, {quiet_start:24}, {revision:-1}])('invalid or caller-selected ownership is rejected before lookup %j',async patch=>{
 expect(await saveManagerNotifications({...settings,...patch})).toMatchObject({ok:false});expect(mocks.requireShop).not.toHaveBeenCalled();expect(mocks.client).not.toHaveBeenCalled()
})
it('binds preferences to session shop and never retries an uncertain write',async()=>{
 mocks.client.mockResolvedValue({rpc:mocks.rpc});mocks.rpc.mockRejectedValueOnce(new Error('synthetic'))
 expect(await saveManagerNotifications(settings)).toMatchObject({ok:false,message:expect.stringContaining('uncertain')});expect(mocks.rpc).toHaveBeenCalledTimes(1);expect(mocks.rpc).toHaveBeenCalledWith('configure_manager_notifications',expect.objectContaining({p_shop:'owned-shop',p_revision:0}))
})
it('rejects stale revision results and unavailable reads',async()=>{
 mocks.client.mockResolvedValue({rpc:mocks.rpc});mocks.rpc.mockResolvedValue({data:null,error:{code:'synthetic'}})
 expect(await saveManagerNotifications(settings)).toMatchObject({ok:false});expect(await getManagerNotifications()).toBeNull()
})
it('reports saved preferences without claiming delivery activation',async()=>{
 mocks.client.mockResolvedValue({rpc:mocks.rpc});mocks.rpc.mockResolvedValueOnce({data:1,error:null})
 expect(await saveManagerNotifications(settings)).toMatchObject({ok:true,message:expect.stringContaining('no email was sent')})
})
