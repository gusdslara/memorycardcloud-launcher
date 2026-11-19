/**
 * Cores são CSS variables (tokens.css). Com string pura, "bg-night/95" sai transparente porque o Tailwind não
 * consegue aplicar a opacidade a var(); color-mix resolve: a barra de baixo e os véus voltam a ter fundo.
 */
const token = (name) => ({ opacityValue }) =>
  opacityValue === undefined || opacityValue === '1'
    ? `var(--${name})`
    : `color-mix(in oklab, var(--${name}) calc(${opacityValue} * 100%), transparent)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{html,js,svelte,ts}'],
  theme: {
    extend: {
      colors: {
        night: token('night'),
        panel: token('panel'),
        'panel-2': token('panel-2'),
        'panel-3': token('panel-3'),
        rule: token('rule'),
        'rule-strong': token('rule-strong'),
        ink: token('ink'),
        'ink-2': token('ink-2'),
        muted: token('muted'),
        faint: token('faint'),
        'card-red': token('card-red'),
        'card-green': token('card-green'),
        'card-blue': token('card-blue'),
        'card-navy': token('card-navy'),
        action: token('action'),
        'action-hover': token('action-hover'),
        'action-bg': token('action-bg'),
        'action-border': token('action-border'),
        success: token('success'),
        'success-ink': token('success-ink'),
        'success-bg': token('success-bg'),
        warn: token('warn'),
        'warn-ink': token('warn-ink'),
        'warn-bg': token('warn-bg'),
        danger: token('danger'),
        'danger-hover': token('danger-hover'),
        'danger-ink': token('danger-ink'),
        'danger-bg': token('danger-bg'),
        focus: token('focus'),
      },
      fontFamily: {
        display: ['"Chakra Petch"', 'system-ui', 'sans-serif'],
        body: ['"IBM Plex Sans"', 'system-ui', 'sans-serif'],
        sans: ['"IBM Plex Sans"', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', '"SFMono-Regular"', 'Menlo', 'Consolas', 'monospace'],
      },
      borderRadius: {
        sm: '8px',
        md: '12px',
        DEFAULT: '14px',
        lg: '18px',
        pill: '999px',
      },
    },
  },
  plugins: [],
};
