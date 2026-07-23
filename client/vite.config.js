import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_BUILD_TIME__: JSON.stringify(new Date().toISOString())
  },
  build: {
    rollupOptions: {
      output: {
        // Only libraries that are statically imported everywhere belong here. html2canvas/jspdf/
        // papaparse are exclusively dynamic-imported on demand (see the pages that use them) —
        // manually chunking them caused Rollup to place its shared dynamic-import helper inside
        // that chunk, which every other dynamic-import site then eagerly pulled in whole.
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-misc': ['qrcode.react', 'idb', 'lucide-react']
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
