/**
 * Чистый parser ответа POST /api/2/menu/by_id, портирующий рабочую логику
 * iiko_drinks_extractor.py. Не выполняет сетевых запросов и не логирует меню.
 */

export interface ParsedMenuVariant {
  organizationId: string;
  iikoItemId: string;
  iikoSizeId: string | null;
  iikoProductId: string | null;
  name: string;
  displayName: string;
  sizeName: string | null;
  sizeCode: string | null;
  sku: string | null;
  categoryId: string | null;
  categoryName: string | null;
  basePrice: number;
  currency: string;
  isDrinkCandidate: boolean;
  isSellable: boolean;
  isAvailable: boolean;
  sourceMetadata: Record<string, unknown>;
  syncWarnings: string[];
}

export interface ParsedMenuResult {
  correlationId: string | null;
  sourceExternalMenuId: string | null;
  sourceMenuId: string | null;
  sourceItemCount: number;
  drinkCategoryCount: number;
  drinkCandidateCount: number;
  candidateWithFinitePriceCount: number;
  candidateWithPositivePriceCount: number;
  zeroPriceCandidateCount: number;
  skippedWithoutItemIdCount: number;
  skippedWithoutPriceCount: number;
  nonDrinkItemCount: number;
  variants: ParsedMenuVariant[];
  parserSamples: ParserSample[];
}

export interface ParserSample {
  itemName: string;
  itemKeys: string[];
  sizeName: string | null;
  sizeKeys: string[];
  pricesIsArray: boolean;
  pricesLength: number;
  firstPriceRaw: unknown;
  firstPriceKeys: string[];
  priceValue: unknown;
  priceValueType: 'number' | 'string' | 'boolean' | 'object' | 'undefined' | 'null';
  javascriptNumberConversion: number | null;
  positiveByPostmanRule: boolean;
  selectedPriceField: 'price' | null;
  coercedPositivePrice: number | null;
}

export interface ParseMenuOptions {
  organizationId: string;
  externalMenuId?: string;
  currency?: string;
}

const DRINK_CATEGORY_KEYWORDS = [
  'напитк',
  'ром',
  'ликер',
  'чаи',
  'чай',
  'разлив',
  'вода',
  'виски',
  'вино',
  'бар',
  'джин',
  'водка',
  'сок',
  'фреш',
  'кофе',
  'шоколад',
  'лимонад',
  'коктейль',
  'пиво',
  'энергетик',
] as const;

const DRINK_ITEM_KEYWORDS = [
  'кола',
  'спрайт',
  'фанта',
  'сок ',
  'фреш',
  'пиво',
  'вино',
  'виски',
  'водка',
  'джин',
  'ром',
  'чай',
  'кофе',
  'лимонад',
  'коктейль',
  'абсент',
  'текила',
  'вода ',
  'red bull',
  'gorilla',
  'боржоми',
  'асу',
  'asu',
  'fanta',
  'sprite',
  'cola',
  'pepsi',
  'пепси',
  'мохито',
  'айсти',
  'капучино',
  'американо',
  'латте',
  'эспрессо',
  'флэт уайт',
  'квас',
  'chivas',
  'jack daniels',
  'jagermeister',
] as const;

const FOOD_EXCLUSION_KEYWORDS = [
  'бургер',
  'стейк',
  'соус',
  'донер',
  'комбо',
  'крылышки',
  'ролл',
  'микс',
  'мясо',
  'картоф',
  'наггетсы',
  'кесадилья',
  'салат',
  'суп',
  'хлеб',
] as const;

export function parseExternalMenu(
  raw: unknown,
  options: ParseMenuOptions,
): ParsedMenuResult {
  const root = asRecord(raw);
  const categoryMap = new Map<string, string>();

  for (const categoryRaw of asArray(root?.productCategories)) {
    const category = asRecord(categoryRaw);
    const id = optionalString(category?.id);
    const name = optionalString(category?.name);
    if (id && name) categoryMap.set(id, name);
  }

  const drinkCategoryIds = new Set(
    [...categoryMap]
      .filter(([, name]) => containsAny(name.toLowerCase(), DRINK_CATEGORY_KEYWORDS))
      .map(([id]) => id),
  );
  const items = asArray(root?.itemCategories).flatMap((categoryRaw) =>
    asArray(asRecord(categoryRaw)?.items),
  );
  const variants: ParsedMenuVariant[] = [];
  const parserSamples: ParserSample[] = [];
  let drinkCandidateCount = 0;
  let candidateWithPositivePriceCount = 0;
  let zeroPriceCandidateCount = 0;
  let skippedWithoutItemIdCount = 0;
  let skippedWithoutPriceCount = 0;
  let nonDrinkItemCount = 0;

  for (const itemRaw of items) {
    const item = asRecord(itemRaw);
    if (!item) {
      nonDrinkItemCount += 1;
      continue;
    }

    const name = optionalString(item.name) ?? 'Без названия';
    const nameLower = name.toLowerCase();
    const categoryId = optionalString(item.productCategoryId) ?? null;
    const categoryMatch = categoryId !== null && drinkCategoryIds.has(categoryId);
    const nameMatch =
      containsAny(nameLower, DRINK_ITEM_KEYWORDS) &&
      !containsAny(nameLower, FOOD_EXCLUSION_KEYWORDS);
    if (!categoryMatch && !nameMatch) {
      nonDrinkItemCount += 1;
      continue;
    }

    drinkCandidateCount += 1;
    const itemId = optionalString(item.itemId) ?? optionalString(item.id);
    if (!itemId) {
      skippedWithoutItemIdCount += 1;
      continue;
    }

    const sizes = asArray(item.itemSizes);
    if (sizes.length === 0) {
      skippedWithoutPriceCount += 1;
      continue;
    }

    for (let sizeIndex = 0; sizeIndex < sizes.length; sizeIndex += 1) {
      const size = asRecord(sizes[sizeIndex]);
      const sizeName = optionalString(size?.sizeName) ?? optionalString(size?.name) ?? null;
      const pricesRaw = size?.prices;
      const prices = asArray(pricesRaw);
      const selectedPrice = selectFinitePrice(prices, options.organizationId);

      if (parserSamples.length < 3) {
        parserSamples.push(
          buildParserSample(item, name, size ?? {}, sizeName, pricesRaw, selectedPrice),
        );
      }
      if (!selectedPrice) {
        skippedWithoutPriceCount += 1;
        continue;
      }

      const sizeId = optionalString(size?.sizeId) ?? optionalString(size?.id) ?? null;
      const sellable = selectedPrice.numericPrice > 0;
      if (sellable) candidateWithPositivePriceCount += 1;
      if (selectedPrice.numericPrice === 0) zeroPriceCandidateCount += 1;

      variants.push({
        organizationId: options.organizationId,
        iikoItemId: itemId,
        iikoSizeId: sizeId,
        iikoProductId: itemId,
        name,
        displayName: sizeName ? `${name} · ${sizeName}` : name,
        sizeName,
        sizeCode: optionalString(size?.sizeCode) ?? null,
        sku: optionalString(item.sku) ?? null,
        categoryId,
        categoryName: categoryId ? (categoryMap.get(categoryId) ?? null) : null,
        basePrice: selectedPrice.numericPrice,
        currency: options.currency ?? 'KZT',
        isDrinkCandidate: true,
        isSellable: sellable,
        isAvailable: sellable,
        sourceMetadata: {
          sourcePrice: selectedPrice.sourcePrice,
          sourcePriceOrganizationId: selectedPrice.organizationId,
          originalItemId: item.itemId ?? item.id ?? null,
          originalSizeId: size?.sizeId ?? size?.id ?? null,
          sizeIndex,
          isDefault: size?.isDefault ?? null,
        },
        syncWarnings: [],
      });
    }
  }

  return {
    correlationId: optionalString(root?.correlationId) ?? null,
    sourceExternalMenuId:
      options.externalMenuId ?? optionalString(root?.externalMenuId) ?? null,
    sourceMenuId: optionalString(root?.id) ?? optionalString(root?.menuId) ?? null,
    sourceItemCount: items.length,
    drinkCategoryCount: drinkCategoryIds.size,
    drinkCandidateCount,
    candidateWithFinitePriceCount: variants.length,
    candidateWithPositivePriceCount,
    zeroPriceCandidateCount,
    skippedWithoutItemIdCount,
    skippedWithoutPriceCount,
    nonDrinkItemCount,
    variants,
    parserSamples,
  };
}

interface SelectedPrice {
  numericPrice: number;
  sourcePrice: unknown;
  organizationId: string | null;
}

function selectFinitePrice(prices: unknown[], organizationId: string): SelectedPrice | null {
  let fallback: SelectedPrice | null = null;

  for (const priceRaw of prices) {
    const price = asRecord(priceRaw);
    if (!price || price.price === null) continue;
    const numericPrice = Number(price.price);
    if (!Number.isFinite(numericPrice)) continue;
    const selected = {
      numericPrice,
      sourcePrice: price.price,
      organizationId: optionalString(price.organizationId) ?? null,
    };
    if (selected.organizationId === organizationId) return selected;
    fallback ??= selected;
  }

  return fallback;
}

function buildParserSample(
  item: Record<string, unknown>,
  itemName: string,
  size: Record<string, unknown>,
  sizeName: string | null,
  pricesRaw: unknown,
  selectedPrice: SelectedPrice | null,
): ParserSample {
  const prices = asArray(pricesRaw);
  const firstPriceRaw = prices[0];
  const firstPrice = asRecord(firstPriceRaw);
  const priceValue = firstPrice?.price;
  const numberConversion = safelyConvertWithNumber(priceValue);

  return {
    itemName,
    itemKeys: safeKeys(item),
    sizeName,
    sizeKeys: safeKeys(size),
    pricesIsArray: Array.isArray(pricesRaw),
    pricesLength: prices.length,
    firstPriceRaw: sanitizeDiagnosticValue(firstPriceRaw),
    firstPriceKeys: firstPrice ? safeKeys(firstPrice) : [],
    priceValue: sanitizeDiagnosticValue(priceValue),
    priceValueType: valueType(priceValue),
    javascriptNumberConversion: numberConversion,
    positiveByPostmanRule: priceValue !== null && numberConversion !== null && numberConversion > 0,
    selectedPriceField: selectedPrice ? 'price' : null,
    coercedPositivePrice:
      selectedPrice && selectedPrice.numericPrice > 0 ? selectedPrice.numericPrice : null,
  };
}

function containsAny(value: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => value.includes(keyword));
}

const SENSITIVE_DIAGNOSTIC_KEY =
  /authorization|api[-_]?key|api[-_]?login|app[-_]?id|client[-_]?secret|bearer|token|secret/i;

function safeKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).filter((key) => !SENSITIVE_DIAGNOSTIC_KEY.test(key));
}

function sanitizeDiagnosticValue(value: unknown, depth = 0): unknown {
  if (depth > 3) return null;
  if (Array.isArray(value)) {
    return value.slice(0, 10).map((entry) => sanitizeDiagnosticValue(entry, depth + 1));
  }
  const record = asRecord(value);
  if (record) {
    return Object.fromEntries(
      safeKeys(record).map((key) => [key, sanitizeDiagnosticValue(record[key], depth + 1)]),
    );
  }
  return value === undefined ? null : value;
}

function safelyConvertWithNumber(value: unknown): number | null {
  try {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  } catch {
    return null;
  }
}

function valueType(value: unknown): ParserSample['priceValueType'] {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  return typeof value as ParserSample['priceValueType'];
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
