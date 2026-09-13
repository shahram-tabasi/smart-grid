/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        graphite: {
          950: '#0a0e14',
          900: '#0e131b',
          850: '#121822',
          800: '#161d29',
          700: '#1e2733',
          600: '#2a3542',
          500: '#3c4a5a',
          400: '#5c6b7c',
          300: '#8493a3',
          200: '#b3c0cc',
          100: '#dbe3ea',
        },
        accent: {
          DEFAULT: '#3b82f6',
          dim: '#1d4ed8',
        },
        status: {
          healthy: '#22c55e',
          warning: '#eab308',
          attention: '#f97316',
          critical: '#ef4444',
          offline: '#64748b',
          info: '#38bdf8',
        },
      },
      fontFamily: {
        sans: ['Inter', 'Segoe UI', 'Tahoma', 'system-ui', 'sans-serif'],
        fa: ['Vazirmatn', 'Tahoma', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
