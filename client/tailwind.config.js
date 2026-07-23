/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        safety: {
          red: '#E11D48',
          amber: '#F59E0B',
          dark: '#0F172A',
          card: '#1E293B',
          light: '#F8FAFC'
        }
      }
    },
  },
  plugins: [],
};
