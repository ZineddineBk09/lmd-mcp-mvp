import mongoose from 'mongoose';
import { cacheGet, cacheSet } from './cache.js';

interface CurrencyInfo {
  currency_code: string;
  currency_symbol: string;
}

const CACHE_KEY = 'currency_map';
const CACHE_TTL_MS = 300_000; // 5 min

const FALLBACK: Record<string, CurrencyInfo> = {
  DZ: { currency_code: 'DZD', currency_symbol: 'د.ج' },
  MA: { currency_code: 'MAD', currency_symbol: 'DH' },
  TN: { currency_code: 'TND', currency_symbol: 'DT' },
  FR: { currency_code: 'EUR', currency_symbol: '€' },
  SN: { currency_code: 'XOF', currency_symbol: 'CFA' },
  ZA: { currency_code: 'ZAR', currency_symbol: 'R' },
};

async function loadCurrencyMap(): Promise<Record<string, CurrencyInfo>> {
  const cached = cacheGet<Record<string, CurrencyInfo>>(CACHE_KEY);
  if (cached) return cached;

  const db = mongoose.connection.db;
  if (!db) return FALLBACK;

  try {
    const docs = await db
      .collection('countrycurrency')
      .find(
        {},
        {
          projection: {
            'country.code': 1,
            'country.currency_code': 1,
            'country.currency_symbol': 1,
          },
        },
      )
      .toArray();

    const map: Record<string, CurrencyInfo> = { ...FALLBACK };
    for (const doc of docs) {
      const c = (doc as Record<string, unknown>).country as Record<string, unknown> | undefined;
      if (c?.code && c.currency_code) {
        map[c.code as string] = {
          currency_code: c.currency_code as string,
          currency_symbol: (c.currency_symbol as string) ?? (c.currency_code as string),
        };
      }
    }
    cacheSet(CACHE_KEY, map, CACHE_TTL_MS);
    return map;
  } catch {
    return FALLBACK;
  }
}

export async function getCurrencyForCountry(countryCode: string): Promise<CurrencyInfo> {
  const map = await loadCurrencyMap();
  return (
    map[countryCode] ?? {
      currency_code: countryCode,
      currency_symbol: countryCode,
    }
  );
}

export async function getAllCurrencies(): Promise<Record<string, CurrencyInfo>> {
  return loadCurrencyMap();
}
