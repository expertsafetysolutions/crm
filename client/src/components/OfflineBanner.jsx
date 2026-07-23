import React from 'react';
import { useAuth } from '../context/AuthContext';
import { WifiOff, RefreshCw, CheckCircle2 } from 'lucide-react';

export default function OfflineBanner() {
  const { isOnline, pendingSyncCount, isSyncing, syncOfflineData } = useAuth();

  if (isOnline && pendingSyncCount === 0) return null;

  return (
    <div className={`w-full px-4 py-2.5 text-xs font-semibold flex items-center justify-between shadow-sm transition-colors ${
      !isOnline
        ? 'bg-rose-50 text-rose-800 border-b border-rose-200'
        : 'bg-amber-50 text-amber-800 border-b border-amber-200'
    }`}>
      <div className="flex items-center space-x-2">
        {!isOnline ? (
          <WifiOff className="w-4 h-4 text-rose-600 shrink-0" />
        ) : (
          <RefreshCw className="w-4 h-4 text-amber-600 shrink-0 animate-spin" />
        )}
        <span>
          {!isOnline
            ? `You are offline. Field actions will be saved locally to IndexedDB (${pendingSyncCount} queued).`
            : `Back online! You have ${pendingSyncCount} action(s) waiting to sync to Google Sheets.`
          }
        </span>
      </div>

      {isOnline && pendingSyncCount > 0 && (
        <button
          onClick={syncOfflineData}
          disabled={isSyncing}
          className="px-3 py-1 rounded-md bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs flex items-center gap-1.5 transition shadow-sm"
        >
          {isSyncing ? (
            <>
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              Syncing...
            </>
          ) : (
            <>
              <CheckCircle2 className="w-3.5 h-3.5" />
              Sync Now
            </>
          )}
        </button>
      )}
    </div>
  );
}
