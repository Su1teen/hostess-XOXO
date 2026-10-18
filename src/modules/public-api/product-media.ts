/** Only verified, repository-owned product photographs are exposed. */
export const PRODUCT_PHOTOS: Readonly<Record<string, string>> = {
  german: 'german.jpg', beefeater: 'beefeater.jpg', jagermeister: 'jagermeister.jpg',
  oakheart: 'okheart.jpg', 'bacardi-black': 'bacardi.jpeg', ballantines: 'ballatines.webp',
  jameson: 'jameson.jpg', chivas: 'chivas.jpg', 'monkey-shoulder': 'monkeyshoulder.jpg',
  absolut: 'absolut.jpeg', nemiroff: 'nemoriff.jpg', 'miller-bottle': 'miller.jpeg',
  'bud-bottle': 'buds.jpg', 'corona-extra': 'corona extra.jpeg', tsingtao: 'tsintao.jpg',
  hoegaarden: 'hoegaarden.jpg', 'red-bull-vodka': 'rebullvodka.jpg',
};

export function productImageUrl(slug: string | undefined, origin = 'https://hostess-xoxo-production.up.railway.app'): string | null {
  return slug && PRODUCT_PHOTOS[slug] ? new URL(`/api/v1/public/product-images/${slug}`, origin).href : null;
}
