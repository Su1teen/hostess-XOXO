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
 *   - размер имеет хотя бы одну валидную числовую цену > 0;
 *   - если у price есть organizations, список должен содержать organizationId;
 *   - null/0/отрицательные/NaN/мусорные цены игнорируются.
 *
 * Каждый item + size + валидная цена = отдельная нормализованная строка-вариант.
 * Max-price collapse НЕ используется: товар с размерами 0.3L и 0.5L = две строки.
 * Если у размера несколько положительных цен и нельзя однозначно выбрать
 * (нет организации-матча и цен больше одной) — размер пропускается с warning,
 * без произвольного выбора max price.
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
   * Безопасная диагностика первого item+size для разработки.
   * Никогда не содержит API key, token, client secret или полное меню.
   * Содержит только имена полей и типы — не значения.
   */
  diagnostic: ParserDiagnostic | null;
}

/**
 * Безопасная диагностика парсера для одного sample item+size.
 * Только имена/типы — никогда не значения секретов или сырого тела.
 */
export interface ParserDiagnostic {
  firstItemName: string | null;
  firstSizeName: string | null;
  pricesArrayLength: number;
  priceValueType: 'number' | 'string' | 'boolean' | 'object' | 'undefined' | 'null' | null;
  priceObjectKeys: string[];
  validPositivePriceCount: number;
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
  let skippedAmbiguousPrice = 0;
  const variants: ParsedMenuVariant[] = [];
  const currency = options.currency ?? 'KZT';
  let diagnostic: ParserDiagnostic | null = null;

  for (const itemRaw of items) {
    const item = asRecord(itemRaw);
    const itemId = optionalString(item?.id) ?? optionalString(item?.productId);
    if (!itemId) {
      skippedMalformedPrice += 1;
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

      const prices = asArray(sizeRaw?.prices);
      if (prices.length === 0) {
        skippedZeroPrice += 1;
        continue;
      }

      // Собираем safe-диагностику для первого item+size с prices.
      if (!diagnostic) {
        diagnostic = buildParserDiagnostic(itemName, sizeName, prices);
      }

      const chosen = choosePrice(prices, options.organizationId, warnings, itemId, sizeId);
      if (chosen.kind === 'zero') {
        skippedZeroPrice += 1;
        continue;
      }
      if (chosen.kind === 'malformed') {
        skippedMalformedPrice += 1;
        continue;
      }
      if (chosen.kind === 'ambiguous') {
        skippedAmbiguousPrice += 1;
        continue;
      }

      const displayName = buildDisplayName(itemName, sizeName);
      const variantWarnings: string[] = [];
      if (!chosen.orgMatched) {
        variantWarnings.push('price_organization_match_unavailable');
      }

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
    diagnostic,
  };
}

type PriceChoice =
  | { kind: 'ok'; price: number; orgMatched: boolean }
  | { kind: 'zero' }
  | { kind: 'malformed' }
  | { kind: 'ambiguous' };

/**
 * Выбирает применимую цену для размера.
 * - prefer цену с organizationId (single string) или organizations (array),
 *   содержащим organizationId;
 * - иначе, если положительная цена единственна — берём её;
 * - если положительных цен несколько и нет орг-матча — ambiguous (пропуск),
 *   НЕ используем max price как каноническую.
 */
function choosePrice(
  prices: unknown[],
  organizationId: string,
  warnings: string[],
  itemId: string,
  sizeId: string,
): PriceChoice {
  let malformed = false;
  const orgMatches: number[] = [];
  const positiveGeneric: number[] = [];

  for (const priceRaw of prices) {
    const priceRecord = asRecord(priceRaw);
    const candidate = readPrice(priceRecord);
    if (candidate === null) {
      malformed = true;
      continue;
    }
    if (!(candidate > 0)) {
      // null/0/отрицательные/NaN — пропускаем эту цену.
      continue;
    }
    // Поддерживаем два формата iiko:
    //   - newer: { organizationId: "uuid", price: "2500" }
    //   - older: { organizations: ["uuid"], price: 2500 }
    const orgIdField = optionalString(priceRecord?.organizationId);
    const orgs = asArray(priceRecord?.organizations);
    if (orgIdField) {
      if (orgIdField === organizationId) {
        orgMatches.push(candidate);
      }
      // Цена с organizationId, но не нашим — не учитываем как generic.
    } else if (orgs.length > 0) {
      const belongs = orgs.some(
        (org) => optionalString(asRecord(org)?.id) === organizationId,
      );
      if (belongs) {
        orgMatches.push(candidate);
      }
      // Цены с organizations, но не нашей — не учитываем как generic.
    } else {
      positiveGeneric.push(candidate);
    }
  }

  if (orgMatches.length === 1) {
    return { kind: 'ok', price: orgMatches[0]!, orgMatched: true };
  }
  if (orgMatches.length > 1) {
    warnings.push(`item ${itemId} size ${sizeId}: несколько орг-цен — пропущено (ambiguous)`);
    return { kind: 'ambiguous' };
  }
  // Нет орг-матча.
  if (positiveGeneric.length === 1) {
    return { kind: 'ok', price: positiveGeneric[0]!, orgMatched: false };
  }
  if (positiveGeneric.length > 1) {
    warnings.push(
      `item ${itemId} size ${sizeId}: несколько положительных цен без орг-матча — пропущено (ambiguous, max не используется)`,
    );
    return { kind: 'ambiguous' };
  }
  // Ни одной положительной цены.
  if (malformed) {
    return { kind: 'malformed' };
  }
  return { kind: 'zero' };
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
export function normalizePositivePrice(value: unknown): number | null {
  const parsed = parsePriceValue(value);
  if (parsed === null) return null;
  return parsed > 0 ? parsed : null;
}

/**
 * Разбирает значение цены в number (включая 0 и отрицательные).
 * Возвращает null только для непарсируемого мусора.
 * Используется внутри readPrice, где нужно отличать "ноль" от "мусор".
 */
function parsePriceValue(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const normalized = Number(value.trim().replace(',', '.'));
    return Number.isFinite(normalized) ? normalized : null;
  }
  return null;
}

/**
 * Извлекает числовую цену из price-объекта iiko.
 * Проверяет все возможные расположения цены в реальном ответе /api/2/menu/by_id:
 *   - priceRecord.price          (number или string — основной формат v2 menu);
 *   - priceRecord.price.currentPrice (вложенный объект — формат v1 nomenclature);
 *   - priceRecord.amount         (альтернативное имя);
 *   - priceRecord.value          (альтернативное имя).
 * Возвращает number (включая 0 и отрицательные) или null для мусора.
 * Вызывающий (choosePrice) решает, является ли цена положительной.
 */
function readPrice(priceRecord: Record<string, unknown> | undefined): number | null {
  if (!priceRecord) return null;

  // 1. price как примитив (number или string) — основной формат /api/2/menu/by_id.
  const directPrice = priceRecord.price;
  if (typeof directPrice === 'number' || typeof directPrice === 'string') {
    return parsePriceValue(directPrice);
  }

  // 2. price как объект с currentPrice — формат v1 nomenclature sizePrices.
  const priceObj = asRecord(directPrice);
  if (priceObj) {
    const current = parsePriceValue(priceObj.currentPrice);
    if (current !== null) return current;
  }

  // 3. amount — альтернативное имя.
  const amount = parsePriceValue(priceRecord.amount);
  if (amount !== null) return amount;

  // 4. value — альтернативное имя.
  const value = parsePriceValue(priceRecord.value);
  if (value !== null) return value;

  return null;
}

/**
 * Строит безопасную диагностику парсера для первого item+size с prices.
 * Никогда не содержит значения секретов или полное тело меню — только
 * имена полей, типы и агрегированные счётчики.
 */
function buildParserDiagnostic(
  itemName: string,
  sizeName: string | null,
  prices: unknown[],
): ParserDiagnostic {
  const firstPrice = asRecord(prices[0]);
  const priceValue = firstPrice?.price;
  let priceValueType: ParserDiagnostic['priceValueType'] = null;
  if (priceValue === undefined) priceValueType = 'undefined';
  else if (priceValue === null) priceValueType = 'null';
  else if (typeof priceValue === 'number') priceValueType = 'number';
  else if (typeof priceValue === 'string') priceValueType = 'string';
  else if (typeof priceValue === 'boolean') priceValueType = 'boolean';
  else if (typeof priceValue === 'object') priceValueType = 'object';

  const priceObjectKeys = firstPrice ? Object.keys(firstPrice) : [];

  let validPositivePriceCount = 0;
  for (const priceRaw of prices) {
    const parsed = readPrice(asRecord(priceRaw));
    if (parsed !== null && parsed > 0) {
      validPositivePriceCount += 1;
    }
  }

  return {
    firstItemName: itemName,
    firstSizeName: sizeName,
    pricesArrayLength: prices.length,
    priceValueType,
    priceObjectKeys,
    validPositivePriceCount,
  };
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
