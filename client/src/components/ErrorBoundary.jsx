import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('PWA UI ErrorBoundary caught error:', error, errorInfo);
  }

  handleReset = () => {
    localStorage.removeItem('expert_safety_user');
    localStorage.removeItem('expert_safety_token');
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col items-center justify-center p-6 text-center">
          <div className="w-16 h-16 rounded-2xl bg-rose-50 border border-rose-200 flex items-center justify-center text-rose-600 mb-4 shadow-sm">
            <AlertTriangle className="w-8 h-8" />
          </div>
          <h2 className="text-xl font-bold text-slate-900">Something went wrong rendering the interface</h2>
          <p className="text-xs text-slate-500 max-w-md mt-2">
            {this.state.error?.message || 'An unexpected runtime error occurred.'}
          </p>
          <button
            onClick={this.handleReset}
            className="mt-6 px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold flex items-center gap-2 transition shadow-sm"
          >
            <RefreshCw className="w-4 h-4" />
            Reset Session & Reload App
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
