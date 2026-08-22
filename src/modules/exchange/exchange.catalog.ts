export interface ExchangeSeedProduct {
  slug: string;
  name: string;
  category: string;
  /** Цена меню без скидки — база расчёта ручной скидки. */
  originalPrice: number;
  /** Стартовая цена биржи; по бизнес-правилу равна minPrice. */
  startPrice: number;
  minPrice: number;
  volumeMl: number | null;
}

export const EXCHANGE_CATEGORIES = [
  'Крепкий алкоголь',
  'Пиво',
  'Бутылочное пиво',
  'Коктейли',
] as const;

// [slug, название, категория, originalPrice, startPrice (= minPrice), minPrice, volumeMl]
export const EXCHANGE_PRODUCTS: ExchangeSeedProduct[] = [
  ['german', 'Немецкое', 'Пиво', 1190, 790, 790, 50],
  ['beefeater', 'Beefeater', 'Крепкий алкоголь', 2000, 1590, 1590, 50],
  ['jagermeister', 'Jägermeister', 'Крепкий алкоголь', 2000, 1590, 1590, 50],
  ['oakheart', 'Oakheart', 'Крепкий алкоголь', 2000, 1590, 1590, 50],
  ['bacardi-black', 'Bacardi Black', 'Крепкий алкоголь', 1600, 1190, 1190, 50],
  ['ballantines', 'Ballantines', 'Крепкий алкоголь', 2000, 1590, 1590, 50],
  ['jameson', 'Jameson', 'Крепкий алкоголь', 2000, 1590, 1590, 50],
  ['chivas', 'Chivas', 'Крепкий алкоголь', 3000, 2590, 2590, 50],
  ['jack-daniels', 'Jack Daniels', 'Крепкий алкоголь', 3000, 2590, 2590, 50],
  ['monkey-shoulder', 'Monkey Shoulder', 'Крепкий алкоголь', 3500, 2990, 2990, 50],
  ['absolut', 'Absolut', 'Крепкий алкоголь', 1450, 990, 990, 50],
  ['nemiroff', 'Nemiroff', 'Крепкий алкоголь', 1300, 890, 890, 50],
  ['khortytsa-ice', 'Хортица Айс', 'Крепкий алкоголь', 890, 590, 590, 50],
  ['kyzylzhar', 'Кызылжар', 'Крепкий алкоголь', 790, 590, 590, 50],
  ['miller-bottle', 'Миллер', 'Бутылочное пиво', 1650, 990, 990, null],
  ['bud-bottle', 'Bud', 'Бутылочное пиво', 2190, 990, 990, null],
  ['corona-extra', 'Corona Extra', 'Бутылочное пиво', 2990, 2590, 2590, null],
  ['paulaner', 'Paulaner', 'Бутылочное пиво', 2500, 1990, 1990, null],
  ['tsingtao', 'Tsingtao', 'Бутылочное пиво', 2500, 1990, 1990, null],
  ['hoegaarden', 'Hoegaarden', 'Бутылочное пиво', 2500, 1990, 1990, null],
  ['red-bull-vodka', 'Red Bull Vodka', 'Коктейли', 3200, 2190, 2190, null],
  ['red-bull-jager', 'Red Bull Jäger', 'Коктейли', 3200, 2190, 2190, null],
  ['gin-tonic', 'Gin Tonic', 'Коктейли', 3200, 2190, 2190, null],
  ['red-bull-whiskey', 'Red Bull Whiskey', 'Коктейли', 3200, 2190, 2190, null],
  ['mojito', 'Mojito', 'Коктейли', 2800, 1890, 1890, null],
  ['long-island', 'Long Island', 'Коктейли', 3500, 2490, 2490, null],
  ['whiskey-sour', 'Whiskey Sour', 'Коктейли', 3200, 2190, 2190, null],
].map(([slug, name, category, originalPrice, startPrice, minPrice, volumeMl]) => ({
  slug: slug as string,
  name: name as string,
  category: category as string,
  originalPrice: originalPrice as number,
  startPrice: startPrice as number,
  minPrice: minPrice as number,
  volumeMl: volumeMl as number | null,
}));

export const EXCHANGE_TIMEZONE = 'Asia/Almaty';
export const EXCHANGE_INTERVAL_MINUTES = 15;
