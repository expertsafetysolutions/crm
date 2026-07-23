import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-pdf': ['html2canvas', 'jspdf'],
          'vendor-misc': ['papaparse', 'qrcode.react', 'idb', 'lucide-react']
        }
      }
    }
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true
      },
      '/assets': {
        target: 'http://localhost:5000',
        changeOrigin: true
      }
    }
  }
});
