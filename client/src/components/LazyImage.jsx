import React, { useState, useRef, useEffect } from 'react';
import { ImageIcon, Loader2, AlertCircle } from 'lucide-react';

/**
 * Deferred image loader.
 *
 * A page listing many items would otherwise fire dozens of image requests on mount and stall the
 * browser. Two strategies avoid that:
 *
 *  - mode="viewport" (default): an IntersectionObserver starts the download only once the image
 *    scrolls near the viewport, so off-screen photos cost nothing;
 *  - mode="click": nothing loads until the user taps the placeholder — best for long item lists on
 *    mobile data, which is what the field staff are on.
 *
 * Once loaded, the browser cache keeps it; unmounting and remounting will not re-download.
 */
export default function LazyImage({
  src,
  alt = '',
  mode = 'viewport',
  className = '',
  wrapperClassName = '',
  rootMargin = '200px',
  placeholderLabel = 'Tap to load photo'
}) {
  const [shouldLoad, setShouldLoad] = useState(mode === 'eager');
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const holderRef = useRef(null);

  useEffect(() => {
    if (mode !== 'viewport' || shouldLoad) return;
    const el = holderRef.current;
    if (!el) return;

    // Older browsers without IntersectionObserver just load immediately rather than never showing.
    if (typeof IntersectionObserver === 'undefined') {
      setShouldLoad(true);
      return;
    }

    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(e => e.isIntersecting)) {
          setShouldLoad(true);
          observer.disconnect();
        }
      },
      { rootMargin }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [mode, shouldLoad, rootMargin]);

  if (!src) {
    return (
      <div className={`flex items-center justify-center bg-slate-100 text-slate-300 ${wrapperClassName}`}>
        <ImageIcon className="w-5 h-5" />
      </div>
    );
  }

  return (
    <div
      ref={holderRef}
      onClick={() => { if (!shouldLoad) setShouldLoad(true); }}
      className={`relative overflow-hidden bg-slate-100 ${!shouldLoad && mode === 'click' ? 'cursor-pointer' : ''} ${wrapperClassName}`}
    >
      {!shouldLoad && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-slate-400">
          <ImageIcon className="w-5 h-5" />
          {mode === 'click' && (
            <span className="text-[9px] font-bold uppercase text-center px-1 leading-tight">{placeholderLabel}</span>
          )}
        </div>
      )}

      {shouldLoad && !loaded && !failed && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Loader2 className="w-4 h-4 animate-spin text-slate-400" />
        </div>
      )}

      {failed && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-0.5 text-slate-400">
          <AlertCircle className="w-4 h-4" />
          <span className="text-[9px] font-bold">Unavailable</span>
        </div>
      )}

      {shouldLoad && (
        <img
          src={src}
          alt={alt}
          /* Native lazy attribute as a second line of defence in viewport mode */
          loading={mode === 'viewport' ? 'lazy' : undefined}
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={`${className} ${loaded ? 'opacity-100' : 'opacity-0'} transition-opacity duration-200`}
        />
      )}
    </div>
  );
}
