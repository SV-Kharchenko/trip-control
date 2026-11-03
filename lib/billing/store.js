// Доступ до даних оплати через Supabase service role. Тести підставляють in-memory реалізацію
// з тим самим інтерфейсом (tests/billing-fakes.mjs).

function fail(error) {
    if (error) throw error;
}

// Колонок автопродовження ще немає (20261020200000_auto_renew.sql не застосована): читання дає «вимкнено».
function missingColumn(error) {
    return !!error && (error.code === '42703' || error.code === 'PGRST204');
}

const AUTO_RENEW_COLUMNS = 'org_id, paid_until, last_plan, auto_renew, wfp_regular_order_ref, card_mask, next_charge_at, '
    + 'regular_status, regular_remove_reason, regular_stop_check, regular_stop_check_at, fail_count, auto_renew_consent_at, auto_renew_cancelled_at';

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
            if (!data) return null;
            // Колонок тріалу ще може не бути (20261117090000_trial_7d.sql не застосована) — тоді тріалу немає.
            const trial = await supabase.from('org_subscriptions').select('trial_ends_at').eq('org_id', orgId).maybeSingle();
            return { ...data, trial_ends_at: trial.error || !trial.data ? null : (trial.data.trial_ends_at || null) };
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
            const query = (columns) => supabase
                .from('payments')
                .select(columns)
                .eq('org_id', orgId)
                .order('created_at', { ascending: false })
                .limit(limit);
            const base = 'id, provider, plan, amount_minor, currency, status, created_at, credited_at, period_to';
            let { data, error } = await query(base + ', kind');
            if (missingColumn(error)) ({ data, error } = await query(base));
            fail(error);
            return data || [];
        },
        // Автопродовження компанії; null — рядка немає або міграція ще не застосована.
        async getAutoRenew(orgId) {
            const { data, error } = await supabase
                .from('org_subscriptions')
                .select(AUTO_RENEW_COLUMNS)
                .eq('org_id', orgId)
                .maybeSingle();
            if (missingColumn(error)) return null;
            fail(error);
            return data || null;
        },
        async updateAutoRenew(orgId, patch) {
            const { error } = await supabase
                .from('org_subscriptions')
                .update(Object.assign({}, patch, { updated_at: new Date().toISOString() }))
                .eq('org_id', orgId);
            fail(error);
        },
        // Стара регулярка, REMOVE якої ще не підтверджено (regular_removals). Та сама вже є — нічого (унікальний order_ref).
        async addRegularRemoval(row) {
            const { error } = await supabase.from('regular_removals').insert(row);
            if (error && error.code === '23505') return;
            fail(error);
        },
        // Щоденне прибирання заявок «Замовити демо» старших за рік (RPC purge_old_kp_leads). Міграція не застосована → null.
        async purgeOldKpLeads() {
            const { data, error } = await supabase.rpc('purge_old_kp_leads');
            if (error && (error.code === '42883' || error.code === 'PGRST202')) return null;
            fail(error);
            return Number(data) || 0;
        },
        async listRegularRemovals() {
            const { data, error } = await supabase
                .from('regular_removals')
                .select('id, org_id, order_ref, reason, created_at, last_try_at, tries')
                .order('created_at', { ascending: true })
                .limit(500);
            if (missingColumn(error) || (error && (error.code === '42P01' || error.code === 'PGRST205'))) return [];
            fail(error);
            return data || [];
        },
        async markRegularRemovalTried(id, tries) {
            const { error } = await supabase
                .from('regular_removals')
                .update({ tries, last_try_at: new Date().toISOString() })
                .eq('id', id);
            fail(error);
        },
        async deleteRegularRemoval(orderRef) {
            const { error } = await supabase.from('regular_removals').delete().eq('order_ref', orderRef);
            if (error && (error.code === '42P01' || error.code === 'PGRST205')) return;
            fail(error);
        },
        // Незакриті рахунки з автопродовженням компанії, створені після sinceIso.
        async openAutoRenewPayments(orgId, sinceIso) {
            const { data, error } = await supabase
                .from('payments')
                .select('*')
                .eq('org_id', orgId)
                .eq('provider', 'wayforpay')
                .in('status', ['created', 'pending'])
                .not('auto_renew_requested_at', 'is', null)
                .gte('created_at', sinceIso)
                .order('created_at', { ascending: false })
                .limit(20);
            if (missingColumn(error)) return [];
            fail(error);
            return data || [];
        },
        // fail_count + 1 атомарно (SQL); повертає нове значення.
        async recordRenewalFailure(orgId) {
            const { data, error } = await supabase.rpc('record_renewal_failure', { p_org: orgId });
            fail(error);
            return Number(data) || 0;
        },
        async autoRenewSubscriptions() {
            const { data, error } = await supabase
                .from('org_subscriptions')
                .select(AUTO_RENEW_COLUMNS)
                .or('auto_renew.eq.true,regular_status.eq.RemovePending')
                .limit(500);
            if (missingColumn(error)) return [];
            fail(error);
            return data || [];
        },
        async insertEvent(row) {
            const { error } = await supabase.from('payment_events').insert(row);
            fail(error);
        },
        // Подія з alert_key (унікальний індекс): true — вставлено цим запитом, false — така вже є (23505).
        async insertEventOnce(row) {
            const { error } = await supabase.from('payment_events').insert(row);
            if (error && error.code === '23505') return false;
            fail(error);
            return true;
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
        // Скільки активних власників (без фільтра по email: власник без email у профілі — теж власник).
        async countActiveOwners(orgId) {
            const { count, error } = await supabase
                .from('profiles')
                .select('id', { count: 'exact', head: true })
                .eq('org_id', orgId)
                .eq('org_role', 'owner')
                .eq('member_status', 'active');
            fail(error);
            return count || 0;
        },
        // null — лише успішний запит без рядка (компанії немає); помилка бази — виняток, а не «немає»:
        // крон за org_missing робить незворотний REMOVE.
        async orgStatus(orgId) {
            const { data, error } = await supabase.from('organizations').select('name, status, plan').eq('id', orgId).maybeSingle();
            fail(error);
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
        // Тріал: компанії, які ще в тріалі й не отримали сповіщення відповідного дня. Без колонок (міграція не застосована) — порожньо.
        async trialSubscriptionsActive(nowIso) {
            const { data, error } = await supabase
                .from('org_subscriptions')
                .select('org_id, paid_until, trial_ends_at, trial_notified_d5, trial_notified_d7')
                .gt('trial_ends_at', nowIso);
            if (missingColumn(error)) return [];
            fail(error);
            return data || [];
        },
        // Позначка «надіслано» ставиться умовно (IS NULL): повторний прогін cron не дублює.
        async markTrialNotified(orgId, day, atIso) {
            const column = day === 5 ? 'trial_notified_d5' : 'trial_notified_d7';
            const { data, error } = await supabase
                .from('org_subscriptions')
                .update({ [column]: atIso })
                .eq('org_id', orgId)
                .is(column, null)
                .select('org_id');
            fail(error);
            return Array.isArray(data) && data.length > 0;
        },
        // Одержувачі листів тріалу: активні власники (owner = «Директор») і директори з org_directors; без дублів.
        async trialRecipients(orgId) {
            const owners = await supabase.from('profiles').select('email').eq('org_id', orgId).eq('org_role', 'owner').eq('member_status', 'active');
            fail(owners.error);
            const dirs = await supabase.from('org_directors').select('user_id').eq('org_id', orgId);
            fail(dirs.error);
            const ids = (dirs.data || []).map((row) => row.user_id).filter(Boolean);
            let directors = [];
            if (ids.length) {
                const res = await supabase.from('profiles').select('email').in('id', ids);
                fail(res.error);
                directors = res.data || [];
            }
            const seen = new Set();
            return [...(owners.data || []), ...directors].map((row) => String(row.email || '').trim()).filter((email) => {
                const key = email.toLowerCase();
                if (!email || seen.has(key)) return false;
                seen.add(key);
                return true;
            });
        },
        // Лист не дійшов нікому — знімаємо позначку, щоб наступний прогін спробував знову.
        async unmarkTrialNotified(orgId, day) {
            const column = day === 5 ? 'trial_notified_d5' : 'trial_notified_d7';
            const { error } = await supabase.from('org_subscriptions').update({ [column]: null }).eq('org_id', orgId);
            fail(error);
        },
        async insertTrialNotification(orgId, kind, meta) {
            const { error } = await supabase.from('org_notifications').insert({ org_id: orgId, kind, meta });
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
