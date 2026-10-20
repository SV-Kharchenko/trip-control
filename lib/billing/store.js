// Доступ до даних оплати через Supabase service role. Тести підставляють in-memory реалізацію
// з тим самим інтерфейсом (tests/billing-fakes.mjs).

function fail(error) {
    if (error) throw error;
}

export function createSupabaseStore(supabase) {
    return {
        async getUser(token) {
            const { data, error } = await supabase.auth.getUser(token);
            if (error || !data || !data.user) return null;
            return data.user;
        },
        async getProfile(userId) {
            const { data, error } = await supabase
                .from('profiles')
                .select('id, email, org_id, org_role, member_status, is_approved, organizations(id, name, status)')
                .eq('id', userId)
                .maybeSingle();
            fail(error);
            return data || null;
        },
        async getSubscription(orgId) {
            const { data, error } = await supabase
                .from('org_subscriptions')
                .select('org_id, paid_until, last_plan, reminder_sent_for')
                .eq('org_id', orgId)
                .maybeSingle();
            fail(error);
            return data || null;
        },
        async getOrgName(orgId) {
            const { data } = await supabase.from('organizations').select('name').eq('id', orgId).maybeSingle();
            return (data && data.name) || '';
        },
        async countPaymentsSince(orgId, sinceIso) {
            const { count, error } = await supabase
                .from('payments')
                .select('id', { count: 'exact', head: true })
                .eq('org_id', orgId)
                .gte('created_at', sinceIso);
            fail(error);
            return count || 0;
        },
        async insertPayment(row) {
            const { data, error } = await supabase.from('payments').insert(row).select('*').single();
            fail(error);
            return data;
        },
        async updatePayment(id, patch) {
            const { error } = await supabase
                .from('payments')
                .update(Object.assign({}, patch, { updated_at: new Date().toISOString() }))
                .eq('id', id);
            fail(error);
        },
        async insertConsent(row) {
            const { error } = await supabase.from('legal_consents').insert(row);
            fail(error);
        },
        async getPayment(id) {
            const { data, error } = await supabase.from('payments').select('*').eq('id', id).maybeSingle();
            fail(error);
            return data || null;
        },
        async findPayment(provider, field, value) {
            const { data, error } = await supabase
                .from('payments')
                .select('*')
                .eq('provider', provider)
                .eq(field, value)
                .maybeSingle();
            fail(error);
            return data || null;
        },
        async listPayments(orgId, limit) {
            const { data, error } = await supabase
                .from('payments')
                .select('id, provider, plan, amount_minor, currency, status, created_at, credited_at, period_to')
                .eq('org_id', orgId)
                .order('created_at', { ascending: false })
                .limit(limit);
            fail(error);
            return data || [];
        },
        async insertEvent(row) {
            const { error } = await supabase.from('payment_events').insert(row);
            fail(error);
        },
        async applySuccess(paymentId, modifiedIso) {
            const { data, error } = await supabase.rpc('apply_payment_success', { p_payment: paymentId, p_modified: modifiedIso });
            fail(error);
            return data || {};
        },
        async applyStatus(paymentId, status, modifiedIso) {
            const { data, error } = await supabase.rpc('apply_payment_status', {
                p_payment: paymentId, p_status: status, p_modified: modifiedIso
            });
            fail(error);
            return data || {};
        },
        // Повернення (20261020180000_refund_cut.sql): статус reversed і скорочення paid_until один раз.
        // Без цієї міграції (функції ще немає) — як раніше: лише статус, paid_until не змінюється.
        async applyReversal(paymentId, modifiedIso, partial) {
            const { data, error } = await supabase.rpc('apply_payment_reversal', {
                p_payment: paymentId, p_modified: modifiedIso, p_partial: !!partial
            });
            if (error && (error.code === 'PGRST202' || error.code === '42883')) {
                const legacy = await this.applyStatus(paymentId, 'reversed', modifiedIso);
                return Object.assign({ cut: false, partial: !!partial, legacy: true }, legacy);
            }
            fail(error);
            return data || {};
        },
        // Частковий рефанд mono (success, finalAmount < amount): true лише для першого виклику на платіж.
        async markPartialRefundAlerted(paymentId) {
            const { data, error } = await supabase
                .from('payments')
                .update({ partial_refund_alerted_at: new Date().toISOString() })
                .eq('id', paymentId)
                .is('partial_refund_alerted_at', null)
                .select('id');
            fail(error);
            return Array.isArray(data) && data.length > 0;
        },
        // Є в компанії користувач з ручним повним доступом (profiles.is_approved)?
        async orgHasManualAccess(orgId) {
            const { data, error } = await supabase
                .from('profiles')
                .select('id')
                .eq('org_id', orgId)
                .eq('is_approved', true)
                .limit(1);
            fail(error);
            return Array.isArray(data) && data.length > 0;
        },
        async subscriptionsEndingBetween(fromIso, toIso) {
            const { data, error } = await supabase
                .from('org_subscriptions')
                .select('org_id, paid_until, reminder_sent_for')
                .gte('paid_until', fromIso)
                .lt('paid_until', toIso);
            fail(error);
            return data || [];
        },
        async activeOwners(orgId) {
            const { data, error } = await supabase
                .from('profiles')
                .select('email')
                .eq('org_id', orgId)
                .eq('org_role', 'owner')
                .eq('member_status', 'active');
            fail(error);
            return (data || []).map((row) => row.email).filter(Boolean);
        },
        async orgStatus(orgId) {
            const { data } = await supabase.from('organizations').select('name, status').eq('id', orgId).maybeSingle();
            return data || null;
        },
        async markReminderSent(orgId, paidUntil) {
            const { error } = await supabase
                .from('org_subscriptions')
                .update({ reminder_sent_for: paidUntil, updated_at: new Date().toISOString() })
                .eq('org_id', orgId)
                .eq('paid_until', paidUntil);
            fail(error);
        },
        async openPaymentsBetween(fromIso, toIso) {
            const { data, error } = await supabase
                .from('payments')
                .select('*')
                .in('status', ['created', 'pending'])
                .gte('created_at', fromIso)
                .lte('created_at', toIso)
                .order('created_at', { ascending: true })
                .limit(200);
            fail(error);
            return data || [];
        }
    };
}
