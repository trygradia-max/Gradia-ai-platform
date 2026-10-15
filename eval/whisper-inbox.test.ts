import { beforeEach, describe, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), user: vi.fn(), client: vi.fn(), revalidate: vi.fn() }));
vi.mock('@/lib/shop', () => ({ requireUser: mocks.user }));
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.client }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
import { updateWhisperInbox } from '@/app/actions/whisper-inbox';
const id = '00000000-0000-4000-8000-000000000001';
const input = { shopId: id, customerId: id, channel: 'sms', commandId: id, latestId: id, revision: 0, operation: 'reply', payload: { body: 'Fictional draft', subject: '', destination: '+15555550111' } };
beforeEach(() => { vi.clearAllMocks(); mocks.client.mockResolvedValue({ rpc: mocks.rpc }); });
describe('Whisper command boundary', () => {
    it('rejects invalid and caller-selected classification before database/session work', async () => {
        for (const patch of [{ shopId: 'bad' }, { operation: 'send' }, { revision: -1 }, { payload: { ...input.payload, category: 'transactional' } }, { payload: { ...input.payload, body: '' } }])
            expect((await updateWhisperInbox({ ...input, ...patch })).ok).toBe(false);
        expect(mocks.client).not.toHaveBeenCalled();
        expect(mocks.user).not.toHaveBeenCalled();
    });
    it('stages through the session RPC without invoking a transport', async () => {
        mocks.rpc.mockResolvedValue({ data: id, error: null });
        const r = await updateWhisperInbox(input);
        expect(r.ok).toBe(true);
        expect(r.message).toContain('Nothing was sent');
        expect(mocks.rpc).toHaveBeenCalledWith('whisper_command', { p_shop: id, p_customer: id, p_channel: 'sms', p_command: id, p_latest: id, p_revision: 0, p_operation: 'reply', p_payload: input.payload });
    });
    it.each([{ data: null, error: { message: 'private' } }, { data: 'wrong', error: null }])('fails closed on invalid replies %#', async (reply) => {
        mocks.rpc.mockResolvedValue(reply);
        const r = await updateWhisperInbox(input);
        expect(r.ok).toBe(false);
        expect(r.message).not.toContain('private');
        expect(mocks.revalidate).not.toHaveBeenCalled();
    });
    it('never automatically retries uncertain commands', async () => {
        mocks.rpc.mockRejectedValue(Error('private'));
        expect((await updateWhisperInbox(input)).ok).toBe(false);
        expect(mocks.rpc).toHaveBeenCalledTimes(1);
    });
});
