/**
 * Чистый парсер внешнего меню iiko (ответ POST /api/2/menu).
 *
 * Не выполняет сетевых запросов и не логирует сырое тело меню.
 * Извлекает только sellable item-size-price variants:
 *   - товар не hidden/disabled/archived (когда флаги есть);
 *   - товар имеет itemSizes;
 *   - размер имеет хотя бы одну валидную числовую цену > 0;
 *   - если у price есть organizations, список должен содержать organizationId;
 *   - null/0/отрицательные/NaN/мусорные цены игнорируются.
 *
 * Каждый item + size + валидная цена = отдельная нормализованная строка-вариант.
 * Max-price collapse НЕ используется: товар с размерами 0.3L и 0.5L = две строки.
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
  categoryCount: number;
  sourceItemCount: number;
  variants: ParsedMenuVariant[];
  skippedNoSizes: number;
  skippedHidden: number;
  skippedZeroPrice: number;
  skippedMalformedPrice: number;
  warnings: string[];
}

const NO_SIZE_FALLBACK = '__no_size__';

export interface ParseMenuOptions {
  organizationId: string;
  externalMenuId?: string;
  currency?: string;
}

/**
 * Разбирает сырой ответ /api/2/menu и извлекает sellable variants.
 * Формат ответа iiko может варьировать — парсер защищённо читает
 * категории из `groups`/`itemCategories`/`categories`, а товары из
 * `items`/`products`. Поле цены может быть как `price`, так и вложенным
 * `price.currentPrice`/`price.price`.
 */
export function parseExternalMenu(
  raw: unknown,
  options: ParseMenuOptions,
): ParsedMenuResult {
  const root = asRecord(raw);
  const warnings: string[] = [];

  const correlationId = optionalString(root?.correlationId) ?? null;
  const sourceExternalMenuId = options.externalMenuId ?? optionalString(root?.externalMenuId) ?? null;
  const sourceMenuId = optionalString(root?.id) ?? optionalString(root?.menuId) ?? null;

  // Карта категорий: id -> name. Источники могут называться по-разному.
  const categoryMap = new Map<string, string>();
  const categorySources = [
    asArray(root?.groups),
    asArray(root?.itemCategories),
    asArray(root?.categories),
  ];
  for (const list of categorySources) {
    for (const entry of list) {
      const record = asRecord(entry);
      const id = optionalString(record?.id);
      const name = optionalString(record?.name) ?? optionalString(record?.title);
      if (id && name) categoryMap.set(id, name);
    }
  }

  // Товары: items / products.
  const itemLists = [asArray(root?.items), asArray(root?.products)];
  const items: unknown[] = [];
  for (const list of itemLists) {
    for (const item of list) items.push(item);
  }

  let skippedNoSizes = 0;
  let skippedHidden = 0;
  let skippedZeroPrice = 0;
  let skippedMalformedPrice = 0;
  const variants: ParsedMenuVariant[] = [];
  const currency = options.currency ?? 'KZT';

  for (const itemRaw of items) {
    const item = asRecord(itemRaw);
    const itemId = optionalString(item?.id) ?? optionalString(item?.productId);
    if (!itemId) {
      skippedMalformedPrice += 1;
      continue;
    }

    // hidden/disabled/archived flags (когда есть).
    if (isFlagTrue(item?.hidden) || isFlagTrue(item?.disabled) || isFlagTrue(item?.isDeleted) || isFlagTrue(item?.archived)) {
      skippedHidden += 1;
      continue;
    }

    const itemName = optionalString(item?.name) ?? optionalString(item?.title) ?? 'Без названия';
    const sku = optionalString(item?.sku) ?? optionalString(item?.code) ?? null;
    const categoryId =
      optionalString(item?.productCategoryId) ??
      optionalString(item?.groupId) ??
      optionalString(item?.parentGroup) ??
      null;
    const categoryName = categoryId ? (categoryMap.get(categoryId) ?? null) : null;

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
      const sizeCode =
        optionalString(sizeRaw?.sizeCode) ??
        optionalString(sizeRaw?.code) ??
        null;

      const prices = asArray(sizeRaw?.prices);
      if (prices.length === 0) {
        skippedZeroPrice += 1;
        continue;
      }

      // Берём первую валидную цену, принадлежащую организации (если список есть).
      // НЕ схлопываем несколько цен в max — каждый size = одна строка с первой подходящей ценой.
      let chosenPrice: number | null = null;
      let priceMatchedOrg = true;
      let malformed = false;
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
        const orgs = asArray(priceRecord?.organizations);
        if (orgs.length > 0) {
          const belongs = orgs.some(
            (org) => optionalString(asRecord(org)?.id) === options.organizationId,
          );
          if (!belongs) {
            priceMatchedOrg = false;
            continue;
          }
        }
        chosenPrice = candidate;
        break;
      }

      if (chosenPrice === null) {
        if (malformed) {
          skippedMalformedPrice += 1;
        } else {
          skippedZeroPrice += 1;
        }
        if (!priceMatchedOrg) {
          warnings.push(
            `item ${itemId} size ${sizeId}: цена не принадлежит организации ${options.organizationId}`,
          );
        }
        continue;
      }

      const displayName = buildDisplayName(itemName, sizeName);
      const variantWarnings: string[] = [];
      if (!priceMatchedOrg) {
        variantWarnings.push('price_organization_mismatch_preserved');
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
        basePrice: chosenPrice,
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
    categoryCount: categoryMap.size,
    sourceItemCount: items.length,
    variants,
    skippedNoSizes,
    skippedHidden,
    skippedZeroPrice,
    skippedMalformedPrice,
    warnings,
  };
}

function buildDisplayName(name: string, sizeName: string | null): string {
  if (sizeName && sizeName.length > 0) {
    return `${name} · ${sizeName}`;
  }
  return name;
}

/** Извлекает числовую цену из price-объекта. Возвращает null для мусора. */
function readPrice(priceRecord: Record<string, unknown> | undefined): number | null {
  if (!priceRecord) return null;
  const direct = priceRecord.price;
  const current = asRecord(priceRecord.price)?.currentPrice;
  const candidate = typeof direct === 'number' ? direct : typeof current === 'number' ? current : undefined;
  if (candidate === undefined) return null;
  if (Number.isNaN(candidate)) return null;
  if (!Number.isFinite(candidate)) return null;
  return candidate;
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
