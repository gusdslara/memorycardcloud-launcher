import { writable, derived } from 'svelte/store';
import { openUrl } from '@tauri-apps/plugin-opener';
import { computeAdFree } from '../services/adPolicy';

export interface User {
    id: string | number;
    email: string;
    name: string;
    subscription_status?: string;
    subscription_plan?: string;
    storage_limit?: number;
    current_usage?: number;
    subscription_expires_at?: string | null;
    is_admin?: boolean;
    roms_access?: boolean; // private ROM library granted by the superadmin
    cpf_cnpj?: string;
    /** No ads: "Sem anúncios para sempre" bought, active cloud plan or admin (computed by the backend). */
    ad_free?: boolean;
    /** Bought (or was given) "Sem anúncios para sempre" (R$ 10, one-time). */
    ad_free_lifetime?: boolean;
}

export interface AuthState {
    user: User | null;
    subscription: 'active' | 'inactive' | 'none';
    token: string | null;
}

const initialState: AuthState = {
    user: null,
    subscription: 'none',
    token: null
};

function createAuthStore() {
    const { subscribe, set, update } = writable<AuthState>(initialState);

    return {
        subscribe,
        login: (user: User, token: string, subscription: 'active' | 'inactive' | 'none') => {
            // Ensure subscription status is synced from user object if available
            const subStatus = user.subscription_status === 'active' ? 'active' : subscription || 'none';
            set({ user, token, subscription: subStatus });
            localStorage.setItem('auth_token', token);
            localStorage.setItem('auth_user', JSON.stringify(user));
            localStorage.setItem('auth_subscription', subStatus);
        },
        logout: () => {
            set(initialState);
            localStorage.removeItem('auth_token');
            localStorage.removeItem('auth_user');
            localStorage.removeItem('auth_subscription');
        },
        loadFromStorage: () => {
            const token = localStorage.getItem('auth_token');
            const userStr = localStorage.getItem('auth_user');
            const subscription = localStorage.getItem('auth_subscription') as 'active' | 'inactive' | 'none';

            if (token && userStr) {
                try {
                    const user = JSON.parse(userStr);
                    set({ user, token, subscription: subscription || 'none' });
                    // trigger check in background
                    // createAuthStore().checkSubscription(); // Careful with recursion or instance
                } catch (e) {
                    console.error('Failed to parse auth user', e);
                    localStorage.removeItem('auth_token');
                }
            }
        },
        checkSubscription: async () => {
            const token = localStorage.getItem('auth_token');
            if (!token) return;

            try {
                // Use Service Layer
                const { AuthService } = await import('../services/api');
                const sub: any = await AuthService.checkSubscription(token);

                update(state => {
                    const newStatus = sub.subscription_status === 'active' ? 'active' : 'inactive';
                    localStorage.setItem('auth_subscription', newStatus);

                    // Update user object with new details
                    let updatedUser = state.user ? { ...state.user, ...sub } : null;

                    // Ensure name is never null
                    if (updatedUser && !updatedUser.name) {
                        updatedUser.name = sub.name || sub.email.split('@')[0];
                    }

                    if (!updatedUser && sub.id) {
                        // Create user from subscription data if it doesn't exist
                        updatedUser = {
                            id: sub.id,
                            email: sub.email,
                            name: sub.name || sub.email.split('@')[0], // Fallback name
                            subscription_status: sub.subscription_status,
                            subscription_plan: sub.subscription_plan,
                            storage_limit: sub.storage_limit,
                            current_usage: sub.current_usage,
                            subscription_expires_at: sub.subscription_expires_at,
                            ad_free: sub.ad_free,
                            ad_free_lifetime: sub.ad_free_lifetime
                        };
                    }

                    if (updatedUser) {
                        localStorage.setItem('auth_user', JSON.stringify(updatedUser));
                    }

                    return { ...state, subscription: newStatus, user: updatedUser, token };
                });

                // Return user for verification
                return sub;
            } catch (e: any) {
                console.error('Failed to check subscription', e);

                // Check for 401 Unauthorized
                // Service layer handles refresh and logout now.
                // We just log the error.
                console.warn('Subscription check failed', e);

                // Throw error so caller knows it failed
                throw e;
            }
        }
    };
}

export const auth = createAuthStore();

export const isAuthenticated = derived(auth, $auth => !!$auth.user);
export const hasActiveSubscription = derived(auth, $auth => $auth.subscription === 'active');

/**
 * True when the app must not show ads: lifetime "Sem anúncios para sempre", an active cloud plan or admin.
 * Logged-out users see ads. Used by services/ads.ts, PlansModal and the shell (Header button).
 */
export const isAdFree = derived(auth, $auth => computeAdFree($auth.user));
