import { writable } from 'svelte/store';
import { auth } from './auth';
import { toast } from './toast';
import { get } from 'svelte/store';
import { _ } from 'svelte-i18n';
import { API_BASE_URL } from '../config';

// We need to access translation outside component, but svelte-i18n's `_` store works best in components.
// However, we can subscribe to it or just use `get(_)` within the event handler.
// Since `_` is a store, we can use `get(_)` to get the translation function.

function createSSEStore() {
    // Only strictly needed if we want to expose connection status
    const { subscribe, set } = writable({ connected: false });

    let eventSource: EventSource | null = null;
    let retryTimeout: any = null;

    function connect(tokenArg?: string) {
        if (eventSource) return;

        // Use argument, or auth store state, or localStorage
        let token: string | null | undefined = tokenArg;
        if (!token) {
            token = get(auth).token || localStorage.getItem('auth_token');
        }

        if (!token) {
            console.warn('SSE: No token available, skipping connection.');
            return;
        }

        console.log('SSE: Connecting with token prefix:', token.substring(0, 10) + '...');

        const url = `${API_BASE_URL}/events?token=${encodeURIComponent(token)}`;

        eventSource = new EventSource(url);

        eventSource.onopen = () => {
            console.log('SSE Connected');
            set({ connected: true });
        };

        eventSource.onerror = (err) => {
            console.error('SSE Error', err);
            set({ connected: false });
            eventSource?.close();
            eventSource = null;
            // Retry in 5s
            retryTimeout = setTimeout(() => connect(token), 5000); // Retry with same token
        };

        // The backend sends a plain "update" message when the account changes (payment confirmed for a
        // cloud plan or "Sem anúncios para sempre", refund, admin change): refresh the user so the
        // plan badge and the ads (isAdFree) follow without restarting the app.
        eventSource.onmessage = async (e) => {
            if (e.data !== 'update') return;
            const before = get(auth).user;
            try {
                const sub: any = await auth.checkSubscription();
                if (sub?.ad_free_lifetime && !before?.ad_free_lifetime) {
                    toast.add('Obrigado pelo apoio! Sua conta está sem anúncios para sempre.', 'success');
                }
            } catch (err) {
                console.error('Failed to refresh the account after an update', err);
            }
        };

        // Listen for specific events
        eventSource.addEventListener('payment_success', async (e) => {
            console.log('Payment Success Event:', e.data);
            // Refresh user subscription
            try {
                await auth.checkSubscription();
                const $t = get(_);
                toast.add($t('app.payment.success'), 'success');
            } catch (err) {
                console.error('Failed to refresh sub after success', err);
            }
        });

        eventSource.addEventListener('payment_failed', (e) => {
            console.log('Payment Failed Event:', e.data);
            const $t = get(_);
            toast.add($t('app.payment.failed'), 'error');
        });
    }

    function disconnect() {
        if (eventSource) {
            eventSource.close();
            eventSource = null;
            set({ connected: false });
        }
        if (retryTimeout) clearTimeout(retryTimeout);
    }

    return {
        subscribe,
        init: () => {
            // Auto connect if logged in, also listen to auth changes to connect/disconnect
            auth.subscribe($auth => {
                if ($auth.token) {
                    if (!eventSource) {
                        connect($auth.token);
                    } else {
                        // If token changed, reconnect?
                        // For now assuming token doesn't change mid-session easily without logout
                    }
                } else {
                    disconnect();
                }
            });
        }
    };
}

export const sse = createSSEStore();
