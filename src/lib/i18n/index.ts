import { register, init, getLocaleFromNavigator } from 'svelte-i18n';
import { invoke } from '@tauri-apps/api/core';

register('pt-BR', () => import('./locales/pt-BR.json'));
register('en-US', () => import('./locales/en-US.json'));
register('en', () => import('./locales/en-US.json')); // Fallback for generic english

async function detectLanguage() {
    try {
        // Check if we are in portable mode or installed mode
        // We can infer this from get_default_backup_path which checks writability of app dir
        const defaultPath: any = await invoke("get_default_backup_path");

        // Check for manual override in localStorage
        const storedLang = localStorage.getItem('language');
        if (storedLang && (storedLang === 'pt-BR' || storedLang === 'en-US')) {
            console.log("Language override found in localStorage:", storedLang);
            return storedLang;
        }

        if (defaultPath.is_app_dir_writable) {
            // Portable mode: Use system language
            const systemLang = getLocaleFromNavigator();
            console.log("Portable mode detected. System language:", systemLang);
            return systemLang;
        } else {
            // Installed mode: Check for fixed language config
            // For now, we default to pt-BR as requested if no config is found
            // In a real scenario, we would read a config file here
            console.log("Installed mode detected. Defaulting to fixed language (pt-BR).");
            return 'pt-BR';
        }
    } catch (e) {
        console.error("Failed to detect language mode, defaulting to pt-BR", e);
        return 'pt-BR';
    }
}

export async function startI18n() {
    const detectedLang = await detectLanguage();

    init({
        fallbackLocale: 'pt-BR',
        initialLocale: detectedLang || 'pt-BR',
    });
}
