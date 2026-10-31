import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type Locale = "en" | "ru";

const STORAGE_KEY = "luxora-lang";

type LocaleContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
};

const LocaleContext = createContext<LocaleContextValue>({ locale: "en", setLocale: () => {} });

function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "ru") return saved;
  } catch {
    /* storage unavailable: fall through to browser language */
  }
  return navigator.language?.toLowerCase().startsWith("ru") ? "ru" : "en";
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectLocale);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = (next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
  };

  return <LocaleContext.Provider value={{ locale, setLocale }}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext);
}

/** Returns the copy object for the current locale. Each page keeps its own bilingual copy. */
export function useCopy<T>(copy: Record<Locale, T>): T {
  return copy[useLocale().locale];
}
