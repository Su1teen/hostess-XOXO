import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const seedSource = readFileSync(new URL('../prisma/seed.ts', import.meta.url), 'utf8');

const expectedNames = [
  'Немецкое',
  'Джин Beefeater',
  'Jägermeister',
  'Oakheart',
  'Bacardi Black',
  'Ballantines',
  'Jameson',
  'Chivas',
  'Jack Daniels',
  'Monkey Shoulder',
  'Absolut',
  'Nemiroff',
  'Хортица Айс',
  'Кызылжар',
  'Миллер',
  'Bud',
  'Corona Extra',
  'Paulaner',
  'Tsingtao',
  'Hoegaarden',
  'Red Bull Vodka',
  'Red Bull Jäger',
  'Gin Tonic',
  'Red Bull Whiskey',
  'Mojito',
  'Long Island',
  'Whiskey Sour',
];

describe('exchange seed contract', () => {
  it('содержит ровно 27 заданных позиций и не импортирует iiko menu', () => {
    expect(expectedNames).toHaveLength(27);
    expect(expectedNames.every((name) => seedSource.includes(`['${name}'`))).toBe(true);
    expect(seedSource).not.toContain('drinks_output.json');
    expect(seedSource).toContain('exchangeKey: product.key');
  });
});
