/**
 * Чистый парсер полного внешнего меню iiko (ответ POST /api/2/menu/by_id).
 *
 * Не выполняет сетевых запросов и не логирует сырое тело меню.
 *
 * Фактическая структура ответа /api/2/menu/by_id:
 *   {
 *     correlationId,
 *     productCategories: [{ id, name, isDeleted? }],
 *     itemCategories: [{ items: [{ id, name, sku?, productCategoryId?, itemSizes: [...] }] }]
 *   }
 *
 * Извлекает sellable item-size-price variants:
 *   - товар не hidden/disabled/archived (когда флаги есть);
 *   - товар имеет itemSizes;
 *   - размер имеет хотя бы одну безопасно преобразуемую цену > 0;
 *   - organization metadata и дополнительные поля price record не влияют на импорт;
 *   - null/0/отрицательные/NaN/мусорные цены игнорируются.
 *
 * Каждый item + size с положительной ценой = отдельная нормализованная строка-вариант.
 * Max-price collapse НЕ используется: товар с размерами 0.3L и 0.5L = две строки.
 * Для размера выбирается первая положительная цена в порядке полей initial import.
 */

export interface ParsedMenuVariant {
  organizationId: string;
  iikoItemId: string;
  /** ID размера; fallback `__no_size__` только если размер реально без id. */
  iikoSizeId: string;
  /** Сырой iiko product id (может совпадать с iikoItemId или быть иным). */
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
  isSellable: boolean;
  isAvailable: boolean;
  sourceMetadata: Record<string, unknown>;
  syncWarnings: string[];
}

export interface ParsedMenuResult {
  correlationId: string | null;
  sourceExternalMenuId: string | null;
  sourceMenuId: string | null;
  sourceCategoryCount: number;
  sourceItemCount: number;
  variants: ParsedMenuVariant[];
  skippedNoSizes: number;
  skippedHidden: number;
  skippedZeroPrice: number;
  skippedMalformedPrice: number;
  skippedAmbiguousPrice: number;
  warnings: string[];
  /**
   * Безопасные реальные samples не более чем для трёх item+size.
   * Никогда не содержат API key, token, client secret или полное меню.
   */
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
  selectedPriceField: 'price' | 'currentPrice' | 'amount' | 'value' | 'primitive' | null;
  coercedPositivePrice: number | null;
}

const NO_SIZE_FALLBACK = '__no_size__';

export interface ParseMenuOptions {
  organizationId: string;
  externalMenuId?: string;
  currency?: string;
}

/**
 * Разбирает сырой ответ /api/2/menu/by_id и извлекает sellable variants.
 * Защищённо читает productCategories (id -> name) и itemCategories[].items[].
 */
export function parseExternalMenu(
  raw: unknown,
  options: ParseMenuOptions,
): ParsedMenuResult {
  const root = asRecord(raw);
  const warnings: string[] = [];

  const correlationId = optionalString(root?.correlationId) ?? null;
  const sourceExternalMenuId =
    options.externalMenuId ?? optionalString(root?.externalMenuId) ?? null;
  const sourceMenuId = optionalString(root?.id) ?? optionalString(root?.menuId) ?? null;

  // Карта категорий: productCategories[].id -> name.
  // Также читаем альтернативные имена полей на случай вариаций API.
  const categoryMap = new Map<string, string>();
  const deletedCategoryIds = new Set<string>();
  for (const entry of asArray(root?.productCategories)) {
    const record = asRecord(entry);
    const id = optionalString(record?.id);
    const name = optionalString(record?.name) ?? optionalString(record?.title);
    if (id && name) {
      categoryMap.set(id, name);
      if (isFlagTrue(record?.isDeleted) || isFlagTrue(record?.hidden)) {
        deletedCategoryIds.add(id);
      }
    }
  }
  // Запасные источники категорий.
  for (const entry of asArray(root?.itemCategories)) {
    const record = asRecord(entry);
    const id = optionalString(record?.id);
    const name = optionalString(record?.name) ?? optionalString(record?.title);
    if (id && name && !categoryMap.has(id)) {
      categoryMap.set(id, name);
    }
  }

  // Товары живут ВНУТРИ itemCategories[].items[] (НЕ в корневом items).
  const items: unknown[] = [];
  for (const categoryRaw of asArray(root?.itemCategories)) {
    const category = asRecord(categoryRaw);
    if (isFlagTrue(category?.isDeleted) || isFlagTrue(category?.hidden)) continue;
    for (const item of asArray(category?.items)) {
      items.push(item);
    }
  }
  // На случай альтернативной формы с корневым items — читаем и его.
  for (const item of asArray(root?.items)) {
    items.push(item);
  }

  let skippedNoSizes = 0;
  let skippedHidden = 0;
  let skippedZeroPrice = 0;
  let skippedMalformedPrice = 0;
  const skippedAmbiguousPrice = 0;
  const variants: ParsedMenuVariant[] = [];
  const currency = options.currency ?? 'KZT';
  const parserSamples: ParserSample[] = [];

  for (const itemRaw of items) {
    const item = asRecord(itemRaw);
    const itemId = optionalString(item?.id) ?? optionalString(item?.productId);
    if (!itemId) {
      continue;
    }

    // hidden/disabled/archived flags (когда есть).
    if (
      isFlagTrue(item?.hidden) ||
      isFlagTrue(item?.disabled) ||
      isFlagTrue(item?.isDeleted) ||
      isFlagTrue(item?.archived) ||
      isFlagTrue(item?.isHidden)
    ) {
      skippedHidden += 1;
      continue;
    }

    const itemName =
      optionalString(item?.name) ?? optionalString(item?.title) ?? 'Без названия';
    const sku = optionalString(item?.sku) ?? optionalString(item?.code) ?? null;
    const categoryId =
      optionalString(item?.productCategoryId) ??
      optionalString(item?.groupId) ??
      optionalString(item?.parentGroup) ??
      null;
    const categoryName = categoryId ? (categoryMap.get(categoryId) ?? null) : null;
    if (categoryId && deletedCategoryIds.has(categoryId)) {
      skippedHidden += 1;
      continue;
    }

    const sizes = asArray(item?.itemSizes);
    if (sizes.length === 0) {
      skippedNoSizes += 1;
      continue;
    }

    for (let sizeIndex = 0; sizeIndex < sizes.length; sizeIndex += 1) {
      const sizeRaw = asRecord(sizes[sizeIndex]);
      const sizeId =
        optionalString(sizeRaw?.id) ??
        optionalString(sizeRaw?.sizeId) ??
        // Детерминированный fallback только если у размера нет id.
        (sizes.length > 1 ? `${NO_SIZE_FALLBACK}_${sizeIndex}` : NO_SIZE_FALLBACK);

      const sizeName =
        optionalString(sizeRaw?.name) ??
        optionalString(sizeRaw?.sizeName) ??
        optionalString(sizeRaw?.title) ??
        null;
      const sizeCode = optionalString(sizeRaw?.sizeCode) ?? optionalString(sizeRaw?.code) ?? null;

      const pricesRaw = sizeRaw?.prices;
      const prices = asArray(pricesRaw);
      const chosen = chooseFirstPositivePrice(prices);

      if (parserSamples.length < 3) {
        parserSamples.push(
          buildParserSample(item ?? {}, itemName, sizeRaw ?? {}, sizeName, pricesRaw, chosen),
        );
      }

      if (chosen.kind === 'zero') {
        skippedZeroPrice += 1;
        continue;
      }
      if (chosen.kind === 'malformed') {
        skippedMalformedPrice += 1;
        continue;
      }

      const displayName = buildDisplayName(itemName, sizeName);
      const variantWarnings: string[] = [];

      variants.push({
        organizationId: options.organizationId,
        iikoItemId: itemId,
        iikoSizeId: sizeId,
        iikoProductId: optionalString(item?.productId) ?? itemId,
        name: itemName,
        displayName,
        sizeName,
        sizeCode,
        sku,
        categoryId,
        categoryName,
        basePrice: chosen.price,
        currency,
        isSellable: true,
        isAvailable: true,
        sourceMetadata: {
          sizeIndex,
          pricesCount: prices.length,
        },
        syncWarnings: variantWarnings,
      });
    }
  }

  return {
    correlationId,
    sourceExternalMenuId,
    sourceMenuId,
    sourceCategoryCount: categoryMap.size,
    sourceItemCount: items.length,
    variants,
    skippedNoSizes,
    skippedHidden,
    skippedZeroPrice,
    skippedMalformedPrice,
    skippedAmbiguousPrice,
    warnings,
    parserSamples,
  };
}

type PriceField = 'price' | 'currentPrice' | 'amount' | 'value' | 'primitive';
type PriceChoice =
  | { kind: 'ok'; price: number; field: PriceField }
  | { kind: 'zero'; field: null }
  | { kind: 'malformed'; field: null };

function chooseFirstPositivePrice(prices: unknown[]): PriceChoice {
  let hasFinitePrice = false;

  for (const priceRaw of prices) {
    const priceRecord = asRecord(priceRaw);
    const candidates: Array<{ field: PriceField; value: unknown }> = priceRecord
      ? [
          { field: 'price', value: priceRecord.price },
          { field: 'currentPrice', value: priceRecord.currentPrice },
          { field: 'amount', value: priceRecord.amount },
          { field: 'value', value: priceRecord.value },
        ]
      : [{ field: 'primitive', value: priceRaw }];

    for (const candidate of candidates) {
      const finite = coerceFinitePrice(candidate.value);
      if (finite === null) continue;
      hasFinitePrice = true;
      const positive = coercePositivePrice(candidate.value);
      if (positive !== null) {
        return { kind: 'ok', price: positive, field: candidate.field };
      }
    }
  }

  return hasFinitePrice ? { kind: 'zero', field: null } : { kind: 'malformed', field: null };
}

function buildDisplayName(name: string, sizeName: string | null): string {
  if (sizeName && sizeName.length > 0) {
    return `${name} · ${sizeName}`;
  }
  return name;
}

/**
 * Нормализует значение цены из любого примитивного типа.
 * Принимает:
 *   - number (2500, 25.5);
 *   - numeric string ("2500");
 *   - decimal string ("2500.00");
 *   - comma decimal string ("2500,00").
 * Возвращает number > 0 или null для мусора/нуля/отрицательных.
 */
export function coercePositivePrice(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (typeof value === 'string') {
    value = value.trim().replace(',', '.');
  }

  const numeric = Number(value);

  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

export const normalizePositivePrice = coercePositivePrice;

function coerceFinitePrice(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const normalized = typeof value === 'string' ? value.trim().replace(',', '.') : value;
  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? numeric : null;
}

function buildParserSample(
  item: Record<string, unknown>,
  itemName: string,
  size: Record<string, unknown>,
  sizeName: string | null,
  pricesRaw: unknown,
  chosen: PriceChoice,
): ParserSample {
  const prices = asArray(pricesRaw);
  const firstPriceRaw = prices[0];
  const firstPrice = asRecord(firstPriceRaw);
  const priceValue = firstPrice ? firstPrice.price : firstPriceRaw;
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
    selectedPriceField: chosen.kind === 'ok' ? chosen.field : null,
    coercedPositivePrice: chosen.kind === 'ok' ? chosen.price : null,
  };
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

function isFlagTrue(value: unknown): boolean {
  return value === true || value === 1 || value === 'true' || value === '1';
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
