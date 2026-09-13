// Reference geography for the platform. Deliberately province + city ONLY — see docs/ARCHITECTURE.md §9.
// No coordinates exist anywhere in this file or in anything derived from it.

export interface Province {
  id: string;
  nameEn: string;
  nameFa: string;
}

export interface City {
  id: string;
  provinceId: string;
  nameEn: string;
  nameFa: string;
}

export const PROVINCES: Province[] = [
  { id: 'IR-THR', nameEn: 'Tehran', nameFa: 'تهران' },
  { id: 'IR-ESF', nameEn: 'Isfahan', nameFa: 'اصفهان' },
  { id: 'IR-KER', nameEn: 'Kerman', nameFa: 'کرمان' },
  { id: 'IR-FAR', nameEn: 'Fars', nameFa: 'فارس' },
  { id: 'IR-KRZ', nameEn: 'Khorasan Razavi', nameFa: 'خراسان رضوی' },
  { id: 'IR-KHZ', nameEn: 'Khuzestan', nameFa: 'خوزستان' },
  { id: 'IR-EAZ', nameEn: 'East Azerbaijan', nameFa: 'آذربایجان شرقی' },
  { id: 'IR-ALB', nameEn: 'Alborz', nameFa: 'البرز' },
  { id: 'IR-QOM', nameEn: 'Qom', nameFa: 'قم' },
  { id: 'IR-YAZ', nameEn: 'Yazd', nameFa: 'یزد' },
  { id: 'IR-SEM', nameEn: 'Semnan', nameFa: 'سمنان' },
  { id: 'IR-HOR', nameEn: 'Hormozgan', nameFa: 'هرمزگان' },
  { id: 'IR-MKZ', nameEn: 'Markazi', nameFa: 'مرکزی' },
];

export const CITIES: City[] = [
  { id: 'city_tehran', provinceId: 'IR-THR', nameEn: 'Tehran', nameFa: 'تهران' },
  { id: 'city_shahriar', provinceId: 'IR-THR', nameEn: 'Shahriar', nameFa: 'شهریار' },
  { id: 'city_rey', provinceId: 'IR-THR', nameEn: 'Rey', nameFa: 'ری' },
  { id: 'city_eslamshahr', provinceId: 'IR-THR', nameEn: 'Eslamshahr', nameFa: 'اسلام‌شهر' },

  { id: 'city_isfahan', provinceId: 'IR-ESF', nameEn: 'Isfahan', nameFa: 'اصفهان' },
  { id: 'city_mobarakeh', provinceId: 'IR-ESF', nameEn: 'Mobarakeh', nameFa: 'مبارکه' },
  { id: 'city_kashan', provinceId: 'IR-ESF', nameEn: 'Kashan', nameFa: 'کاشان' },

  { id: 'city_kerman', provinceId: 'IR-KER', nameEn: 'Kerman', nameFa: 'کرمان' },
  { id: 'city_sirjan', provinceId: 'IR-KER', nameEn: 'Sirjan', nameFa: 'سیرجان' },
  { id: 'city_rafsanjan', provinceId: 'IR-KER', nameEn: 'Rafsanjan', nameFa: 'رفسنجان' },

  { id: 'city_shiraz', provinceId: 'IR-FAR', nameEn: 'Shiraz', nameFa: 'شیراز' },
  { id: 'city_marvdasht', provinceId: 'IR-FAR', nameEn: 'Marvdasht', nameFa: 'مرودشت' },

  { id: 'city_mashhad', provinceId: 'IR-KRZ', nameEn: 'Mashhad', nameFa: 'مشهد' },
  { id: 'city_neyshabur', provinceId: 'IR-KRZ', nameEn: 'Neyshabur', nameFa: 'نیشابور' },

  { id: 'city_ahvaz', provinceId: 'IR-KHZ', nameEn: 'Ahvaz', nameFa: 'اهواز' },
  { id: 'city_abadan', provinceId: 'IR-KHZ', nameEn: 'Abadan', nameFa: 'آبادان' },

  { id: 'city_tabriz', provinceId: 'IR-EAZ', nameEn: 'Tabriz', nameFa: 'تبریز' },

  { id: 'city_karaj', provinceId: 'IR-ALB', nameEn: 'Karaj', nameFa: 'کرج' },

  { id: 'city_qom', provinceId: 'IR-QOM', nameEn: 'Qom', nameFa: 'قم' },

  { id: 'city_yazd', provinceId: 'IR-YAZ', nameEn: 'Yazd', nameFa: 'یزد' },

  { id: 'city_semnan', provinceId: 'IR-SEM', nameEn: 'Semnan', nameFa: 'سمنان' },
  { id: 'city_damghan', provinceId: 'IR-SEM', nameEn: 'Damghan', nameFa: 'دامغان' },

  { id: 'city_bandar_abbas', provinceId: 'IR-HOR', nameEn: 'Bandar Abbas', nameFa: 'بندرعباس' },

  { id: 'city_arak', provinceId: 'IR-MKZ', nameEn: 'Arak', nameFa: 'اراک' },
];
