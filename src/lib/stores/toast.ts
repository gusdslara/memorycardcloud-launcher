import { writable } from 'svelte/store';

export interface ToastMessage {
    id: number;
    message: string;
    type: 'success' | 'error' | 'info';
    duration?: number;
}

function createToastStore() {
    const { subscribe, update } = writable<ToastMessage[]>([]);

    let count = 0;

    return {
        subscribe,
        add: (message: string, type: 'success' | 'error' | 'info' = 'info', duration = 3000) => {
            const id = count++;
            const toast = { id, message, type, duration };
            update((toasts) => [...toasts, toast]);

            if (duration > 0) {
                setTimeout(() => {
                    update((toasts) => toasts.filter((t) => t.id !== id));
                }, duration);
            }
        },
        remove: (id: number) => {
            update((toasts) => toasts.filter((t) => t.id !== id));
        }
    };
}

export const toast = createToastStore();
