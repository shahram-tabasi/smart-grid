'use client';

import { useMemo, useState } from 'react';
import { apiFetch } from '@/lib/api';

/**
 * Country → province/state → city, with anything missing addable in place.
 *
 * The seed carried 13 Iranian provinces and 24 cities, so most real sites had nowhere to be filed:
 * a panel going to Mehriz in Yazd, or to a customer in Berlin, could not be recorded at all.
 *
 * Iran's 31 provinces and their 433 counties are now seeded, so Iranian sites are a straight pick.
 * Everywhere else is created here, on the spot — Electro Kavir ships worldwide and has branches
 * outside Iran, and no shipped gazetteer would contain every town a panel reaches. Adding a place
 * is idempotent: typing a name that already exists selects the existing record instead of creating
 * a duplicate, so two engineers adding "Berlin" on the same afternoon still get one Berlin.
 *
 * This records a place NAME only — no street address, no coordinates. Province and city remain the
 * most precise location this system stores for a site (docs/ARCHITECTURE.md §9). Coordinates exist
 * solely for the company's own installed panels, placed deliberately by pin on the map screen.
 */

export interface Country {
  code: string;
  name_en: string;
  name_fa: string;
}
export interface Province {
  id: string;
  name_en: string;
  name_fa: string;
  country_code?: string;
  is_user_created?: boolean;
}
export interface City {
  id: string;
  province_id: string;
  name_en: string;
  name_fa: string;
  is_user_created?: boolean;
}

interface Props {
  countries: Country[];
  provinces: Province[];
  cities: City[];
  countryCode: string;
  provinceId: string;
  cityId: string;
  onChange: (next: { countryCode: string; provinceId: string; cityId: string }) => void;
  /** Called after a new province/city is created so the parent can refresh its reference lists. */
  onCreated: (created: { province?: Province; city?: City }) => void;
  inputClass: string;
  labelClass: string;
  fa?: boolean;
}

export function LocationPicker({
  countries, provinces, cities,
  countryCode, provinceId, cityId,
  onChange, onCreated, inputClass, labelClass, fa = false,
}: Props) {
  const [addingProvince, setAddingProvince] = useState(false);
  const [addingCity, setAddingCity] = useState(false);
  const [newProvince, setNewProvince] = useState({ en: '', faName: '' });
  const [newCity, setNewCity] = useState({ en: '', faName: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const provincesInCountry = useMemo(
    () => provinces.filter((p) => (p.country_code ?? 'IR') === countryCode),
    [provinces, countryCode]
  );
  const citiesInProvince = useMemo(
    () => cities.filter((c) => c.province_id === provinceId),
    [cities, provinceId]
  );

  // Countries that already hold a province are listed first: after the first Berlin project, Germany
  // sits at the top instead of being hunted for among 54 alphabetical entries.
  const orderedCountries = useMemo(() => {
    const used = new Set(provinces.map((p) => p.country_code ?? 'IR'));
    const inUse = countries.filter((c) => used.has(c.code));
    const rest = countries.filter((c) => !used.has(c.code));
    return { inUse, rest };
  }, [countries, provinces]);

  async function createProvince() {
    const nameEn = newProvince.en.trim();
    if (!nameEn) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await apiFetch<{ province: Province; created: boolean }>('/api/provisioning/locations/provinces', {
        method: 'POST',
        body: JSON.stringify({ nameEn, nameFa: newProvince.faName.trim() || nameEn, countryCode }),
      });
      onCreated({ province: res.province });
      onChange({ countryCode, provinceId: res.province.id, cityId: '' });
      setAddingProvince(false);
      setNewProvince({ en: '', faName: '' });
    } catch (e: any) {
      setErr(e?.message ?? 'Could not add that region.');
    } finally {
      setBusy(false);
    }
  }

  async function createCity() {
    const nameEn = newCity.en.trim();
    if (!nameEn || !provinceId) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await apiFetch<{ city: City; created: boolean }>('/api/provisioning/locations/cities', {
        method: 'POST',
        body: JSON.stringify({ nameEn, nameFa: newCity.faName.trim() || nameEn, provinceId }),
      });
      onCreated({ city: res.city });
      onChange({ countryCode, provinceId, cityId: res.city.id });
      setAddingCity(false);
      setNewCity({ en: '', faName: '' });
    } catch (e: any) {
      setErr(e?.message ?? 'Could not add that city.');
    } finally {
      setBusy(false);
    }
  }

  const addLink = 'text-[11px] text-accent hover:underline disabled:opacity-50';

  return (
    <>
      <div>
        <label className={labelClass}>{fa ? 'کشور' : 'Country'} *</label>
        <select
          className={inputClass}
          value={countryCode}
          onChange={(e) => {
            // Changing country invalidates both levels below it.
            onChange({ countryCode: e.target.value, provinceId: '', cityId: '' });
            setAddingProvince(false);
            setAddingCity(false);
          }}
        >
          {orderedCountries.inUse.length > 0 && (
            <optgroup label={fa ? 'در حال استفاده' : 'In use'}>
              {orderedCountries.inUse.map((c) => (
                <option key={c.code} value={c.code}>{c.name_en} / {c.name_fa}</option>
              ))}
            </optgroup>
          )}
          <optgroup label={fa ? 'سایر کشورها' : 'All countries'}>
            {orderedCountries.rest.map((c) => (
              <option key={c.code} value={c.code}>{c.name_en} / {c.name_fa}</option>
            ))}
          </optgroup>
        </select>
      </div>

      <div>
        <div className="mb-1 flex items-baseline justify-between">
          <label className={labelClass.replace('mb-1 ', '')}>
            {countryCode === 'IR' ? (fa ? 'استان' : 'Province') : fa ? 'استان / ایالت' : 'Region / State'} *
          </label>
          <button type="button" className={addLink} disabled={busy} onClick={() => setAddingProvince((v) => !v)}>
            {addingProvince ? (fa ? 'انصراف' : 'cancel') : fa ? '+ افزودن' : '+ add'}
          </button>
        </div>

        {addingProvince ? (
          <div className="space-y-1.5">
            <input
              className={inputClass}
              autoFocus
              value={newProvince.en}
              onChange={(e) => setNewProvince((s) => ({ ...s, en: e.target.value }))}
              placeholder={fa ? 'نام لاتین، مثلاً Berlin' : 'Name, e.g. Berlin'}
            />
            <input
              className={inputClass}
              value={newProvince.faName}
              onChange={(e) => setNewProvince((s) => ({ ...s, faName: e.target.value }))}
              placeholder={fa ? 'نام فارسی (اختیاری)' : 'Persian name (optional)'}
            />
            <button
              type="button"
              onClick={createProvince}
              disabled={busy || !newProvince.en.trim()}
              className="w-full rounded-lg bg-accent/20 py-1.5 text-xs font-medium text-accent hover:bg-accent/30 disabled:opacity-50"
            >
              {busy ? (fa ? 'در حال ذخیره…' : 'Saving…') : fa ? 'افزودن استان/ایالت' : 'Add region'}
            </button>
          </div>
        ) : (
          <select
            className={inputClass}
            value={provinceId}
            onChange={(e) => onChange({ countryCode, provinceId: e.target.value, cityId: '' })}
          >
            <option value="">—</option>
            {provincesInCountry.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name_en} / {p.name_fa}
              </option>
            ))}
          </select>
        )}
      </div>

      <div>
        <div className="mb-1 flex items-baseline justify-between">
          <label className={labelClass.replace('mb-1 ', '')}>
            {countryCode === 'IR' ? (fa ? 'شهرستان' : 'City / County') : fa ? 'شهر' : 'City'} *
          </label>
          <button
            type="button"
            className={addLink}
            disabled={busy || !provinceId}
            onClick={() => setAddingCity((v) => !v)}
          >
            {addingCity ? (fa ? 'انصراف' : 'cancel') : fa ? '+ افزودن' : '+ add'}
          </button>
        </div>

        {addingCity ? (
          <div className="space-y-1.5">
            <input
              className={inputClass}
              autoFocus
              value={newCity.en}
              onChange={(e) => setNewCity((s) => ({ ...s, en: e.target.value }))}
              placeholder={fa ? 'نام لاتین شهر' : 'City name'}
            />
            <input
              className={inputClass}
              value={newCity.faName}
              onChange={(e) => setNewCity((s) => ({ ...s, faName: e.target.value }))}
              placeholder={fa ? 'نام فارسی (اختیاری)' : 'Persian name (optional)'}
            />
            <button
              type="button"
              onClick={createCity}
              disabled={busy || !newCity.en.trim()}
              className="w-full rounded-lg bg-accent/20 py-1.5 text-xs font-medium text-accent hover:bg-accent/30 disabled:opacity-50"
            >
              {busy ? (fa ? 'در حال ذخیره…' : 'Saving…') : fa ? 'افزودن شهر' : 'Add city'}
            </button>
          </div>
        ) : (
          <select
            className={inputClass}
            value={cityId}
            onChange={(e) => onChange({ countryCode, provinceId, cityId: e.target.value })}
            disabled={!provinceId}
          >
            <option value="">{provinceId ? '—' : fa ? 'ابتدا استان را انتخاب کنید' : 'Select a region first'}</option>
            {citiesInProvince.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name_en} / {c.name_fa}
              </option>
            ))}
          </select>
        )}
      </div>

      {err && (
        <div className="sm:col-span-2">
          <p className="rounded-lg border border-status-critical/40 bg-status-critical/10 px-3 py-2 text-xs text-status-critical">
            {err}
          </p>
        </div>
      )}
    </>
  );
}
