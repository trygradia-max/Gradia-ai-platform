import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { INTEGRATION_WITH_SESSION, serviceClient, ownerSessionClient, anonClient, seedShop, cleanup, type Seeded } from './_db';
import { initialPolicyDraft } from '@/lib/control-center/drafts';
describe.skipIf(!INTEGRATION_WITH_SESSION)('Whisper operational inbox', () => {
    let db: SupabaseClient, owner: SupabaseClient, manager: SupabaseClient, shop: Seeded, other: Seeded, member: string;
    beforeAll(async () => {
        db = serviceClient();
        shop = await seedShop(db, { password: 'Synthetic-Whisper-1005!' });
        other = await seedShop(db, { password: 'Synthetic-Whisper-1005!' });
        owner = await ownerSessionClient(shop.email, 'Synthetic-Whisper-1005!');
        manager = await ownerSessionClient(other.email, 'Synthetic-Whisper-1005!');
        const invite = await owner.rpc('team_invite', { p_shop: shop.shopId, p_email: other.email, p_name: 'Fictional Manager', p_role: 'manager', p_capabilities: ['crm.read', 'assignments.manage'] });
        expect(invite.error).toBeNull();
        expect((await manager.rpc('team_accept_invite', { p_token: invite.data.token })).error).toBeNull();
        member = (await owner.from('shop_memberships').select('id').eq('shop_id', shop.shopId).eq('user_id', other.ownerId).single()).data!.id;
    });
    afterAll(async () => { if (shop)
        await cleanup(db, shop); if (other)
        await cleanup(db, other); });
    async function setup(channel = 'sms') {
        const c = await db.from('customers').insert({ shop_id: shop.shopId, name: 'Fictional Whisper Customer', phone: '+1555' + String(Math.floor(Math.random() * 1e7)).padStart(7, '0'), email: `${randomUUID()}@example.test` }).select('*').single();
        expect(c.error).toBeNull();
        const m = await db.from('interactions').insert({ shop_id: shop.shopId, customer_id: c.data!.id, channel, role: 'customer', content: 'Fictional inquiry' }).select('id').single();
        expect(m.error).toBeNull();
        return { c: c.data!, a: { p_shop: shop.shopId, p_customer: c.data!.id, p_channel: channel, p_command: randomUUID(), p_latest: m.data!.id, p_revision: 0, p_operation: 'handoff', p_payload: { state: 'held', reason: 'Fictional review', assignee_id: member } } };
    }
    const read = (id: string, channel = 'sms', client = owner) => client.rpc('read_whisper_thread', { p_shop: shop.shopId, p_customer: id, p_channel: channel });
    const list = (client = owner) => client.rpc('list_whisper_threads', { p_shop: shop.shopId });
    it('direct RPC callers cannot add classifications, proofs or arbitrary read payloads', async () => {
        const {a,c}=await setup();
        for(const payload of [{body:'Fictional',subject:'',destination:c.phone,category:'transactional'}, {body:7,subject:'',destination:c.phone}, {body:'Fictional',subject:'',destination:c.phone,service_proof:'forged'}]) {
            const id=randomUUID();expect((await owner.rpc('whisper_command',{...a,p_command:id,p_operation:'reply',p_payload:payload})).error?.code).toBe('22023');expect((await db.from('pending_actions').select('id').eq('id',id)).data).toEqual([]);
        }
        expect((await owner.rpc('whisper_command',{...a,p_operation:'read',p_payload:{extra:'untrusted'}})).error?.code).toBe('22023');
        expect((await read(c.id)).data.revision).toBe(0);
    });
    it('groups existing messages by owned customer/channel and keeps unidentified content separate', async () => {
        const { c } = await setup();
        await db.from('interactions').insert({ shop_id: shop.shopId, customer_id: null, channel: 'sms', role: 'customer', content: 'Unidentified private detail' });
        const r = await list();
        expect(r.error).toBeNull();
        expect(r.data.unidentified).toBe(1);
        expect(JSON.stringify(r.data)).not.toContain('Unidentified private detail');
        expect(r.data.items.find((x: {
            customer_id: string;
        }) => x.customer_id === c.id)).toMatchObject({ unread: true, state: 'needs_reply' });
    });
    it('marks read per actor, does not acknowledge future arrivals, and manager reads stay independent', async () => {
        const { a, c } = await setup();
        expect((await owner.rpc('whisper_command', { ...a, p_operation: 'read', p_payload: {} })).error).toBeNull();
        const find = (r: {
            data: {
                items: {
                    customer_id: string;
                    unread: boolean;
                }[];
            } | null;
            error: unknown;
        }) => { expect(r.error).toBeNull(); expect(r.data).not.toBeNull(); return r.data!.items.find(x => x.customer_id === c.id)!.unread; };
        expect(find(await list())).toBe(false);
        expect(find(await list(manager))).toBe(true);
        await db.from('interactions').insert({ shop_id: shop.shopId, customer_id: c.id, channel: 'sms', role: 'customer', content: 'Late evidence', occurred_at: '2020-01-01' });
        expect(find(await list())).toBe(true);
    });
    it('atomically assigns once across concurrent retries and records an in-app notification', async () => {
        const { a, c } = await setup(), r = await Promise.all([owner.rpc('whisper_command', a), owner.rpc('whisper_command', a)]);
        expect(r.every(x => !x.error && x.data === a.p_command)).toBe(true);
        expect((await read(c.id)).data).toMatchObject({ revision: 1, state: 'held', assignee_id: member });
        expect((await list(manager)).data.notifications).toBeGreaterThan(0);
        expect((await owner.rpc('whisper_command', { ...a, p_payload: { ...a.p_payload, reason: 'Edited' } })).error?.code).toBe('PT409');
    });
    it('new messages reopen manually completed work and reject stale mutation', async () => {
        const { a, c } = await setup();
        expect((await owner.rpc('whisper_command', { ...a, p_payload: { ...a.p_payload, state: 'completed' } })).error).toBeNull();
        expect((await read(c.id)).data.state).toBe('completed');
        await db.from('interactions').insert({ shop_id: shop.shopId, customer_id: c.id, channel: 'sms', role: 'customer', content: 'New question' });
        expect((await read(c.id)).data.state).toBe('needs_reply');
        expect((await owner.rpc('whisper_command', { ...a, p_command: randomUUID() })).error?.code).toBe('PT409');
    });
    it.each(['sms', 'email'])('stages %s reply once with current recipient and conservative consent classification', async (channel) => {
        const { a, c } = await setup(channel), command = { ...a, p_operation: 'reply', p_payload: { body: 'Fictional reply', subject: 'Fictional subject', destination: channel === 'sms' ? c.phone : c.email } };
        expect((await owner.rpc('whisper_command', command)).error).toBeNull();
        expect((await owner.rpc('whisper_command', command)).error).toBeNull();
        const r = await db.from('pending_actions').select('*').eq('id', a.p_command).single();
        expect(r.data).toMatchObject({ status: 'pending', requested_by: shop.ownerId, payload: { customer_id: c.id, category: 'marketing', source: 'whisper_inbox' } });
        expect((await read(c.id, channel)).data.state).toBe('awaiting_approval');
        expect((await db.from('interactions').select('id').eq('shop_id', shop.shopId).eq('customer_id', c.id)).data).toHaveLength(1);
        expect((await manager.rpc('whisper_command', { ...command, p_command: randomUUID() })).error?.code).toBe('42501');
    });
    it('uncertain execution stays held even after manual completion', async () => {
        const { a, c } = await setup();
        await db.from('pending_actions').insert({ shop_id: shop.shopId, requested_by: shop.ownerId, action_type: 'send_sms', status: 'approved', payload: { customer_id: c.id }, result_id: null });
        expect((await owner.rpc('whisper_command', { ...a, p_payload: { ...a.p_payload, state: 'completed' } })).error).toBeNull();
        expect((await read(c.id)).data.state).toBe('held');
    });
    it('denies foreign selectors, sessionless calls, cross-shop assignees and direct table mutation', async () => {
        const { a, c } = await setup();
        expect((await owner.rpc('read_whisper_thread', { p_shop: other.shopId, p_customer: c.id, p_channel: 'sms' })).error?.code).toBe('42501');
        for (const caller of [anonClient(), db])
            expect((await read(c.id, 'sms', caller)).error).not.toBeNull();
        const foreign = (await db.from('shop_memberships').select('id').eq('shop_id', other.shopId).eq('role', 'owner').single()).data!;
        expect((await owner.rpc('whisper_command', { ...a, p_payload: { ...a.p_payload, assignee_id: foreign.id } })).error?.code).toBe('42501');
        expect((await owner.from('conversation_work').select('*')).error?.code).toBe('42501');
    });
    it('injected final audit failure rolls back handoff and reply staging', async () => {
        const { a, c } = await setup();
        expect((await owner.rpc('whisper_command', { ...a, p_payload: { ...a.p_payload, reason: 'INJECT_WHISPER_FAILURE' } })).error?.message).toContain('Injected whisper failure');
        expect((await read(c.id)).data.revision).toBe(0);
        const cmd = randomUUID();
        expect((await owner.rpc('whisper_command', { ...a, p_command: cmd, p_operation: 'reply', p_payload: { body: 'INJECT_WHISPER_FAILURE', destination: c.phone, subject: '' } })).error?.message).toContain('Injected whisper failure');
        expect((await db.from('pending_actions').select('id').eq('id', cmd)).data).toEqual([]);
    });
    it('merges preserve operational context conservatively and mark merged history unread', async () => {
        const { a, c } = await setup(), winner = await setup();
        expect((await owner.rpc('whisper_command', a)).error).toBeNull();
        const r = await owner.rpc('merge_customers_atomic', { p_shop: shop.shopId, p_winner: winner.c.id, p_loser: c.id });
        expect(r.error).toBeNull();
        expect((await read(winner.c.id)).data).toMatchObject({ state: 'held', assignee_id: null });
        expect((await read(c.id)).error).not.toBeNull();
    });
    it('call history never exposes email approval state or records', async () => {
        const { c } = await setup('voice');
        expect((await db.from('pending_actions').insert({ shop_id: shop.shopId, requested_by: shop.ownerId, action_type: 'send_email', payload: { customer_id: c.id } })).error).toBeNull();
        const r = await read(c.id, 'voice');
        expect(r.error).toBeNull();
        expect(r.data).toMatchObject({ state: 'needs_reply', actions: [] });
    });
    it('competing handoffs have one winner and changed recipient blocks staging', async () => {
        const { a, c } = await setup();
        const r = await Promise.all([owner.rpc('whisper_command', a), owner.rpc('whisper_command', { ...a, p_command: randomUUID() })]);
        expect(r.filter(x => !x.error)).toHaveLength(1);
        expect(r.filter(x => x.error?.code === 'PT409')).toHaveLength(1);
        const id = randomUUID();
        expect((await owner.rpc('whisper_command', { ...a, p_command: id, p_revision: 1, p_operation: 'reply', p_payload: { body: 'Fictional', subject: '', destination: '+15550000000' } })).error?.code).toBe('PT409');
        expect((await db.from('pending_actions').select('id').eq('id', id)).data).toEqual([]);
        expect((await read(c.id)).data.revision).toBe(1);
    });
    it('notification acknowledgement is personal and a later handoff remains new', async () => {
        const { a } = await setup();
        expect((await owner.rpc('whisper_command', a)).error).toBeNull();
        const before = (await list(manager)).data.notifications;
        expect((await manager.rpc('whisper_command', { ...a, p_command: randomUUID(), p_revision: 1, p_operation: 'read', p_payload: {} })).error).toBeNull();
        expect((await list(manager)).data.notifications).toBe(before - 1);
        expect((await owner.rpc('whisper_command', { ...a, p_command: randomUUID(), p_revision: 1 })).error).toBeNull();
        expect((await list(manager)).data.notifications).toBe(before);
    });
    it('merge collisions retain a hold and reset both readers; injected merge failure preserves metadata', async () => {
        const loser = await setup(), winner = await setup();
        for (const x of [loser, winner]) {
            expect((await owner.rpc('whisper_command', x.a)).error).toBeNull();
            expect((await owner.rpc('whisper_command', { ...x.a, p_command: randomUUID(), p_revision: 1, p_operation: 'read', p_payload: {} })).error).toBeNull();
        }
        expect((await db.from('customers').update({ name: 'P0_INJECT_MERGE_FAILURE' }).eq('id', winner.c.id)).error).not.toBeNull();
        // Insert the trigger marker without updating it; the merge update is the failure point.
        const failing = await db.from('customers').insert({ shop_id: shop.shopId, name: 'P0_INJECT_MERGE_FAILURE' }).select('id').single();
        expect(failing.error).toBeNull();
        expect((await owner.rpc('merge_customers_atomic', { p_shop: shop.shopId, p_winner: failing.data!.id, p_loser: loser.c.id })).error?.message).toContain('Injected mid-merge failure');
        expect((await read(loser.c.id)).data).toMatchObject({ revision: 1, assignee_id: member, state: 'held' });
        expect((await owner.rpc('merge_customers_atomic', { p_shop: shop.shopId, p_winner: winner.c.id, p_loser: loser.c.id })).error).toBeNull();
        const r = await read(winner.c.id);
        expect(r.data).toMatchObject({ state: 'held', assignee_id: null });
        expect((await list()).data.items.find((x: {
            customer_id: string;
        }) => x.customer_id === winner.c.id).unread).toBe(true);
    });
    it('revocation removes visibility; assigned staff can read but cannot manage or reply', async () => {
        const { a, c } = await setup();
        expect((await owner.rpc('team_set_member', { p_shop: shop.shopId, p_member: member, p_role: 'staff', p_active: true, p_capabilities: [] })).error).toBeNull();
        expect((await read(c.id, 'sms', manager)).error).not.toBeNull();
        expect((await owner.rpc('team_assign', { p_shop: shop.shopId, p_member: member, p_customer: c.id, p_appointment: null, p_remove: false })).error).toBeNull();
        const r = await read(c.id, 'sms', manager);
        expect(r.error).toBeNull();
        expect(r.data).toMatchObject({ can_manage: false, can_reply: false, intakes: [], actions: [] });
        expect((await manager.rpc('whisper_command', a)).error?.code).toBe('42501');
        expect((await owner.rpc('team_set_member', { p_shop: shop.shopId, p_member: member, p_role: 'staff', p_active: false, p_capabilities: [] })).error).toBeNull();
        expect((await read(c.id, 'sms', manager)).error).not.toBeNull();
    });
    it('Off policy prevents reply staging with zero pending action effects', async () => {
        const { a, c } = await setup(), d = await owner.from('control_policy_drafts').select('revision').eq('shop_id', shop.shopId).single();
        const saved = await owner.rpc('save_control_policy_draft', { p_shop: shop.shopId, p_expected_revision: d.data!.revision, p_definition: { ...initialPolicyDraft(), workspaceCeiling: 'off' } });
        expect(saved.error).toBeNull();
        expect((await owner.rpc('activate_control_policy', { p_shop: shop.shopId, p_revision: saved.data, p_expected_active: null })).error).toBeNull();
        expect((await owner.rpc('whisper_command', { ...a, p_operation: 'reply', p_payload: { destination: c.phone, body: 'Fictional', subject: '' } })).error?.code).toBe('42501');
        expect((await db.from('pending_actions').select('id').eq('id', a.p_command)).data).toEqual([]);
    });
});
