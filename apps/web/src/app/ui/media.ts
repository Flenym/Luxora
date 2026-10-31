/** Authenticated media helpers: fetch private blobs through the API client and
 *  expose short-lived object URLs. No unauthenticated URL is ever rendered. */
import { useEffect, useRef, useState } from "react";
import { useMessenger } from "../messenger";

type CacheEntry = {
  url: string | null;
  refs: number;
  promise: Promise<string> | null;
};

const cache = new Map<string, CacheEntry>();

export type AuthedUrlState = { url: string | null; loading: boolean; error: boolean };

const EMPTY: AuthedUrlState = { url: null, loading: false, error: false };

/**
 * Resolve an authenticated API path (attachment content/thumbnail, avatar) to an
 * object URL. Results are cached per path and revoked when the last consumer
 * unmounts. Render nothing (or an honest fallback) while `url` is null.
 */
export function useAuthedObjectUrl(path: string | null | undefined): AuthedUrlState {
  const api = useMessenger();
  const authBlobRef = useRef(api.authBlob);
  authBlobRef.current = api.authBlob;
  const [state, setState] = useState<AuthedUrlState>(path ? { url: null, loading: true, error: false } : EMPTY);

  useEffect(() => {
    if (!path) {
      setState(EMPTY);
      return;
    }
    let cancelled = false;
    let entry = cache.get(path);
    if (!entry) {
      entry = { url: null, refs: 0, promise: null };
      cache.set(path, entry);
    }
    const current = entry;
    current.refs += 1;
    const apply = (next: AuthedUrlState) => {
      if (!cancelled) setState(next);
    };
    const load = () => {
      apply({ url: null, loading: true, error: false });
      if (!current.promise) {
        current.promise = authBlobRef
          .current(path)
          .then((blob) => {
            const url = URL.createObjectURL(blob);
            current.promise = null;
            current.url = url;
            const live = cache.get(path);
            if (live !== current || current.refs <= 0) {
              URL.revokeObjectURL(url);
            }
            return url;
          })
          .catch((error: unknown) => {
            current.promise = null;
            throw error;
          });
      }
      const pending = current.promise;
      pending.then(
        (url) => apply({ url, loading: false, error: false }),
        () => apply({ url: null, loading: false, error: true }),
      );
    };
    if (current.url) apply({ url: current.url, loading: false, error: false });
    else load();

    return () => {
      cancelled = true;
      const live = cache.get(path);
      if (!live) return;
      live.refs -= 1;
      if (live.refs <= 0) {
        if (live.url) URL.revokeObjectURL(live.url);
        cache.delete(path);
      }
    };
  }, [path]);

  return state;
}

/** Fetch an authenticated blob and trigger a browser download. */
export function useAuthedDownload(): (path: string, fileName: string) => Promise<void> {
  const api = useMessenger();
  const authBlobRef = useRef(api.authBlob);
  authBlobRef.current = api.authBlob;
  return async (path: string, fileName: string) => {
    const blob = await authBlobRef.current(path);
    const url = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      anchor.rel = "noopener";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } finally {
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }
  };
}
